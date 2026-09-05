# dsh-frontend-inspector

Production click-to-source for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web surface. Hold the Lovinsp shortcut over a rendered element to locate or copy its original source position.

This is a Lovstudio plugin under the `@lovstudio` scope. It does not patch or rebuild files inside the DeepSeek Harness repository.

## Architecture

Current DSH Web links prebuilt package artifacts and serves runtime `dsh.client` bundles through the Client Module Registry. A runtime-only React `_debugSource` reader therefore cannot inspect the production UI.

This plugin uses the supported Host extension points instead:

- A persistent Vite process reads the clean DSH checkout and writes a Lovinsp-enabled shell to `DSH_HOME/cache/frontend-inspector/dist`.
- The shell build maps compiled JSX calls through adjacent source maps and emits `data-insp-path` values pointing to original `.tsx` files.
- `webServer.tapIndex()` retains DSH authentication and boot-data injection while replacing only shell asset tags.
- `/lovinsp-shell/*` serves the external shell cache as a named route ahead of the official static fallback.
- `/lovinsp-plugins/*` proxies Client Module Registry combo bundles, applies their indexed source maps, and adds source markers for independent plugins such as Plugin Marketplace.
- The Lovinsp bridge stays alive with the Vite watcher and is stopped with the DSH plugin lifecycle.
- Without a checkout (npx mode) none of the above runs: the overlay script `@lovinsp/core` generates is inlined into the index page, and `/lovinsp-plugins/*` marks bundles from their region markers and package manifests instead of source maps. Every plugin in the combo is marked against its own repository and release, so third-party plugins are covered alongside the harness.

The DSH checkout is read-only input. Generated files, Vite cache, and Lovinsp state stay under `DSH_HOME/cache/frontend-inspector`.

## Install

Two modes, chosen automatically at startup:

| | Source checkout | Plain `npx @deepseek-ai/dsh` |
|---|---|---|
| Markers | exact TypeScript file:line:column from source maps | file only, from the `//#region` markers tsdown leaves in published bundles |
| Click | opens the file in your editor (`editor`, default `vscode`) | opens the file on GitHub, in each package's own repository at its installed release |
| Shell | rebuilt once by Vite with markers on the shell's own elements | untouched; only plugin bundles (where nearly all UI lives) carry markers |
| Requirements | a harness checkout; Vite is resolved from its `apps/web` | nothing beyond the plugin |

Shortcut in both modes: hold **Shift+Option** (Windows: Shift+Alt) while moving the mouse to highlight an element, then click — a source checkout opens your editor, npx mode copies the source URL. In npx mode, adding **Command** (Windows: Ctrl) opens the file on GitHub instead. npx mode also shows the chord once as a transient hint on first load, since the overlay is invisible until the keys are held.

**From a source checkout (exact positions, editor jump):**

```sh
git clone --depth 1 --branch dsh-v0.1.2-rc.1 https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness && pnpm install && pnpm run build
pnpm dsh plugin --profile web add -w github:lovstudio/dsh-frontend-inspector#v0.1.7
pnpm dsh web
```

The checkout is found from `sourceRoot`, `DSH_SOURCE_ROOT`, or the launch directory, in that order; generated files stay under `DSH_HOME/cache/frontend-inspector`.

**Without a checkout (file-level, GitHub jump):**

```sh
npx @deepseek-ai/dsh plugin --profile web add -w github:lovstudio/dsh-frontend-inspector#v0.1.7
npx @deepseek-ai/dsh web
```

Every package in the loader combo is marked against the `repository` in its own manifest, so a click on Plugin Marketplace opens Plugin Marketplace and a click on the chat shell opens the harness. The ref is the harness's `sourceRef` for harness packages and `v<installed version>` — the tag npm release workflows push — for everything else; `refs` overrides any package that tags differently:

```yaml
- id: frontend-inspector
  name: '@lovstudio/dsh-frontend-inspector'
  config:
    refs:
      some-plugin: main
```

A package that declares no `repository`, or none that resolves to a git host, stays unmarked rather than linking somewhere wrong.

## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Build and serve the instrumented Web surface. |
| `sourceRoot` | auto | Clean DeepSeek Harness checkout used as read-only source. |
| `port` | `5678` | Start of Lovinsp's available-port search. |
| `editor` | `vscode` | Editor identifier passed to Lovinsp. |
| `startupTimeoutMs` | `120000` | First instrumented build deadline (checkout mode). |
| `repository` | harness repo | npx mode: which repository counts as the harness, whose packages use `sourceRef`. |
| `sourceRef` | `dsh-v<version>` | npx mode: git ref of the harness repository; falls back to `master` when the running dsh version cannot be read. |
| `refs` | `{}` | npx mode: git ref per package name, overriding the derived `v<version>`. |

The `frontend-inspector.enabled` settings section can disable index routing without uninstalling the bundle.

## Use

Lovinsp renders its switch on the page. In checkout mode the default action is IDE location and markers cover both the official shell and plugin bundles (from their source maps). In npx mode the default action copies the source URL, Command promotes it to a GitHub jump, and markers cover plugin bundles only, resolved from the `//#region` file markers tsdown leaves in published `lib/client.js` (own files map `lib/types/**/x.js` back to `src/**/x.tsx`). The URL carries no line: published bundles ship no source maps, so only the file is exact. Both the automatic JSX runtime and `React.createElement` are recognized. Copy is enabled in both modes.

## Local development

Keep this checkout outside the DeepSeek Harness repository:

```sh
pnpm install
pnpm run watch
```

The package watcher rebuilds the Host plugin. The plugin-owned Vite watcher rebuilds the external shell when DSH client artifacts change. Restart DSH after changing Host code or the runner.

## License

[MIT](LICENSE)
