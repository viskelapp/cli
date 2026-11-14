import type { BuildOptions } from 'esbuild';
// Design systems built from a code repo's real React components.
//
// Built on the developer's machine, next to the code (viskel CLI: ds push):
//   entry generated in a temp dir, re-exporting every extracted component
//   bundle ->  _ds_bundle.js (IIFE, window.<Global>), _ds_bundle.css, styles.css, assets/
// then uploaded to POST /api/ds/{system}/push, which stores it as the design system's own
// bundle/ and freezes it into a snapshot on release.
//
// Same shape as a claude.ai Design export: React and ReactDOM are not bundled, they come from
// window.React / window.ReactDOM (the board runtime provides React 18), so boards render the
// components with <x-import component-from-global-scope="<Global>.Button">.

import * as esbuild from 'esbuild';
import {
    mkdir,
    readFile,
    readdir,
    realpath,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const exists = (p) =>
    stat(p).then(
        () => true,
        () => false,
    );

const GLOBAL = /^[A-Z][A-Za-z0-9_]*$/;
export const checkGlobal = (global) => {
    if (!GLOBAL.test(global || ''))
        throw new Error(
            `Bad global name "${global}": use PascalCase, e.g. PortalUI`,
        );
};

// esbuild resolves imports from real paths (e.g. macOS /var is really /private/var).
const real = (p) => realpath(p).catch(() => path.resolve(p));

export const globalFor = (system) => {
    const name = system
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join('');
    if (!name) return 'DesignSystem';
    return /^[A-Za-z]/.test(name) ? name : `Ds${name}`;
};

export function entrySource(
    modules: { file: string; exports: string[] }[],
    entryDir: string,
) {
    return (
        modules
            .filter((m) => m.exports.length)
            .map((m) => {
                let rel = path
                    .relative(entryDir, m.file)
                    .split(path.sep)
                    .join('/');
                if (!rel.startsWith('./') && !rel.startsWith('../'))
                    rel = `./${rel}`;
                return `export { ${m.exports.join(', ')} } from ${JSON.stringify(rel)};`;
            })
            .join('\n') + '\n'
    );
}

// React from the page instead of node_modules (same shim as claude.ai design-system bundles).
const SHIMS = {
    react: 'module.exports = window.React;',
    'react-dom': 'module.exports = window.ReactDOM;',
    'react-dom/client': 'module.exports = window.ReactDOM;',
    'react/jsx-runtime': `
    var R = window.React;
    function np(p, k) { var o = {}; for (var x in p) if (x !== 'children') o[x] = p[x]; if (k !== undefined) o.key = k; return o; }
    exports.jsx = function (t, p, k) { var c = p && p.children; return c === undefined ? R.createElement(t, np(p, k)) : R.createElement(t, np(p, k), c); };
    exports.jsxs = function (t, p, k) { return R.createElement.apply(R, [t, np(p, k)].concat(p.children)); };
    exports.jsxDEV = exports.jsx;
    exports.Fragment = R.Fragment;`,
};
SHIMS['react/jsx-dev-runtime'] = SHIMS['react/jsx-runtime'];

const reactShim = {
    name: 'react-shim',
    setup(build) {
        build.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => {
            if (args.path === 'react-dom/server')
                return {
                    errors: [
                        { text: 'react-dom/server cannot run in an artboard' },
                    ],
                };
            return { path: args.path, namespace: 'react-shim' };
        });
        build.onLoad({ filter: /.*/, namespace: 'react-shim' }, (args) => ({
            contents: SHIMS[args.path] || 'module.exports = window.React;',
            loader: 'js',
        }));
    },
};

// node_modules folders from `from` up to the filesystem root (how Node itself resolves).
export async function nodeModulesUp(from) {
    const out = [];
    for (let d = await real(from); ; d = path.dirname(d)) {
        if (await exists(path.join(d, 'node_modules')))
            out.push(path.join(d, 'node_modules'));
        if (path.dirname(d) === d) return out;
    }
}

// Bundle an entry into outDir. Returns { components, files: [relative paths], warnings }.
/**
 * The repo's Tailwind entry compiled against the pushed component files only, with the repo's
 * own Tailwind: the utilities shadcn-style components are styled with exist nowhere else. A repo
 * without Tailwind v4 installed gets nothing.
 */
export async function tailwindCss({
    repoRoot,
    css,
    files,
}: {
    repoRoot: string;
    css: string[];
    files: string[];
}): Promise<string | null> {
    if (!css.length || !files.length) return null;
    const require = createRequire(path.join(repoRoot, 'package.json'));
    let node, oxide;
    try {
        node = await import(
            pathToFileURL(require.resolve('@tailwindcss/node')).href
        );
        oxide = await import(
            pathToFileURL(require.resolve('@tailwindcss/oxide')).href
        );
    } catch {
        return null;
    }
    const entry = path.resolve(repoRoot, css[0]);
    const source = await readFile(entry, 'utf8');
    const compiler = await node.compile(source, {
        base: path.dirname(entry),
        onDependency: () => {},
    });
    const scanner = new oxide.Scanner({
        sources: files.map((file) => ({
            base: path.dirname(path.resolve(repoRoot, file)),
            pattern: path.basename(file),
            negated: false,
        })),
    });
    // In a layer of its own: the system's tokens.css is unlayered, so its variables win over the
    // ones the repo's stylesheet defines, whichever loads first.
    return `@layer viskel-bundle {\n${compiler.build(scanner.scan())}\n}\n`;
}

export async function bundleDesignSystem({
    entry,
    global,
    outDir,
    nodePaths = [],
    tsconfig = undefined as string | undefined,
    tailwind = null as string | null,
}) {
    checkGlobal(global);
    const entryPath = await real(entry);
    if (!(await exists(entryPath)))
        throw new Error(`No entry file at ${entry}`);
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    const common: BuildOptions = {
        entryPoints: [entryPath],
        bundle: true,
        platform: 'browser',
        target: 'es2020',
        jsx: 'automatic',
        nodePaths,
        ...(tsconfig ? { tsconfig } : {}),
        plugins: [reactShim],
        loader: {
            '.js': 'jsx',
            '.svg': 'dataurl',
            '.png': 'dataurl',
            '.jpg': 'dataurl',
            '.jpeg': 'dataurl',
            '.gif': 'dataurl',
            '.webp': 'dataurl',
            '.woff': 'file',
            '.woff2': 'file',
            '.ttf': 'file',
            '.otf': 'file',
            '.eot': 'file',
        },
        define: {
            'process.env.NODE_ENV': '"production"',
            'import.meta.env': '{"MODE":"production","DEV":false,"PROD":true}',
        },
        logLevel: 'silent',
    };

    // Pass 1: which names the entry exports (they become <Global>.<Name>).
    const probe = await esbuild.build({
        ...common,
        format: 'esm',
        write: false,
        metafile: true,
        outdir: outDir,
    });
    const components =
        Object.values(probe.metafile.outputs)
            .find((o) => o.entryPoint)
            ?.exports?.filter((n) => n !== 'default')
            .sort() || [];

    // Pass 2: the browser bundle.
    const header = JSON.stringify({
        namespace: global,
        components: components.map((name) => ({ name })),
    });
    const result = await esbuild.build({
        ...common,
        format: 'iife',
        globalName: '__dsBundle',
        outfile: path.join(outDir, '_ds_bundle.js'),
        assetNames: 'assets/[name]-[hash]',
        banner: { js: `/* @ds-bundle: ${header} */` },
        footer: { js: `window.${global} = __dsBundle;` },
    });
    // styles.css is what boards link: whatever CSS the components import, then the Tailwind
    // utilities they are styled with.
    const hasCss = await exists(path.join(outDir, '_ds_bundle.css'));
    await writeFile(
        path.join(outDir, 'styles.css'),
        (hasCss ? '@import "./_ds_bundle.css";\n' : '') +
            (tailwind ??
                (hasCss ? '' : '/* the components import no CSS */\n')),
    );
    return {
        components,
        files: await filesUnder(outDir),
        warnings: result.warnings.map((w) => w.text),
    };
}

async function filesUnder(dir, sub = '') {
    const out = [];
    for (const e of await readdir(path.join(dir, sub), {
        withFileTypes: true,
    })) {
        const rel = sub ? `${sub}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...(await filesUnder(dir, rel)));
        else out.push(rel);
    }
    return out;
}
