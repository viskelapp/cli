import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exists } from './ds-build.ts';
import { loadCompilerOptions } from './ds-extract.ts';

export const CONFIG_FILE = 'viskel.json';

export type DsConfig = {
    system?: string;
    components: string[];
    css: string[];
};

const CSS_CANDIDATES = [
    'resources/css/app.css',
    'src/globals.css',
    'app/globals.css',
    'styles/globals.css',
];

export const isTokenCss = (file: string) =>
    /^(app|globals)\.css$/.test(path.basename(file));

export const configPath = (repoRoot: string) =>
    path.join(repoRoot, CONFIG_FILE);

function stringList(value: unknown, field: string): string[] {
    if (value === undefined) return [];
    if (
        !Array.isArray(value) ||
        value.some((entry) => typeof entry !== 'string')
    )
        throw new Error(`${CONFIG_FILE}: "${field}" must be a list of strings`);
    return value;
}

export async function readConfig(repoRoot: string): Promise<DsConfig | null> {
    let text: string;
    try {
        text = await readFile(configPath(repoRoot), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return null;
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        throw new Error(
            `${CONFIG_FILE} is not valid JSON: ${(error as Error).message}`,
        );
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error(`${CONFIG_FILE} must hold a JSON object`);
    const config = raw as Record<string, unknown>;
    if (config.system !== undefined && typeof config.system !== 'string')
        throw new Error(`${CONFIG_FILE}: "system" must be a string`);
    return {
        system: config.system as string | undefined,
        components: stringList(config.components, 'components'),
        css: stringList(config.css, 'css'),
    };
}

export const writeConfig = (repoRoot: string, config: DsConfig) =>
    writeFile(
        configPath(repoRoot),
        `${JSON.stringify(
            {
                system: config.system,
                components: config.components,
                css: config.css,
            },
            null,
            4,
        )}\n`,
    );

export async function resolveAlias(
    repoRoot: string,
    alias: string,
): Promise<string | null> {
    const { paths, baseDir } = loadCompilerOptions(repoRoot);
    for (const [pattern, targets] of Object.entries(paths)) {
        const wildcard = pattern.endsWith('/*');
        const prefix = wildcard ? pattern.slice(0, -1) : pattern;
        const rest = wildcard
            ? alias.startsWith(prefix)
                ? alias.slice(prefix.length)
                : undefined
            : alias === prefix
              ? ''
              : alias.startsWith(`${prefix}/`)
                ? alias.slice(prefix.length + 1)
                : undefined;
        if (rest === undefined) continue;
        for (const target of targets) {
            const base = target.endsWith('/*') ? target.slice(0, -2) : target;
            if (wildcard && !target.endsWith('/*')) continue;
            const full = path.join(path.resolve(baseDir, base), rest);
            if (await exists(full))
                return path.relative(repoRoot, full).split(path.sep).join('/');
        }
    }
    return null;
}

export async function defaultConfig(repoRoot: string): Promise<DsConfig> {
    let shadcn: any = {};
    try {
        shadcn = JSON.parse(
            await readFile(path.join(repoRoot, 'components.json'), 'utf8'),
        );
    } catch {}

    const components: string[] = [];
    const ui = shadcn.aliases?.ui;
    const resolved = ui ? await resolveAlias(repoRoot, ui) : null;
    if (resolved) components.push(resolved);
    else {
        const literal = (ui ?? '@/components/ui').replace(/^@\//, '');
        for (const candidate of [
            literal,
            `resources/js/${literal}`,
            `src/${literal}`,
        ])
            if (await exists(path.join(repoRoot, candidate))) {
                components.push(candidate);
                break;
            }
    }

    const css: string[] = [];
    const declared = shadcn.tailwind?.css;
    if (declared && (await exists(path.join(repoRoot, declared))))
        css.push(declared);
    else
        for (const candidate of CSS_CANDIDATES)
            if (await exists(path.join(repoRoot, candidate))) {
                css.push(candidate);
                break;
            }

    return { components, css };
}
