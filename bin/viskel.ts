#!/usr/bin/env node
// viskel CLI: talks to a Viskel server from your machine.
//
//   viskel login <server-url> <token>       check the token and remember the server
//   viskel designs                          list designs
//   viskel import <exportDir> --name <name> [--space <org/space>]  import a claude.ai Design export
//   viskel ds init [--system <key>] [--include <glob>] [--css <path>] [--force]
//   viskel ds push [--system <key>] [--include <glob>] [--css <path>] [--commit <sha>]
//   viskel ds pull
//
// Server and token come from VISKEL_URL / VISKEL_TOKEN, else from `login`
// (~/.config/viskel/cli.json). Without either, every command but login and ds init says to
// log in first.

import { execFile } from 'node:child_process';
import { openAsBlob } from 'node:fs';
import {
    mkdtemp,
    mkdir,
    readFile,
    readdir,
    realpath,
    rm,
    writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import {
    bundleDesignSystem,
    tailwindCss,
    checkGlobal,
    entrySource,
    exists,
    globalFor,
    nodeModulesUp,
} from '../lib/ds-build.ts';
import {
    CONFIG_FILE,
    configPath,
    defaultConfig,
    isTokenCss,
    readConfig,
    writeConfig,
} from '../lib/ds-config.ts';
import {
    extractAll,
    themeColours,
    loadCompilerOptions,
    matchFiles,
    UNRESOLVED,
} from '../lib/ds-extract.ts';

const CONFIG = path.join(os.homedir(), '.config', 'viskel', 'cli.json');
const MAX_MB = 60;

async function config() {
    let saved: any = {};
    try {
        saved = JSON.parse(await readFile(CONFIG, 'utf8'));
    } catch (err) {
        if (err.code !== 'ENOENT')
            throw new Error(`cannot read ${CONFIG}: ${err.message}`);
    }
    const server = process.env.VISKEL_URL || saved.server;
    if (!server)
        throw new Error('Not logged in: run viskel login <server-url> <token>');
    return {
        server: serverUrl(server),
        token: process.env.VISKEL_TOKEN || saved.token || null,
    };
}

// The server records writes from this CLI as client "cli" by this User-Agent (P5-04).
const USER_AGENT = `viskel-cli/${JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version}`;

// One place for every request: bearer token, reachability, and the server's error text.
async function send(
    method,
    route,
    { body = undefined as any, headers = {} } = {},
) {
    const { server, token } = await config();
    let res;
    try {
        res = await fetch(server + route, {
            method,
            headers: {
                'User-Agent': USER_AGENT,
                ...headers,
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            ...(body === undefined ? {} : { body }),
        });
    } catch (err) {
        throw new Error(
            `Cannot reach ${server} (${err.cause?.code || err.message}). Is the server running?`,
        );
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401)
        throw new Error(
            `Not logged in to ${server}: run viskel login ${server} <token>`,
        );
    if (res.status === 413)
        throw new Error(`Upload too large (limit ${MAX_MB} MB)`);
    if (!res.ok)
        throw new Error(data.error || `${method} ${route}: HTTP ${res.status}`);
    return data;
}

const api = (method, route, body?) =>
    send(method, route, {
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });

// Files go up as multipart/form-data: one files[] part per file, its design-relative path in
// paths[], everything else as a plain form field. Streamed from disk, never read into memory.
async function upload(
    method,
    route,
    fields: Record<string, string | string[] | boolean | null | undefined>,
    files,
) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
        if (v === undefined || v === null || v === true) continue;
        if (Array.isArray(v))
            for (const one of v) form.append(`${k}[]`, String(one));
        else form.append(k, String(v));
    }
    for (const f of files) {
        form.append('paths[]', f.path);
        form.append('files[]', await openAsBlob(f.file), path.basename(f.path));
    }
    return send(method, route, { body: form });
}

const OPTIONS = {
    name: { type: 'string' },
    space: { type: 'string' },
    system: { type: 'string' },
    global: { type: 'string' },
    commit: { type: 'string' },
    include: { type: 'string', multiple: true },
    css: { type: 'string', multiple: true },
    force: { type: 'boolean' },
} as const;

function parse(argv: string[]) {
    const { values, positionals } = parseArgs({
        args: argv,
        options: OPTIONS,
        strict: true,
        allowPositionals: true,
    });
    return { _: positionals, ...values };
}

function serverUrl(raw: string): string {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`${raw} is not a server URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new Error(`${raw} is not an http(s) URL`);
    return url.href.replace(/\/+$/, '');
}

const flag = (v) => (v === true || v === undefined ? undefined : String(v));

const list = (v) =>
    v === true || v === undefined
        ? undefined
        : (Array.isArray(v) ? v : [v]).map(String);

const execFileAsync = promisify(execFile);

async function headCommit(repoRoot) {
    try {
        const { stdout } = await execFileAsync(
            'git',
            ['rev-parse', '--short', 'HEAD'],
            { cwd: repoRoot },
        );
        return stdout.trim() || undefined;
    } catch (err) {
        console.warn(
            `viskel: no commit recorded (${err.message.split('\n')[0]})`,
        );
        return undefined;
    }
}

// Every file under dir, as { path (relative, with / separators), file (absolute) }.
async function filesOf(dir, sub = '') {
    const out = [];
    for (const e of await readdir(path.join(dir, sub), {
        withFileTypes: true,
    })) {
        if (e.name.startsWith('.')) continue;
        const rel = sub ? `${sub}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...(await filesOf(dir, rel)));
        else out.push({ path: rel, file: path.join(dir, rel) });
    }
    return out;
}

const commands = {
    async login(a) {
        const [server, token] = a._;
        if (!server || !token)
            throw new Error('Usage: viskel login <server-url> <token>');
        const url = serverUrl(server);
        let res;
        try {
            res = await fetch(`${url}/api/me`, {
                headers: {
                    'User-Agent': USER_AGENT,
                    Authorization: `Bearer ${token}`,
                },
            });
        } catch (err) {
            throw new Error(
                `Cannot reach ${url} (${err.cause?.code || err.message}). Is the server running?`,
            );
        }
        if (res.status === 401)
            throw new Error('That token is not valid on this server');
        if (!res.ok)
            throw new Error(
                `${url} does not look like a Viskel server (HTTP ${res.status})`,
            );
        const me = await res.json().catch(() => ({}));
        await mkdir(path.dirname(CONFIG), { recursive: true });
        await writeFile(
            CONFIG,
            JSON.stringify({ server: url, token }, null, 2),
            { mode: 0o600 },
        );
        // Laravel: { user: { name, email }, spaces }; the Node server: { user: '<name>' }.
        const user =
            typeof me.user === 'object' && me.user
                ? me.user
                : { name: me.user };
        const name = user.name || 'you';
        console.log(
            `Logged in to ${url} as ${name}${user.email ? ` (${user.email})` : ''}.`,
        );
    },

    async designs() {
        for (const p of (await api('GET', '/api/designs')).designs)
            console.log(
                [p.key, p.title, p.spaceRef || p.space || ''].join('\t'),
            );
    },

    async import(a) {
        const [dir] = a._;
        if (!dir || a.name === true || !a.name)
            throw new Error(
                'Usage: viskel import <exportDir> --name <design name> [--space <org/space>]',
            );
        if (!(await exists(path.join(dir, 'canvas.json'))))
            throw new Error(
                `${dir} has no canvas.json; is it a claude.ai Design export?`,
            );
        const files = await filesOf(path.resolve(dir));
        const r = await upload(
            'POST',
            '/api/import',
            { name: a.name, space: a.space },
            files,
        );
        console.log(
            `Imported "${r.title}" as ${r.key}: ${r.boards} boards on ${r.pages} pages; validate: ${r.validate.errors} errors, ${r.validate.warnings} warnings.`,
        );
        for (const w of r.warnings || []) console.log(`  warning: ${w}`);
    },

    async ds(a) {
        const [sub, ...rest] = a._;
        if (!sub || !dsCommands[sub])
            throw new Error(
                `${sub ? `no ds subcommand "${sub}"` : 'viskel ds needs a subcommand'}\n\n${DS_USAGE}`,
            );
        await dsCommands[sub]({ ...a, _: rest });
    },
};

const dsCommands = {
    async init(a) {
        const repoRoot = process.cwd();
        if ((await exists(configPath(repoRoot))) && a.force !== true)
            throw new Error(
                `${CONFIG_FILE} already exists here (use --force to overwrite)`,
            );
        const defaults = await defaultConfig(repoRoot);
        const next = {
            system: flag(a.system) || path.basename(repoRoot),
            components: list(a.include) ?? defaults.components,
            css: list(a.css) ?? defaults.css,
        };
        if (!next.components.length)
            throw new Error(
                'Found no component folder: name one with --include <glob>',
            );
        await writeConfig(repoRoot, next);
        console.log(
            `Wrote ${CONFIG_FILE}: system "${next.system}", components ${next.components.join(', ')}, css ${next.css.join(', ') || 'none'}.`,
        );
        console.log('Next:\n  viskel ds push');
    },

    async push(a) {
        const repoRoot = process.cwd();
        const saved = await readConfig(repoRoot);
        if (!saved)
            throw new Error(
                `No ${CONFIG_FILE} here: run viskel ds init in your repo first`,
            );
        const system = flag(a.system) || saved.system;
        if (!system)
            throw new Error(
                `No design system: add "system" to ${CONFIG_FILE} or pass --system <key>`,
            );
        const merged = {
            system: saved.system || system,
            components: [
                ...new Set([...saved.components, ...(list(a.include) ?? [])]),
            ],
            css: [...new Set([...saved.css, ...(list(a.css) ?? [])])],
        };
        const css = tokenCss(merged.css);
        const global = flag(a.global) || globalFor(system);
        checkGlobal(global);

        const files = await matchFiles(repoRoot, merged.components);
        if (!files.length)
            throw new Error(
                `No component files under ${merged.components.join(', ')}`,
            );
        const commit = flag(a.commit) ?? (await headCommit(repoRoot));
        const { families, skipped, collisions } = extractAll({
            repoRoot,
            files,
            commit,
            colours: themeColours(
                await Promise.all(
                    css.map((file) =>
                        readFile(path.resolve(repoRoot, file), 'utf8'),
                    ),
                ),
            ),
        });
        if (collisions.length)
            throw new Error(
                `Two components want the same board tag:\n${collisions
                    .map((c) => `  ${c.tag}: ${c.ids.join(', ')}`)
                    .join('\n')}`,
            );

        const unresolved = skipped.filter((s) =>
            s.reason.startsWith(UNRESOLVED),
        );
        if (unresolved.length && a.force !== true)
            throw new Error(
                `${unresolved.length} components lost their props because their types did not resolve ` +
                    `(dependencies installed?):\n${unresolved
                        .map((s) => `  ${s.export} in ${s.file}`)
                        .join('\n')}\n` +
                    "Install the repo's dependencies and push again, or --force to push them without props.",
            );

        const outDir = await mkdtemp(path.join(os.tmpdir(), 'viskel-ds-'));
        const made = await mkdtemp(path.join(os.tmpdir(), 'viskel-entry-'));
        // esbuild resolves imports from real paths, so the entry's own must be real too.
        const entryDir = await realpath(made);
        try {
            const entry = path.join(entryDir, 'entry.tsx');
            await writeFile(
                entry,
                entrySource(
                    families.map((f) => ({
                        file: path.resolve(repoRoot, f.source.file),
                        exports: f.components.map((c) => c.export),
                    })),
                    entryDir,
                ),
            );
            const built = await bundleDesignSystem({
                entry,
                global,
                outDir,
                nodePaths: await nodeModulesUp(repoRoot),
                tsconfig: loadCompilerOptions(repoRoot).configPath,
                tailwind: await tailwindCss({ repoRoot, css, files }),
            });
            for (const w of built.warnings) console.log(`  warning: ${w}`);

            const r = await upload(
                'POST',
                `/api/ds/${encodeURIComponent(system)}/push`,
                {
                    global,
                    commit,
                    include: merged.components,
                    components: JSON.stringify({ v: 1, families }),
                },
                [
                    ...built.files.map((f) => ({
                        path: f,
                        file: path.join(outDir, f),
                    })),
                    ...css.map((name) => ({
                        path: path.basename(name),
                        file: path.join(repoRoot, name),
                    })),
                ],
            );
            // Only now: a refused push must leave viskel.json as it was, or every later
            // bare `ds push` repeats the same refusal from the file it wrote.
            if (
                (!saved.system || saved.system === system) &&
                JSON.stringify(merged) !== JSON.stringify(saved)
            )
                await writeConfig(repoRoot, merged);
            report(system, r, families, skipped);
        } finally {
            await rm(outDir, { recursive: true, force: true });
            await rm(made, { recursive: true, force: true });
        }
    },

    async pull() {
        throw new Error(
            'viskel ds pull is not available yet: Viskel-to-repo sync ships with the two-way component sync (spec/design-system-components.md).',
        );
    },
};

// The server picks the token stylesheets out of the uploaded files by name, so only those two
// names reach it, and only once each.
function tokenCss(paths) {
    const seen = new Map();
    for (const name of paths) {
        const base = path.basename(name);
        if (!isTokenCss(name))
            throw new Error(
                `${name} cannot be pushed: the server reads tokens from app.css or globals.css, by that name`,
            );
        if (seen.has(base))
            throw new Error(
                `Two css entries are both called ${base}: ${seen.get(base)} and ${name}`,
            );
        seen.set(base, name);
    }
    return paths;
}

function report(system, r, families, skipped) {
    const f = r.families || {};
    console.log(
        `Pushed ${families.length} families to ${system} as ${r.global}.`,
    );
    console.log(
        `  families: ${f.added ?? 0} added, ${f.changed ?? 0} changed, ${f.removed ?? 0} removed`,
    );
    if (r.bundle)
        console.log(
            `  bundle: ${r.bundle.files} files, ${Math.round((r.bundle.bytes || 0) / 1024)} KB`,
        );
    for (const t of r.tokens || []) {
        const counts = Object.entries(t.counts || {})
            .filter(([, n]) => n)
            .map(([outcome, n]) => `${String(n)} ${outcome}`);
        console.log(
            `  tokens: ${t.file}: ${t.read} read${counts.length ? `, ${counts.join(', ')}` : ''}`,
        );
    }
    for (const s of skipped)
        console.log(`  skipped: ${s.export} in ${s.file} (${s.reason})`);
}

const DS_USAGE = [
    'Usage: viskel ds <init|push|pull>',
    '',
    `  init [--system <key>] [--include <glob>] [--css <path>] [--force]`,
    `       write ${CONFIG_FILE} here (defaults from components.json)`,
    '  push [--system <key>] [--include <glob>] [--css <path>] [--commit <sha>]',
    '       [--global <Name>] [--force]',
    '       extract the components, bundle them and upload them with the CSS;',
    '       --global names the window global the bundle hangs on (default: from the',
    '       system key), --force pushes components whose props did not resolve',
    '  pull not available yet (two-way component sync)',
].join('\n');

const USAGE = [
    'Usage: viskel <command>',
    '',
    '  login <server-url> <token>                      check the token and remember the server',
    '  designs                                         list designs (key, title, org/space)',
    '  import <exportDir> --name <name>                import a claude.ai Design export',
    '         [--space <org/space>]',
    '  ds init | ds push | ds pull                     design system from this repo',
    '',
    DS_USAGE.split('\n').slice(2).join('\n'),
    '',
    'Server and token: VISKEL_URL / VISKEL_TOKEN, else what login saved.',
].join('\n');

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === '--help' || cmd === '-h' || cmd === 'help' || !cmd) {
    console.log(USAGE);
    process.exit(0);
}
if (!commands[cmd]) {
    console.error(`viskel: no command "${cmd}"\n\n${USAGE}`);
    process.exit(1);
}
try {
    await commands[cmd](parse(rest));
} catch (err) {
    console.error(`viskel: ${err.message}`);
    process.exit(1);
}
