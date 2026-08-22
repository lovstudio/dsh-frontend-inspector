# dsh-frontend-inspector

Lovstudio's **dev-only** click-to-source for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web surface. Hold `Shift + Option` and click a rendered element to open the editor at that element's source location.

This is a **Lovstudio** plugin, not a DeepSeek-AI package, distributed under the `@lovstudio` scope.

## What it does

The plugin is completely **runtime** — there are no build-time source transforms and no build-time `data-insp-path` markers.

- **Host half** registers two `webServer` routes:
  - `GET /lovinsp-inject.js` — serves the runtime client script.
  - `POST /lovinsp-open` — receives `{ file, line, col }` and opens the editor (`open <scheme>://file/<file>:<line>:<col>`).
- **Client** (the served script): on `Shift + Option` click, walks the target element's React fiber (`__reactFiber$`) to the nearest custom component and reads its `_debugSource` (`file:line:column`), then POSTs it to `/lovinsp-open`.

Because it reads React's `_debugSource`, it works where the app is built with the JSX `__source` kept in **development mode** (a real `vite`/dev-server React app). Production builds strip `__source`, so the plugin is a dev-facing debug tool.

The plugin reaches DSH capabilities through the injected Cordis `ctx` only (`webServer`, and the `settings` service for the enabled switch). Its only package dependency is the schemastery schema library.

## Install

Plugins distribute as a **bundle** (`dsh.bundle.patch` → `cordis.patch.yml`). Install into the `web` profile (the one `dsh web` boots):

```sh
# from git (append #<sha> to pin a commit)
dsh plugin --profile web add github:lovstudio/dsh-frontend-inspector

# or straight from npm
dsh plugin --profile web add @lovstudio/dsh-frontend-inspector
```

`enabled` defaults to **true**; a `frontend-inspector.enabled` settings namespace can override it. The `webServer` service is provided by the harness launcher / `@deepseek-ai/dsh-base`.

## Use

1. Start a **dev** web UI (one whose JSX keeps `__source`), or a `dsh web` served with `vite` dev-mode source info.
2. Hold `Shift + Option` and click any element.
3. The editor opens at the component's source.

## Notes

- Dev-only: requires React `_debugSource` present in the running bundle.
- IDE open uses the OS `open`/`xdg-open`/`start` command with the configured URL scheme (default `vscode`). Override via the plugin `scheme` config.

## License

[MIT](LICENSE)
