// `viskel ds`: what extraction makes of real shadcn source (test/fixtures/repo holds copies of
// this repo's button.tsx and card.tsx), and what `ds push` puts on the wire.

import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    mkdir,
    mkdtemp,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    classToken,
    extractAll,
    kebabTag,
    matchFiles,
    themeColours,
    titleCase,
} from '../lib/ds-extract.ts';
import { globalFor, tailwindCss } from '../lib/ds-build.ts';
import { FIXTURE_REPO, harness, noServer } from './support.ts';

const stub = harness();

before(() => stub.start());
after(() => stub.stop());
beforeEach(() => stub.reset());

const env = () => ({ VISKEL_URL: stub.url, VISKEL_TOKEN: 'pat-123' });

const extractFixture = async () =>
    extractAll({
        repoRoot: FIXTURE_REPO,
        files: await matchFiles(FIXTURE_REPO, ['resources/js/components/ui']),
        commit: 'abc1234',
    });

const familyOf = (families: any[], name: string) =>
    families.find((f) => f.family === name);

const componentOf = (family: any, name: string) =>
    family.components.find((c) => c.export === name);

const propOf = (component: any, name: string) =>
    component.props.find((p) => p.name === name);

void test('a prop with no default and no ? is recorded as required', async () => {
    const { families } = await extractFixture();
    const StatGrid = componentOf(familyOf(families, 'card'), 'StatGrid');

    assert.equal(propOf(StatGrid, 'label').required, true);
    assert.equal(propOf(StatGrid, 'caption').required, undefined);
    assert.equal(
        propOf(componentOf(familyOf(families, 'button'), 'Button'), 'variant')
            .required,
        undefined,
    );
});

void test('kebab tags follow the documented mapping', () => {
    assert.equal(kebabTag('Card'), 'ui-card');
    assert.equal(kebabTag('CardTitle'), 'ui-card-title');
    assert.equal(kebabTag('StatGrid'), 'ui-stat-grid');
    assert.equal(kebabTag('IconXS'), 'ui-icon-xs');
    assert.equal(titleCase('dropdown-menu'), 'Dropdown Menu');
});

void test("Button's props come from the cva config and its destructuring", async () => {
    const { families, skipped, collisions } = await extractFixture();
    assert.deepEqual(collisions, []);
    assert.deepEqual(skipped, []);

    const button = familyOf(families, 'button');
    assert.equal(button.title, 'Button');
    assert.deepEqual(button.source, {
        file: 'resources/js/components/ui/button.tsx',
        commit: 'abc1234',
    });

    const Button = componentOf(button, 'Button');
    assert.equal(Button.id, '@/components/ui/button#Button');
    assert.equal(Button.tag, 'ui-button');
    assert.equal(Button.root, true);

    assert.deepEqual(propOf(Button, 'variant'), {
        name: 'variant',
        type: 'enum',
        values: [
            'default',
            'outline',
            'ghost',
            'secondary',
            'destructive',
            'link',
        ],
        default: 'default',
    });
    assert.deepEqual(propOf(Button, 'size').values, [
        'default',
        'xs',
        'sm',
        'lg',
        'icon',
        'icon-xs',
        'icon-sm',
        'icon-lg',
    ]);
    assert.equal(propOf(Button, 'size').default, 'default');
    assert.deepEqual(propOf(Button, 'asChild'), {
        name: 'asChild',
        type: 'boolean',
        default: false,
    });
    assert.deepEqual(propOf(Button, 'className'), {
        name: 'className',
        type: 'string',
        hidden: true,
    });
    // DOM attributes stay out: own props only.
    assert.equal(propOf(Button, 'onClick'), undefined);
    assert.equal(propOf(Button, 'disabled'), undefined);

    // Non-rendering exports are helpers of the family, not components.
    assert.deepEqual(button.helpers, ['buttonVariants']);
    assert.equal(componentOf(button, 'buttonVariants'), undefined);

    assert.ok(button.tokens.includes('color.primary'));
    assert.ok(button.tokens.includes('radius.full'));
    assert.ok(button.tokens.includes('text.sm'));
});

void test('a compound family keeps one component per export', async () => {
    const { families } = await extractFixture();
    const card = familyOf(families, 'card');
    assert.deepEqual(card.components.map((c: any) => c.tag).sort(), [
        'ui-card',
        'ui-card-content',
        'ui-card-description',
        'ui-card-footer',
        'ui-card-header',
        'ui-card-label',
        'ui-card-title',
        'ui-card-value',
        'ui-stat-grid',
    ]);
    assert.equal(componentOf(card, 'Card').root, true);
    assert.equal(componentOf(card, 'CardTitle').root, undefined);
    assert.equal(
        componentOf(card, 'CardTitle').id,
        '@/components/ui/card#CardTitle',
    );
    assert.deepEqual(propOf(componentOf(card, 'Card'), 'variant').values, [
        'plain',
        'stat',
        'sheet',
    ]);
    assert.equal(propOf(componentOf(card, 'Card'), 'variant').default, 'plain');
    assert.deepEqual(card.helpers, ['cardVariants']);
    assert.ok(card.tokens.includes('color.card-foreground'));
});

void test('a named props type keeps the cva order and its defaults', async () => {
    const { families } = await extractFixture();
    const Toggle = componentOf(familyOf(families, 'toggle'), 'Toggle');

    assert.deepEqual(propOf(Toggle, 'variant'), {
        name: 'variant',
        type: 'enum',
        values: ['solid', 'quiet'],
        default: 'solid',
    });
    assert.deepEqual(propOf(Toggle, 'size'), {
        name: 'size',
        type: 'enum',
        values: ['sm', 'md'],
        default: 'md',
    });
});

void test('cva axes go to the component using that cva, not to one whose cva name starts the same', async () => {
    const { families } = await extractFixture();
    const ToggleLabel = componentOf(
        familyOf(families, 'toggle'),
        'ToggleLabel',
    );

    assert.deepEqual(propOf(ToggleLabel, 'tone').values, ['muted', 'strong']);
    assert.equal(propOf(ToggleLabel, 'variant'), undefined);
    assert.equal(propOf(ToggleLabel, 'size'), undefined);
});

const relative = (files: string[]) =>
    files.map((f) => path.relative(FIXTURE_REPO, f).split(path.sep).join('/'));

void test('a glob keeps the segments that follow its first wildcard', async () => {
    assert.deepEqual(
        relative(await matchFiles(FIXTURE_REPO, ['resources/**/ui/*.tsx'])),
        [
            'resources/js/components/ui/button.tsx',
            'resources/js/components/ui/card.tsx',
            'resources/js/components/ui/toggle.tsx',
        ],
    );
});

void test('a pattern that names one file matches that file', async () => {
    assert.deepEqual(
        relative(
            await matchFiles(FIXTURE_REPO, [
                'resources/js/components/ui/card.tsx',
            ]),
        ),
        ['resources/js/components/ui/card.tsx'],
    );
});

void test('ds init writes viskel.json from components.json and refuses to overwrite', async () => {
    const repo = await stub.repo();
    try {
        const { stdout } = await stub.cli(
            ['ds', 'init', '--system', 'viskel-base'],
            noServer,
            repo,
        );
        assert.match(stdout, /viskel ds push/);
        assert.deepEqual(
            JSON.parse(await readFile(path.join(repo, 'viskel.json'), 'utf8')),
            {
                system: 'viskel-base',
                components: ['resources/js/components/ui'],
                css: ['resources/css/app.css'],
            },
        );

        assert.match(
            await stub.fails(['ds', 'init'], noServer, repo),
            /viskel\.json already exists here \(use --force to overwrite\)/,
        );

        await stub.cli(
            ['ds', 'init', '--system', 'other', '--force'],
            noServer,
            repo,
        );
        assert.equal(
            JSON.parse(await readFile(path.join(repo, 'viskel.json'), 'utf8'))
                .system,
            'other',
        );
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

void test('ds push uploads the records, the bundle and the CSS', async () => {
    const repo = await stub.repo();
    try {
        await stub.cli(
            ['ds', 'init', '--system', 'viskel-base'],
            noServer,
            repo,
        );
        stub.replies['POST /api/ds/viskel-base/push'] = {
            status: 200,
            body: {
                global: 'ViskelBase',
                families: { added: 2, changed: 0, removed: 1 },
                bundle: { files: 2, bytes: 4096 },
                tokens: [
                    {
                        file: 'app.css',
                        read: 18,
                        counts: {
                            mapped: 12,
                            custom: 0,
                            conflict: 0,
                            derived: 3,
                            unmapped: 3,
                        },
                        rows: [],
                    },
                ],
            },
        };

        const { stdout } = await stub.cli(
            ['ds', 'push', '--commit', 'abc1234'],
            env(),
            repo,
        );
        assert.match(
            stdout,
            /Pushed 3 families to viskel-base as ViskelBase\./,
        );
        assert.match(stdout, /families: 2 added, 0 changed, 1 removed/);
        assert.match(stdout, /bundle: 2 files, 4 KB/);
        assert.match(
            stdout,
            /tokens: app\.css: 18 read, 12 mapped, 3 derived, 3 unmapped/,
        );

        const req = stub.received.at(-1);
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/api/ds/viskel-base/push');
        assert.equal(req.auth, 'Bearer pat-123');
        assert.match(req.type, /^multipart\/form-data; boundary=/);
        assert.deepEqual(req.fields.global, ['ViskelBase']);
        assert.deepEqual(req.fields.commit, ['abc1234']);
        assert.deepEqual(req.fields['include[]'], [
            'resources/js/components/ui',
        ]);
        assert.equal(req.fields['cssNames[]'], undefined);

        const sent = JSON.parse(req.fields.components[0]);
        assert.equal(sent.v, 1);
        const families = sent.families;
        assert.deepEqual(
            families.map((f: any) => f.family),
            ['button', 'card', 'toggle'],
        );
        assert.equal(
            componentOf(familyOf(families, 'button'), 'Button').tag,
            'ui-button',
        );

        // The token CSS rides in as another upload part, under its basename.
        assert.deepEqual(req.files.map((f) => f.path).sort(), [
            '_ds_bundle.js',
            'app.css',
            'styles.css',
        ]);
        assert.match(
            req.files.find((f) => f.path === 'app.css').text,
            /--primary: oklch/,
        );
        const bundle = req.files.find((f) => f.path === '_ds_bundle.js').text;
        assert.match(bundle, /^\/\* @ds-bundle: \{"namespace":"ViskelBase"/);
        assert.match(bundle, /window\.ViskelBase = __dsBundle;/);
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

void test('ds push extracts a component from a .jsx file too', async () => {
    const repo = await stub.repo();
    try {
        await stub.cli(
            ['ds', 'init', '--system', 'viskel-base'],
            noServer,
            repo,
        );
        await writeFile(
            path.join(repo, 'resources/js/components/ui/badge.jsx'),
            'export function Badge({ children }) {\n' +
                '    return <span className="badge">{children}</span>;\n' +
                '}\n',
        );

        stub.replies['POST /api/ds/viskel-base/push'] = {
            status: 200,
            body: { global: 'ViskelBase', families: { added: 3 } },
        };

        await stub.cli(['ds', 'push'], env(), repo);

        const families = JSON.parse(
            stub.received.at(-1).fields.components[0],
        ).families;
        assert.ok(
            families.some((f: any) => f.family === 'badge'),
            `badge.jsx was not extracted: ${families
                .map((f: any) => f.family)
                .join(', ')}`,
        );
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

void test('ds push merges --include into viskel.json', async () => {
    const repo = await stub.repo();
    try {
        await stub.cli(
            ['ds', 'init', '--system', 'viskel-base'],
            noServer,
            repo,
        );
        stub.replies['POST /api/ds/viskel-base/push'] = {
            status: 200,
            body: { global: 'ViskelBase', families: {} },
        };

        await stub.cli(
            ['ds', 'push', '--include', 'resources/js/components/ui/card.tsx'],
            env(),
            repo,
        );
        assert.deepEqual(
            JSON.parse(await readFile(path.join(repo, 'viskel.json'), 'utf8'))
                .components,
            [
                'resources/js/components/ui',
                'resources/js/components/ui/card.tsx',
            ],
        );
        assert.deepEqual(stub.received.at(-1).fields['include[]'], [
            'resources/js/components/ui',
            'resources/js/components/ui/card.tsx',
        ]);
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

void test('ds push refuses a tag collision and uploads nothing', async () => {
    const repo = await stub.repo();
    try {
        await stub.cli(
            ['ds', 'init', '--system', 'viskel-base'],
            noServer,
            repo,
        );
        await writeFile(
            path.join(repo, 'resources/js/components/ui/card-title.tsx'),
            'export function CardTitle() {\n    return <div />;\n}\n',
        );
        const stderr = await stub.fails(['ds', 'push'], env(), repo);
        assert.match(stderr, /Two components want the same board tag/);
        assert.match(stderr, /ui-card-title/);
        assert.equal(stub.received.length, 0);
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

void test('ds push refuses a css file the server would not read', async () => {
    const repo = await stub.repo();
    try {
        await stub.cli(
            ['ds', 'init', '--system', 'viskel-base'],
            noServer,
            repo,
        );
        await writeFile(
            path.join(repo, 'resources/css/theme.css'),
            ':root {\n    --brand: red;\n}\n',
        );
        const before = await readFile(path.join(repo, 'viskel.json'), 'utf8');
        const stderr = await stub.fails(
            ['ds', 'push', '--css', 'resources/css/theme.css'],
            env(),
            repo,
        );
        assert.match(
            stderr,
            /theme\.css cannot be pushed: the server reads tokens from app\.css or globals\.css/,
        );
        assert.equal(stub.received.length, 0);

        // Nothing is written back, so a later bare `ds push` does not repeat the refusal.
        assert.equal(
            await readFile(path.join(repo, 'viskel.json'), 'utf8'),
            before,
        );
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

void test('ds pull says the two-way sync is not here yet', async () => {
    assert.match(
        await stub.fails(['ds', 'pull'], noServer),
        /viskel ds pull is not available yet: Viskel-to-repo sync ships with the two-way component sync/,
    );
});

void test('an unknown ds subcommand prints the ds usage', async () => {
    const stderr = await stub.fails(['ds', 'nope'], noServer);
    assert.match(stderr, /no ds subcommand "nope"/);
    assert.match(stderr, /Usage: viskel ds <init\|push\|pull>/);
});

void test('ds init reads an exact alias from a tsconfig with comments and an extends', async () => {
    const repo = await stub.repo();
    try {
        await rename(
            path.join(repo, 'resources/js'),
            path.join(repo, 'ui-src'),
        );
        await writeFile(
            path.join(repo, 'tsconfig.base.json'),
            JSON.stringify(
                { compilerOptions: { paths: { '~': ['./ui-src'] } } },
                null,
                4,
            ),
        );
        await writeFile(
            path.join(repo, 'tsconfig.json'),
            '{\n    // The components live outside resources/js here.\n' +
                '    "extends": "./tsconfig.base.json"\n}\n',
        );
        const shadcn = JSON.parse(
            await readFile(path.join(repo, 'components.json'), 'utf8'),
        );
        shadcn.aliases.ui = '~/components/ui';
        await writeFile(
            path.join(repo, 'components.json'),
            JSON.stringify(shadcn, null, 4),
        );

        await stub.cli(
            ['ds', 'init', '--system', 'viskel-base'],
            noServer,
            repo,
        );
        assert.deepEqual(
            JSON.parse(await readFile(path.join(repo, 'viskel.json'), 'utf8'))
                .components,
            ['ui-src/components/ui'],
        );
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

void test('ds push says a malformed viskel.json is malformed, not missing', async () => {
    const repo = await stub.repo();
    try {
        await writeFile(path.join(repo, 'viskel.json'), '{ "system": ');
        const stderr = await stub.fails(['ds', 'push'], env(), repo);
        assert.match(stderr, /viskel\.json is not valid JSON/);
        assert.doesNotMatch(stderr, /run viskel ds init/);
        assert.equal(stub.received.length, 0);
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

void test('ds push says which viskel.json field is wrong', async () => {
    const repo = await stub.repo();
    try {
        await writeFile(
            path.join(repo, 'viskel.json'),
            JSON.stringify({ system: 'viskel-base', components: ['ui', 7] }),
        );
        const stderr = await stub.fails(['ds', 'push'], env(), repo);
        assert.match(stderr, /"components" must be a list of strings/);
        assert.equal(stub.received.length, 0);
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

void test('ds push refuses a bad --global before it extracts anything', async () => {
    const repo = await stub.repo();
    try {
        await stub.cli(
            ['ds', 'init', '--system', 'viskel-base'],
            noServer,
            repo,
        );
        const stderr = await stub.fails(
            ['ds', 'push', '--global', 'portal ui'],
            env(),
            repo,
        );
        assert.match(stderr, /Bad global name "portal ui": use PascalCase/);
        assert.equal(stub.received.length, 0);
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

void test('a system key that starts with a digit still makes a usable global', () => {
    assert.equal(globalFor('2024-brand'), 'Ds2024Brand');
    assert.equal(globalFor('2024-ds'), 'Ds2024Ds');
    assert.equal(globalFor('viskel-base'), 'ViskelBase');
    assert.equal(globalFor('---'), 'DesignSystem');
});

void test('ds push --system does not write its includes into the saved system', async () => {
    const repo = await stub.repo();
    try {
        await stub.cli(
            ['ds', 'init', '--system', 'viskel-base'],
            noServer,
            repo,
        );
        const before = await readFile(path.join(repo, 'viskel.json'), 'utf8');
        stub.replies['POST /api/ds/other/push'] = {
            status: 200,
            body: { global: 'Other', families: {} },
        };

        await stub.cli(
            [
                'ds',
                'push',
                '--system',
                'other',
                '--include',
                'resources/js/components/ui/card.tsx',
            ],
            env(),
            repo,
        );

        assert.equal(stub.received.at(-1).url, '/api/ds/other/push');
        assert.equal(
            await readFile(path.join(repo, 'viskel.json'), 'utf8'),
            before,
        );
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

void test('ds push without viskel.json says to run ds init', async () => {
    assert.match(
        await stub.fails(['ds', 'push'], env()),
        /No viskel\.json here: run viskel ds init in your repo first/,
    );
    assert.equal(stub.received.length, 0);
});

void test("a component that spreads an element's props is marked native", async () => {
    const { families } = await extractFixture();

    assert.equal(
        componentOf(familyOf(families, 'button'), 'Button').native,
        true,
    );
});

void test('props a component takes from a component library are its props; DOM ones are not listed', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'viskel-lib-'));
    try {
        await mkdir(path.join(repo, 'node_modules', 'fake-dialog'), {
            recursive: true,
        });
        await writeFile(
            path.join(repo, 'node_modules', 'fake-dialog', 'index.d.ts'),
            'export type RootProps = { open?: boolean; defaultOpen?: boolean; modal?: boolean };\n',
        );
        await writeFile(
            path.join(repo, 'node_modules', 'fake-dialog', 'package.json'),
            '{"name":"fake-dialog","types":"index.d.ts"}',
        );
        await writeFile(
            path.join(repo, 'tsconfig.json'),
            '{"compilerOptions":{"jsx":"react-jsx","strict":true,"moduleResolution":"bundler"}}',
        );
        await mkdir(path.join(repo, 'ui'));
        await writeFile(
            path.join(repo, 'ui', 'dialog.tsx'),
            "import type { RootProps } from 'fake-dialog';\n" +
                'export function Dialog(props: RootProps & { title?: string }) {\n' +
                '    return <div>{props.title}</div>;\n}\n',
        );
        const { families } = extractAll({
            repoRoot: repo,
            files: await matchFiles(repo, ['ui']),
            commit: 'abc1234',
        });
        const dialog = componentOf(familyOf(families, 'dialog'), 'Dialog');

        assert.deepEqual(dialog.props.map((p) => p.name).sort(), [
            'defaultOpen',
            'modal',
            'open',
            'title',
        ]);
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

void test('the Tailwind entry is compiled against the pushed files only, in a layer of its own', async () => {
    const css = path.join(FIXTURE_REPO, 'resources', 'css', 'tw-check.css');
    await writeFile(css, '@import "tailwindcss";\n');
    try {
        const out = await tailwindCss({
            repoRoot: FIXTURE_REPO,
            css: ['resources/css/tw-check.css'],
            files: ['resources/js/components/ui/button.tsx'],
        });

        assert.ok(out?.startsWith('@layer viskel-bundle {'));
        assert.match(out, /\.inline-flex\s*\{/);
        assert.doesNotMatch(out, /\.flex-col\s*\{/);
    } finally {
        await rm(css, { force: true });
    }
});

void test('a repo without Tailwind gets no compiled CSS', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'viskel-plain-'));
    try {
        await writeFile(path.join(repo, 'app.css'), 'body { margin: 0 }\n');
        assert.equal(
            await tailwindCss({
                repoRoot: repo,
                css: ['app.css'],
                files: ['x.tsx'],
            }),
            null,
        );
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

void test('a ui tag is named from its export the way the server names it', async () => {
    const vectors = JSON.parse(
        await readFile(
            path.join(
                import.meta.dirname,
                'fixtures/ui-tag-names.json',
            ),
            'utf8',
        ),
    );
    for (const [exportName, tag] of Object.entries(vectors))
        assert.equal(kebabTag(exportName), tag);
});

void test('ds init picks no stylesheet the push would refuse', async () => {
    const repo = await stub.repo();
    try {
        await rm(path.join(repo, 'resources/css/app.css'));
        await mkdir(path.join(repo, 'src'), { recursive: true });
        await writeFile(path.join(repo, 'src/index.css'), ':root {}');
        await stub.cli(['ds', 'init'], noServer, repo);
        assert.deepEqual(
            JSON.parse(await readFile(path.join(repo, 'viskel.json'), 'utf8'))
                .css,
            [],
        );
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

void test('a class is a colour token only when the theme or the roles name it', () => {
    const colours = themeColours([
        '@theme { --color-brand: red; } :root { --surface: white; }',
    ]);
    assert.equal(classToken('bg-brand', colours), 'color.brand');
    assert.equal(classToken('hover:bg-surface/50', colours), 'color.surface');
    assert.equal(classToken('text-primary', colours), 'color.primary');
    for (const notColour of [
        'ring-2',
        'divide-y',
        'bg-gradient-to-r',
        'to-do',
        'bg-blue-500',
    ])
        assert.equal(classToken(notColour, colours), null, notColour);
});
