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

The DSH checkout is read-only input. Generated files, Vite cache, and Lovinsp state stay under `DSH_HOME/cache/frontend-inspector`.

## Install

This plugin needs a DeepSeek Harness **source checkout** (it rebuilds the Web shell with source markers), so it does not apply to `npx @deepseek-ai/dsh` installations. From the checkout:

```sh
git clone --depth 1 --branch dsh-v0.1.2-rc.1 https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness && pnpm install && pnpm run build
pnpm dsh plugin --profile web add -w github:lovstudio/dsh-frontend-inspector#v0.1.3
pnpm dsh web
```

Vite is resolved from the checkout (`apps/web/node_modules/vite`) at runtime, so the plugin declares no bundler dependency and pnpm 10+ installs it without approving any build script.

Install this repository as a bundle in the `web` profile:

```sh
dsh plugin --profile web add -w link:/absolute/path/to/dsh-frontend-inspector
```

The plugin discovers the DSH source checkout from `sourceRoot`, `DSH_SOURCE_ROOT`, or the launch working directory, in that order. Starting DSH from the checkout therefore needs no extra configuration:

```sh
cd /absolute/path/to/deepseek-harness
dsh web
```

To launch elsewhere, set `sourceRoot` in the bundle row or export `DSH_SOURCE_ROOT`.

## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Build and serve the instrumented Web surface. |
| `sourceRoot` | auto | Clean DeepSeek Harness checkout used as read-only source. |
| `port` | `5678` | Start of Lovinsp's available-port search. |
| `editor` | `vscode` | Editor identifier passed to Lovinsp. |
| `startupTimeoutMs` | `120000` | First instrumented build deadline. |

The `frontend-inspector.enabled` settings section can disable index routing without uninstalling the bundle.

## Use

Lovinsp renders its switch on the page. The default action is IDE location; copy is also enabled. Source markers cover both the official shell and loader-delivered Client plugin bundles when their packages include source maps.

## Local development

Keep this checkout outside the DeepSeek Harness repository:

```sh
pnpm install
pnpm run watch
```

The package watcher rebuilds the Host plugin. The plugin-owned Vite watcher rebuilds the external shell when DSH client artifacts change. Restart DSH after changing Host code or the runner.

## License

[MIT](LICENSE)
