import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

export type PropRecord = {
    name: string;
    type: 'string' | 'number' | 'boolean' | 'enum' | 'node' | 'slot' | 'other';
    values?: string[];
    default?: string | number | boolean;
    description?: string;
    required?: boolean;
    hidden?: boolean;
    placeable?: boolean;
};

export type ComponentRecord = {
    export: string;
    id: string;
    tag: string;
    root?: boolean;
    /** Spreads an HTML element's attributes, so `placeholder`, `checked` and the like are props. */
    native?: boolean;
    props: PropRecord[];
    slots?: { name: string; accepts: string[] }[];
    parent?: string[];
};

export type FamilyRecord = {
    family: string;
    title: string;
    source: { file: string; commit?: string };
    components: ComponentRecord[];
    helpers: string[];
    tokens: string[];
};

export type Skipped = { export: string; file: string; reason: string };

/** The one skip reason a push refuses over: the props are missing, not absent. */
export const UNRESOLVED = 'props type did not resolve';

export type Collision = { tag: string; ids: string[] };

export const kebab = (name: string) =>
    name
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
        .replace(/[\s_.]+/g, '-')
        .toLowerCase();

export function isInside(root: string, file: string): boolean {
    const rel = path.relative(root, file);
    return (
        rel === '' ||
        (rel !== '..' &&
            !rel.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(rel))
    );
}

const fromPackage = (file: string) =>
    file.split(/[\\/]/).includes('node_modules');

function keyName(name: ts.PropertyName | ts.BindingName): string {
    return ts.isIdentifier(name) ||
        ts.isStringLiteral(name) ||
        ts.isNumericLiteral(name) ||
        ts.isPrivateIdentifier(name)
        ? name.text
        : name.getText();
}

export const kebabTag = (exportName: string) => `ui-${kebab(exportName)}`;

export const titleCase = (family: string) =>
    family
        .split('-')
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(' ');

const TEXT_SIZES = new Set([
    'xs',
    'sm',
    'base',
    'lg',
    'xl',
    '2xl',
    '3xl',
    '4xl',
    '5xl',
    '6xl',
    '7xl',
    '8xl',
    '9xl',
]);

const RADIUS = new Set(['none', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', 'full']);

const SHADOWS = new Set(['none', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', 'inner']);

const WEIGHTS = new Set([
    'thin',
    'light',
    'normal',
    'medium',
    'semibold',
    'bold',
    'extrabold',
    'black',
]);

const COLOR_ROLES = new Set([
    'background',
    'foreground',
    'card',
    'card-foreground',
    'popover',
    'popover-foreground',
    'primary',
    'primary-foreground',
    'secondary',
    'secondary-foreground',
    'muted',
    'muted-foreground',
    'accent',
    'accent-foreground',
    'destructive',
    'destructive-foreground',
    'success',
    'success-foreground',
    'warning',
    'warning-foreground',
    'info',
    'info-foreground',
    'border',
    'input',
    'ring',
    'mat',
]);

const COLOR_PREFIX =
    /^(bg|fill|stroke|ring|outline|from|to|via|divide|caret|decoration)-(.+)$/;

const isRole = (rest: string) =>
    COLOR_ROLES.has(rest) ||
    rest.endsWith('-foreground') ||
    rest.endsWith('-strong');

const CLASS_CALLS = new Set([
    'cn',
    'cva',
    'clsx',
    'cx',
    'tv',
    'twMerge',
    'twJoin',
]);

export function themeColours(css: string[]): Set<string> {
    const names = new Set<string>();
    for (const text of css)
        for (const m of text.matchAll(/--(?:color-)?([A-Za-z0-9-]+)\s*:/g))
            names.add(m[1]);
    return names;
}

export function classToken(
    raw: string,
    colours: Set<string> = new Set(),
): string | null {
    if (raw.includes('[') || raw.includes(']')) return null;
    const bare = raw.slice(raw.lastIndexOf(':') + 1).replace(/\/.+$/, '');
    if (!/^-?[a-z][a-z0-9-]*$/.test(bare)) return null;
    const cls = bare.replace(/^-/, '');

    const color = COLOR_PREFIX.exec(cls);
    if (color && (colours.has(color[2]) || isRole(color[2])))
        return `color.${color[2]}`;

    const text = /^text-(.+)$/.exec(cls);
    if (text)
        return TEXT_SIZES.has(text[1])
            ? `text.${text[1]}`
            : isRole(text[1])
              ? `color.${text[1]}`
              : null;

    const border = /^border-(.+)$/.exec(cls);
    if (border) return isRole(border[1]) ? `color.${border[1]}` : null;

    const radius = /^rounded-(.+)$/.exec(cls);
    if (radius) return RADIUS.has(radius[1]) ? `radius.${radius[1]}` : null;

    const shadow = /^shadow-(.+)$/.exec(cls);
    if (shadow) return SHADOWS.has(shadow[1]) ? `shadow.${shadow[1]}` : null;

    const weight = /^font-(.+)$/.exec(cls);
    if (weight && WEIGHTS.has(weight[1])) return `font-weight.${weight[1]}`;

    return null;
}

function isClassContext(node: ts.Node): boolean {
    for (let at = node.parent; at; at = at.parent) {
        if (ts.isJsxAttribute(at))
            return ['className', 'class'].includes(at.name.getText());
        if (
            ts.isCallExpression(at) &&
            ts.isIdentifier(at.expression) &&
            CLASS_CALLS.has(at.expression.text)
        )
            return true;
        if (ts.isBlock(at) || ts.isSourceFile(at)) return false;
    }
    return false;
}

function tokensOf(source: ts.SourceFile, colours: Set<string>): string[] {
    const found = new Set<string>();
    const scan = (text: string, classes: boolean) => {
        for (const m of text.matchAll(/var\(\s*--([a-zA-Z0-9-_]+)/g))
            found.add(m[1]);
        if (!classes) return;
        for (const word of text.split(/\s+/)) {
            const token = classToken(word, colours);
            if (token) found.add(token);
        }
    };
    const walk = (node: ts.Node) => {
        if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node))
            scan(node.text, isClassContext(node));
        ts.forEachChild(node, walk);
    };
    walk(source);
    return [...found].sort();
}

const hasJsx = (node: ts.Node): boolean => {
    let found = false;
    const walk = (n: ts.Node) => {
        if (found) return;
        if (
            ts.isJsxElement(n) ||
            ts.isJsxSelfClosingElement(n) ||
            ts.isJsxFragment(n)
        )
            found = true;
        else ts.forEachChild(n, walk);
    };
    walk(node);
    return found;
};

function jsxNamesIn(node: ts.Node): Set<string> {
    const names = new Set<string>();
    const walk = (n: ts.Node) => {
        const opening = ts.isJsxElement(n)
            ? n.openingElement
            : ts.isJsxSelfClosingElement(n)
              ? n
              : null;
        if (opening && ts.isIdentifier(opening.tagName))
            names.add(opening.tagName.text);
        ts.forEachChild(n, walk);
    };
    walk(node);
    return names;
}

function literalOf(node: ts.Node): string | number | boolean | undefined {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    return undefined;
}

type CvaConfig = {
    variants: Record<string, string[]>;
    defaults: Record<string, string>;
    variantsNode?: ts.ObjectLiteralExpression;
};

const within = (node: ts.Node | undefined, ancestor: ts.Node | undefined) => {
    if (!node || !ancestor) return false;
    for (let at: ts.Node | undefined = node; at; at = at.parent)
        if (at === ancestor) return true;
    return false;
};

const CVA_MODULE = 'class-variance-authority';

function cvaNames(source: ts.SourceFile): Set<string> {
    const names = new Set<string>();
    for (const statement of source.statements) {
        if (
            !ts.isImportDeclaration(statement) ||
            !ts.isStringLiteral(statement.moduleSpecifier) ||
            statement.moduleSpecifier.text !== CVA_MODULE
        )
            continue;
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        for (const element of bindings.elements)
            if ((element.propertyName ?? element.name).text === 'cva')
                names.add(element.name.text);
    }
    return names.size ? names : new Set(['cva']);
}

function cvaConfigs(source: ts.SourceFile): CvaConfig[] {
    const out: CvaConfig[] = [];
    const names = cvaNames(source);
    const walk = (node: ts.Node) => {
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer &&
            ts.isCallExpression(node.initializer) &&
            ts.isIdentifier(node.initializer.expression) &&
            names.has(node.initializer.expression.text)
        ) {
            const config = node.initializer.arguments[1];
            if (config && ts.isObjectLiteralExpression(config)) {
                const variants: Record<string, string[]> = {};
                const defaults: Record<string, string> = {};
                let variantsNode: ts.ObjectLiteralExpression | undefined;
                for (const prop of config.properties) {
                    if (!ts.isPropertyAssignment(prop)) continue;
                    const key = keyName(prop.name);
                    if (!ts.isObjectLiteralExpression(prop.initializer))
                        continue;
                    if (key === 'variants') variantsNode = prop.initializer;
                    for (const entry of prop.initializer.properties) {
                        if (!ts.isPropertyAssignment(entry)) continue;
                        const axis = keyName(entry.name);
                        if (key === 'variants')
                            variants[axis] = ts.isObjectLiteralExpression(
                                entry.initializer,
                            )
                                ? entry.initializer.properties
                                      .filter(ts.isPropertyAssignment)
                                      .map((v) => keyName(v.name))
                                : [];
                        else if (key === 'defaultVariants') {
                            const value = literalOf(entry.initializer);
                            if (value !== undefined)
                                defaults[axis] = String(value);
                        }
                    }
                }
                out.push({ variants, defaults, variantsNode });
            }
        }
        ts.forEachChild(node, walk);
    };
    walk(source);
    return out;
}

function docOf(symbol: ts.Symbol, checker: ts.TypeChecker): string | undefined {
    const text = ts
        .displayPartsToString(symbol.getDocumentationComment(checker))
        .trim();
    return text || undefined;
}

function classify(
    type: ts.Type,
    checker: ts.TypeChecker,
): { type: PropRecord['type']; values?: string[] } {
    const text = checker.typeToString(type);
    if (/\bReact(Node|Element)\b|\bJSX\.Element\b/.test(text))
        return { type: 'node' };
    if (type.getCallSignatures().length) return { type: 'other' };

    const parts = type.isUnion()
        ? type.types.filter(
              (t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)),
          )
        : [type];
    if (parts.every((t) => t.flags & ts.TypeFlags.BooleanLike))
        return { type: 'boolean' };
    if (parts.every((t) => t.isStringLiteral()))
        return parts.length > 1
            ? {
                  type: 'enum',
                  values: parts.map((t) => (t as ts.StringLiteralType).value),
              }
            : { type: 'string' };
    if (parts.every((t) => t.flags & ts.TypeFlags.StringLike))
        return { type: 'string' };
    if (parts.every((t) => t.flags & ts.TypeFlags.NumberLike))
        return { type: 'number' };
    return { type: 'other' };
}

const PLACEABLE = new Set(['string', 'number', 'boolean', 'enum', 'node']);

function propsParameter(node: ts.Node): ts.ParameterDeclaration | undefined {
    let found: ts.ParameterDeclaration | undefined;
    const walk = (n: ts.Node) => {
        if (found) return;
        if (
            (ts.isFunctionDeclaration(n) ||
                ts.isArrowFunction(n) ||
                ts.isFunctionExpression(n)) &&
            n.parameters.length
        )
            found = n.parameters[0];
        else ts.forEachChild(n, walk);
    };
    walk(node);
    return found;
}

function destructuredDefaults(
    param: ts.ParameterDeclaration | undefined,
): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    if (!param || !ts.isObjectBindingPattern(param.name)) return out;
    for (const element of param.name.elements) {
        if (!element.initializer || !ts.isIdentifier(element.name)) continue;
        const name = keyName(element.propertyName ?? element.name);
        const value = literalOf(element.initializer);
        if (value !== undefined) out[name] = value;
    }
    return out;
}

function localDeclaration(
    symbol: ts.Symbol,
    checker: ts.TypeChecker,
): ts.Declaration | undefined {
    const resolved =
        symbol.flags & ts.SymbolFlags.Alias
            ? checker.getAliasedSymbol(symbol)
            : symbol;
    return (
        resolved.valueDeclaration ??
        resolved.declarations?.[0] ??
        symbol.declarations?.[0]
    );
}

export function importPathFor(
    file: string,
    repoRoot: string,
    paths: Record<string, string[]>,
    baseDir: string,
): string {
    const noExt = file.replace(/\.(tsx|ts|jsx|js)$/, '');
    for (const [pattern, targets] of Object.entries(paths)) {
        if (
            !pattern.includes('*') &&
            targets.some(
                (target) =>
                    path
                        .resolve(baseDir, target)
                        .replace(/\.(tsx|ts|jsx|js)$/, '') === noExt,
            )
        )
            return pattern;
        if (!pattern.endsWith('/*')) continue;
        for (const target of targets) {
            if (!target.endsWith('/*')) continue;
            const dir = path.resolve(baseDir, target.slice(0, -2));
            const rel = path.relative(dir, noExt);
            if (isInside(dir, noExt))
                return `${pattern.slice(0, -2)}/${rel.split(path.sep).join('/')}`;
        }
    }
    return path.relative(repoRoot, noExt).split(path.sep).join('/');
}

export function loadCompilerOptions(repoRoot: string) {
    const configPath = ts.findConfigFile(repoRoot, (f) => ts.sys.fileExists(f));
    // findConfigFile walks upward, so a repo with no tsconfig would inherit its parent's.
    const inRepo = configPath !== undefined && isInside(repoRoot, configPath);
    if (!configPath || !inRepo)
        return { options: {}, paths: {}, baseDir: repoRoot };
    const read = ts.readConfigFile(configPath, (f) => ts.sys.readFile(f));
    const parsed = ts.parseJsonConfigFileContent(
        read.config ?? {},
        ts.sys,
        path.dirname(configPath),
    );
    return {
        options: parsed.options,
        paths: (parsed.options.paths ?? {}) as Record<string, string[]>,
        baseDir:
            typeof parsed.options.pathsBasePath === 'string'
                ? parsed.options.pathsBasePath
                : (parsed.options.baseUrl ?? path.dirname(configPath)),
        configPath,
    };
}

export function extractFile(
    source: ts.SourceFile,
    checker: ts.TypeChecker,
    {
        repoRoot,
        importPath,
        commit,
        colours = new Set(),
    }: {
        repoRoot: string;
        importPath: string;
        commit?: string;
        colours?: Set<string>;
    },
): { family: FamilyRecord; skipped: Skipped[] } {
    const file = path
        .relative(repoRoot, source.fileName)
        .split(path.sep)
        .join('/');
    const family = kebab(path.basename(source.fileName).replace(/\.\w+$/, ''));
    const moduleSymbol = checker.getSymbolAtLocation(source);
    const exports = moduleSymbol
        ? checker.getExportsOfModule(moduleSymbol)
        : [];
    const cvas = cvaConfigs(source);
    const skipped: Skipped[] = [];
    const components: ComponentRecord[] = [];
    const helpers: string[] = [];
    const rendered = new Map<string, Set<string>>();

    for (const symbol of exports) {
        const name = symbol.getName();
        if (name === 'default') continue;
        const declaration = localDeclaration(symbol, checker);
        if (!declaration) {
            skipped.push({ export: name, file, reason: 'no declaration' });
            continue;
        }
        if (!hasJsx(declaration)) {
            helpers.push(name);
            continue;
        }
        const param = propsParameter(declaration);
        const props: PropRecord[] = [];
        const defaults = destructuredDefaults(param);
        let hasClassName = !param;
        let native = false;

        if (param) {
            const type = checker.getTypeAtLocation(param);
            const members = type.getProperties();
            if (!members.length && checker.typeToString(type) === 'any') {
                skipped.push({
                    export: name,
                    file,
                    reason: `${UNRESOLVED} (dependencies installed?)`,
                });
                continue;
            }
            const byName = new Map(members.map((m) => [m.getName(), m]));
            for (const cva of cvas)
                for (const [axis, values] of Object.entries(cva.variants)) {
                    const member = byName.get(axis);
                    if (
                        !within(member?.declarations?.[0], cva.variantsNode) ||
                        props.some((p) => p.name === axis)
                    )
                        continue;
                    const fallback = defaults[axis] ?? cva.defaults[axis];
                    props.push({
                        name: axis,
                        type: 'enum',
                        values,
                        ...(fallback === undefined
                            ? {}
                            : { default: fallback }),
                    });
                }
            for (const member of members) {
                const propName = member.getName();
                if (propName === 'className') {
                    hasClassName = true;
                    continue;
                }
                if (props.some((p) => p.name === propName)) continue;
                const declaredIn =
                    member.declarations?.[0]?.getSourceFile().fileName ?? '';
                const own =
                    !fromPackage(declaredIn) && isInside(repoRoot, declaredIn);
                if (!own && /[\\/]@types[\\/]react[\\/]/.test(declaredIn)) {
                    native = true;
                    continue;
                }
                const memberType = checker.getTypeOfSymbolAtLocation(
                    member,
                    param,
                );
                const kind = classify(memberType, checker);
                const description = docOf(member, checker);
                props.push({
                    name: propName,
                    type:
                        kind.type === 'node' && propName !== 'children'
                            ? 'slot'
                            : kind.type,
                    ...(kind.values ? { values: kind.values } : {}),
                    ...(defaults[propName] === undefined
                        ? {}
                        : { default: defaults[propName] }),
                    ...(description ? { description } : {}),
                    ...(member.flags & ts.SymbolFlags.Optional ||
                    defaults[propName] !== undefined
                        ? {}
                        : { required: true }),
                    ...(PLACEABLE.has(kind.type) ? {} : { placeable: false }),
                });
            }
        }

        if (hasClassName)
            props.push({ name: 'className', type: 'string', hidden: true });

        rendered.set(name, jsxNamesIn(declaration));
        components.push({
            export: name,
            id: `${importPath}#${name}`,
            tag: kebabTag(name),
            ...(kebab(name) === family ? { root: true } : {}),
            ...(native ? { native: true } : {}),
            props,
        });
    }

    const byName = new Map(components.map((c) => [c.export, c]));
    for (const component of components) {
        const accepts = [...(rendered.get(component.export) ?? [])]
            .filter((n) => n !== component.export && byName.has(n))
            .map((n) => byName.get(n)!.tag)
            .sort();
        if (accepts.length) component.slots = [{ name: 'children', accepts }];
        for (const tag of accepts) {
            const child = components.find((c) => c.tag === tag)!;
            child.parent = [
                ...new Set([...(child.parent ?? []), component.tag]),
            ].sort();
        }
    }

    return {
        family: {
            family,
            title: titleCase(family),
            source: { file, ...(commit ? { commit } : {}) },
            components,
            helpers: helpers.sort(),
            tokens: tokensOf(source, colours),
        },
        skipped,
    };
}

export function extractAll({
    repoRoot,
    files,
    commit,
    colours = new Set(),
}: {
    repoRoot: string;
    files: string[];
    commit?: string;
    colours?: Set<string>;
}): {
    families: FamilyRecord[];
    skipped: Skipped[];
    collisions: Collision[];
} {
    const { options, paths, baseDir, configPath } =
        loadCompilerOptions(repoRoot);
    const program = ts.createProgram(files, {
        ...options,
        configFilePath: configPath,
        noEmit: true,
        allowJs: true,
        jsx: options.jsx ?? ts.JsxEmit.ReactJSX,
    });
    const checker = program.getTypeChecker();
    const families: FamilyRecord[] = [];
    const skipped: Skipped[] = [];

    for (const file of [...files].sort()) {
        const source = program.getSourceFile(file);
        if (!source) {
            skipped.push({
                export: '*',
                file: path.relative(repoRoot, file),
                reason: 'file could not be parsed',
            });
            continue;
        }
        const one = extractFile(source, checker, {
            repoRoot,
            importPath: importPathFor(file, repoRoot, paths, baseDir),
            commit,
            colours,
        });
        skipped.push(...one.skipped);
        if (one.family.components.length || one.family.helpers.length)
            families.push(one.family);
    }

    const seen = new Map<string, string[]>();
    for (const family of families)
        for (const component of family.components)
            seen.set(component.tag, [
                ...(seen.get(component.tag) ?? []),
                component.id,
            ]);
    const collisions = [...seen]
        .filter(([, ids]) => ids.length > 1)
        .map(([tag, ids]) => ({ tag, ids: ids.sort() }));

    return { families, skipped, collisions };
}

const globToRegExp = (pattern: string) =>
    new RegExp(
        `^${pattern
            .split('/')
            .map((part) =>
                part === '**'
                    ? '.*'
                    : part
                          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                          .replace(/\*/g, '[^/]*')
                          .replace(/\?/g, '[^/]'),
            )
            .join('/')
            .replace(/\.\*\//g, '(?:.*/)?')}$`,
    );

async function walkFiles(dir: string, out: string[]) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR')
            throw new Error(`Cannot read ${dir}: ${(error as Error).message}`);
        return;
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules')
            continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walkFiles(full, out);
        else out.push(full);
    }
}

/** Every extension extractAll can read: it parses with allowJs, so .js and .jsx count. */
const SOURCE = /\.(tsx|jsx|ts|js)$/;

const isSource = (file: string) => SOURCE.test(file) && !file.endsWith('.d.ts');

export async function matchFiles(
    repoRoot: string,
    patterns: string[],
): Promise<string[]> {
    const found = new Set<string>();
    for (const pattern of patterns) {
        const clean = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
        const full = path.resolve(repoRoot, clean);
        const kind = await stat(full).then(
            (s) => (s.isDirectory() ? 'directory' : 'file'),
            () => 'glob',
        );
        const all: string[] = [];
        if (kind === 'file') {
            if (isSource(full)) found.add(full);
            continue;
        }
        if (kind === 'directory') {
            await walkFiles(full, all);
            for (const file of all) if (isSource(file)) found.add(file);
            continue;
        }
        const segments = clean.split('/');
        const wildcard = segments.findIndex((p) => p.includes('*'));
        const staticRoot = segments.slice(
            0,
            wildcard === -1 ? segments.length : wildcard,
        );
        await walkFiles(
            path.resolve(repoRoot, staticRoot.join('/') || '.'),
            all,
        );
        const re = globToRegExp(clean);
        for (const file of all) {
            const rel = path.relative(repoRoot, file).split(path.sep).join('/');
            if (isSource(file) && re.test(rel)) found.add(file);
        }
    }
    return [...found].sort();
}
