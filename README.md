# viskel CLI

The part of Viskel that runs on your machine, next to your code: import a claude.ai Design
export, and build a design system from your own React components and upload it. Everything else
(boards, pages, validation) is done by agents through the MCP tools.

## Install

Needs Node 22.18 or newer (the CLI is TypeScript, which Node runs directly).

```bash
git clone https://github.com/veebisepad/viskel && cd viskel
npm i -g ./cli          # puts `viskel` on your PATH
```

## Log in

Make a personal access token on the server's tokens page, then:

```bash
viskel login https://viskel.example.com <token>
```

The server and token are saved in `~/.config/viskel/cli.json` (mode 0600).
`VISKEL_URL` and `VISKEL_TOKEN` override them, which is what CI should use.

## Commands

```bash
viskel designs                                    # key, title, org/space
viskel import ./my-claude-design-export --name my-design [--space my-org/my-space]
viskel ds init [--system <key>] [--include <glob>] [--css <path>] [--force]
viskel ds push [--system <key>] [--include <glob>] [--css <path>] [--commit <sha>]
               [--global <Name>] [--force]
viskel ds pull
```

`--space` names a space as `organisation/space`, as `viskel designs` prints it; a slug or name
works while it names one space only. Without it the design goes into your current space.

## Design systems from your code

**`viskel ds init`** writes `viskel.json` in the repo root:

```json
{
    "system": "portal-ui",
    "components": ["resources/js/components/ui"],
    "css": ["resources/css/app.css"]
}
```

The defaults come from the repo's `components.json`: `components` is the shadcn `ui` alias
resolved through the `tsconfig` paths, `css` is the Tailwind entry (`app.css` / `globals.css`).
`--include` and `--css` are repeatable and override the defaults; `--force` overwrites an
existing `viskel.json`.

**`viskel ds push`** does four things:

1. **Extracts a record per component** from every `.tsx`, `.jsx`, `.ts` and `.js` file the include
   globs match, using the
   TypeScript compiler API. One family per file; rendering exports become components
   (`@/components/ui/card#CardTitle`, board tag `ui-card-title`), non-rendering exports
   (`buttonVariants`, hooks) become helpers. Props are the file's own props plus those it takes
   from a component library (Radix's `open`, `defaultValue`, `value`…); the DOM attributes React
   declares are not listed one by one — a component that spreads them is marked `native`, and
   boards may set standard HTML attributes on it — with enum values and defaults
   from the file's `cva` config and from the destructuring defaults, TSDoc as the description,
   `className` hidden, and function/object/ref props marked not placeable. Exports it cannot
   extract are listed as skipped, never guessed. A component whose props type did not resolve at
   all — usually the repo's dependencies are not installed — refuses the push rather than storing
   it with no props; `--force` pushes it anyway.
2. **Bundles** every extracted component with esbuild, using the repo's own `node_modules` and
   `tsconfig` paths, into `_ds_bundle.js` (IIFE on `window.<Global>`), `_ds_bundle.css`,
   `styles.css` and `assets/`. The entry is generated in a temp dir; there is no entry file in
   the repo. React is taken from the page (like claude.ai bundles).
   When the repo has Tailwind v4 installed, the first `css` entry is compiled with the repo's own
   Tailwind against the component files only and added to `styles.css`, inside
   `@layer viskel-bundle`, so the utilities the components are styled with render on boards
   while the design system's tokens still win over the variables the stylesheet defines.
3. **Sends the `css` files** alongside the bundle, each under its own file name; the server
   parses them for tokens on every push. It reads them by name, so each one must be called
   `app.css` or `globals.css` — the CLI refuses anything else before uploading.
4. **Uploads** it all to `POST /api/ds/{system}/push` and prints the import report: families
   added/changed/removed, bundle size, token outcomes, warnings and skipped exports.

`--include` and `--css` given on the command line are merged into `viskel.json`, saved only once
the push is accepted, so a refused push never leaves the file naming something the server
rejects. `--commit` overrides `git rev-parse --short HEAD`, and `--global` overrides the window
global the bundle hangs on, which is otherwise derived from the system key.

**Your code never leaves your machine.** Only the bundle, the records and the CSS files do.

**`viskel ds pull`** (Viskel → repo) is not available yet; it ships with the two-way component
sync.

Uploads are `multipart/form-data`, streamed from disk, limited to 60 MB by the server.

## Tests

```bash
cd cli && npm install && npm test   # node --test against a stub server
```

The CLI has its own `package.json` and `node_modules`; it is not part of the Laravel app's npm
project. The repo's formatter and linter do cover it, so `npm run check` in the repo root
includes `cli/`.

The server side of what the CLI calls is tested in the server's MCP feature tests
(`tests/Feature/Mcp`).
