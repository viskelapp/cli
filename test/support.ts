// A stub server that records what the CLI sent, so the tests say what the CLI puts on the wire
// and what it prints. The server side is tested in the server's MCP feature tests (`tests/Feature/Mcp`).

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const CLI = path.join(import.meta.dirname, '..', 'bin', 'viskel.ts');

export const FIXTURE_REPO = path.join(import.meta.dirname, 'fixtures', 'repo');

export type Received = {
    method: string;
    url: string;
    auth: string | undefined;
    ua: string | undefined;
    type: string;
    fields: Record<string, string[]>;
    files: { name: string; path: string; text: string }[];
};

export type Reply = { status: number; body: any };

const read = (req: http.IncomingMessage) =>
    new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });

export function harness() {
    let server: http.Server;
    const self = {
        url: '',
        home: '',
        received: [] as Received[],
        // What the stub answers next, per "<METHOD> <path>".
        replies: {} as Record<string, Reply>,

        async start() {
            self.home = await mkdtemp(
                path.join(os.tmpdir(), 'viskel-cli-home-'),
            );
            server = http.createServer(async (req, res) => {
                const type = req.headers['content-type'] || '';
                const body = await read(req);
                const got: Received = {
                    method: req.method,
                    url: req.url,
                    auth: req.headers.authorization,
                    ua: req.headers['user-agent'],
                    type,
                    fields: {},
                    files: [],
                };
                if (type.startsWith('multipart/form-data')) {
                    const form = await new Request('http://upload.invalid/', {
                        method: 'POST',
                        headers: { 'content-type': type },
                        body: new Uint8Array(body),
                    }).formData();
                    const paths = form.getAll('paths[]').map(String);
                    for (const [k, v] of form)
                        if (typeof v === 'string')
                            (got.fields[k] ||= []).push(v);
                    const parts = form.getAll('files[]') as File[];
                    got.files = await Promise.all(
                        parts.map(async (f, i) => ({
                            name: f.name,
                            path: paths[i],
                            text: await f.text(),
                        })),
                    );
                } else if (body.length) {
                    got.fields = JSON.parse(body.toString());
                }
                self.received.push(got);
                const reply = self.replies[
                    `${req.method} ${req.url.split('?')[0]}`
                ] || {
                    status: 404,
                    body: { error: `no stub for ${req.method} ${req.url}` },
                };
                res.writeHead(reply.status, {
                    'Content-Type': 'application/json',
                });
                res.end(JSON.stringify(reply.body));
            });
            await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
            self.url = `http://127.0.0.1:${(server.address() as any).port}`;
        },

        async stop() {
            await new Promise((r) => server.close(r));
            await rm(self.home, { recursive: true, force: true });
        },

        async reset() {
            self.received = [];
            self.replies = {
                'GET /api/me': {
                    status: 200,
                    body: {
                        user: {
                            id: 1,
                            name: 'Ralf',
                            email: 'ralf@example.com',
                        },
                        spaces: [],
                    },
                },
            };
            await rm(path.join(self.home, '.config'), {
                recursive: true,
                force: true,
            });
        },

        // The CLI with its own HOME, so `login` writes into the temp config and nothing leaks in.
        cli(args: string[], env: Record<string, string> = {}, cwd = self.home) {
            return execFileAsync(process.execPath, [CLI, ...args], {
                cwd,
                env: {
                    PATH: process.env.PATH,
                    HOME: self.home,
                    USERPROFILE: self.home,
                    ...env,
                },
            });
        },

        async fails(
            args: string[],
            env: Record<string, string> = {},
            cwd = self.home,
        ) {
            const err = await self.cli(args, env, cwd).then(
                () => null,
                (e) => e,
            );
            assert.ok(err, `expected viskel ${args.join(' ')} to fail`);
            assert.equal(err.code, 1);
            return err.stderr as string;
        },

        // The fixture repo copied somewhere writable, so a push may save back into viskel.json.
        async repo() {
            const dir = await mkdtemp(path.join(os.tmpdir(), 'viskel-repo-'));
            await cp(FIXTURE_REPO, dir, { recursive: true });
            // The fixture's React types come from the CLI's own node_modules, as a real repo's
            // would come from its own; without them the props types resolve to `any`.
            await symlink(
                path.join(import.meta.dirname, '..', 'node_modules'),
                path.join(dir, 'node_modules'),
                'dir',
            );
            return dir;
        },
    };
    return self;
}

// No saved login and no env: the CLI must ask for one.
export const noServer = { VISKEL_URL: '', VISKEL_TOKEN: '' };
