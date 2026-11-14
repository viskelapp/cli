import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { harness, noServer } from './support.ts';

const stub = harness();
let url: string;
let home: string;
let received: ReturnType<typeof harness>['received'];
let replies: ReturnType<typeof harness>['replies'];

before(async () => {
    await stub.start();
    url = stub.url;
    home = stub.home;
});

after(() => stub.stop());

beforeEach(async () => {
    await stub.reset();
    received = stub.received;
    replies = stub.replies;
});

const cli = (...args: Parameters<typeof stub.cli>) => stub.cli(...args);
const fails = (...args: Parameters<typeof stub.fails>) => stub.fails(...args);

void test('login checks the token and saves the config with mode 0600', async () => {
    const { stdout } = await cli(['login', `${url}/`, 'pat-123']);
    assert.equal(
        stdout.trim(),
        `Logged in to ${url} as Ralf (ralf@example.com).`,
    );
    assert.deepEqual(
        received.map((r) => [r.method, r.url, r.auth]),
        [['GET', '/api/me', 'Bearer pat-123']],
    );
    // The server attributes CLI writes to client "cli" by this User-Agent.
    assert.match(received[0].ua ?? '', /^viskel-cli\/\d+\.\d+\.\d+$/);

    const file = path.join(home, '.config', 'viskel', 'cli.json');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
        server: url,
        token: 'pat-123',
    });
    assert.equal((await stat(file)).mode & 0o777, 0o600);

    // And the saved login is what the next command uses.
    replies['GET /api/designs'] = {
        status: 200,
        body: {
            designs: [
                {
                    key: 'shop',
                    title: 'Shop',
                    space: 'Design',
                    spaceSlug: 'design',
                    spaceRef: 'acme/design',
                },
            ],
        },
    };
    const list = await cli(['designs']);
    assert.equal(list.stdout, 'shop\tShop\tacme/design\n');
    assert.equal(received.at(-1).auth, 'Bearer pat-123');
});

void test('login with a bad token says so and saves nothing', async () => {
    replies['GET /api/me'] = {
        status: 401,
        body: { error: 'Unauthenticated' },
    };
    assert.match(
        await fails(['login', url, 'nope']),
        /viskel: That token is not valid on this server/,
    );
    await assert.rejects(
        stat(path.join(home, '.config', 'viskel', 'cli.json')),
    );
});

void test('login needs a token', async () => {
    assert.match(
        await fails(['login', url]),
        /Usage: viskel login <server-url> <token>/,
    );
});

void test('without a login or VISKEL_URL, commands say to log in', async () => {
    assert.match(
        await fails(['designs'], noServer),
        /viskel: Not logged in: run viskel login <server-url> <token>/,
    );
});

void test('--help lists the commands and exits 0', async () => {
    const { stdout } = await cli(['--help'], noServer);
    for (const c of [
        'login',
        'designs',
        'import',
        'ds init',
        'ds push',
        'ds pull',
    ])
        assert.ok(stdout.includes(c), `--help should mention ${c}`);
    assert.doesNotMatch(stdout, /init-ds|build-ds/);
    assert.match(stdout, /--space <org\/space>/);
});

void test('designs falls back to the space name from a server without refs', async () => {
    replies['GET /api/designs'] = {
        status: 200,
        body: { designs: [{ key: 'shop', title: 'Shop', space: 'design' }] },
    };
    const { stdout } = await cli(['designs'], {
        VISKEL_URL: url,
        VISKEL_TOKEN: 'pat-123',
    });
    assert.equal(stdout, 'shop\tShop\tdesign\n');
});

void test('import uploads the export as multipart and prints the summary', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'viskel-cli-export-'));
    try {
        await writeFile(path.join(dir, 'canvas.json'), '{"boards":[]}');
        await mkdir(path.join(dir, 'pages'), { recursive: true });
        await writeFile(path.join(dir, 'pages', 'one.html'), '<p>one</p>');
        await writeFile(path.join(dir, '.hidden'), 'skip me');
        replies['POST /api/import'] = {
            status: 200,
            body: {
                key: 'shop',
                title: 'Shop',
                boards: 2,
                pages: 1,
                warnings: ['a stray link'],
                validate: { ok: true, errors: 0, warnings: 1 },
            },
        };

        const { stdout } = await cli(
            ['import', dir, '--name', 'Shop', '--space', 'acme/design'],
            { VISKEL_URL: url, VISKEL_TOKEN: 'pat-123' },
        );
        assert.match(
            stdout,
            /Imported "Shop" as shop: 2 boards on 1 pages; validate: 0 errors, 1 warnings\./,
        );
        assert.match(stdout, /warning: a stray link/);

        const req = received.at(-1);
        assert.match(
            req.type,
            /^multipart\/form-data; boundary=/,
            'the CLI uploads multipart, not JSON',
        );
        assert.equal(req.auth, 'Bearer pat-123');
        assert.deepEqual(req.fields.name, ['Shop']);
        assert.deepEqual(req.fields.space, ['acme/design']);
        assert.deepEqual(req.files.map((f) => f.path).sort(), [
            'canvas.json',
            'pages/one.html',
        ]);
        assert.equal(
            req.files.find((f) => f.path === 'pages/one.html').text,
            '<p>one</p>',
        );
        assert.equal(
            req.files.find((f) => f.path === 'pages/one.html').name,
            'one.html',
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

void test('import checks the folder is an export', async () => {
    assert.match(
        await fails(['import', home, '--name', 'Shop'], {
            VISKEL_URL: url,
        }),
        /has no canvas\.json/,
    );
    assert.equal(received.length, 0);
});

void test('server errors and 413 come back as viskel: <error>', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'viskel-cli-export-'));
    try {
        await writeFile(path.join(dir, 'canvas.json'), '{}');
        const env = { VISKEL_URL: url, VISKEL_TOKEN: 'pat-123' };
        replies['POST /api/import'] = {
            status: 400,
            body: { error: 'A design "shop" already exists' },
        };
        assert.match(
            await fails(['import', dir, '--name', 'Shop'], env),
            /viskel: A design "shop" already exists/,
        );

        replies['POST /api/import'] = { status: 413, body: {} };
        assert.match(
            await fails(['import', dir, '--name', 'Shop'], env),
            /viskel: Upload too large \(limit 60 MB\)/,
        );

        replies['POST /api/import'] = { status: 401, body: {} };
        assert.match(
            await fails(['import', dir, '--name', 'Shop'], env),
            new RegExp(`Not logged in to ${url}: run viskel login`),
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

void test('an unknown flag or a flag without its value is refused', async () => {
    assert.match(
        await fails(['designs', '--nope']),
        /viskel: Unknown option '--nope'/,
    );
    assert.match(
        await fails(['import', 'dir', '--name']),
        /viskel: Option '--name <value>' argument missing/,
    );
});

void test('login refuses a server that is not an http(s) URL', async () => {
    assert.match(
        await fails(['login', 'ftp://x.test', 'pat-123']),
        /viskel: ftp:\/\/x\.test is not an http\(s\) URL/,
    );
    assert.match(
        await fails(['login', 'x.test', 'pat-123']),
        /viskel: x\.test is not a server URL/,
    );
});

void test('a saved login that is not JSON is reported, not read as logged out', async () => {
    await mkdir(path.join(home, '.config', 'viskel'), { recursive: true });
    await writeFile(path.join(home, '.config', 'viskel', 'cli.json'), '{nope');
    assert.match(await fails(['designs']), /viskel: cannot read .*cli\.json/);
});
