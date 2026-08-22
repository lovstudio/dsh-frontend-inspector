# dsh-frontend-inspector

Lovstudio's click-to-source plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web surface. Hold `Shift + Option` and click a rendered element in the page to open the editor at that element's source location. It is driven by [LovInsp](https://inspector.fe-dev.cn) — an IDE-bridge that opens the source `file:line:column` of the inspected element.

This is a **Lovstudio** plugin, not a DeepSeek-AI package. It is developed alongside the Lovstudio fork of the harness and distributed under the `@lovstudio` scope.

## What it does

- Serves the LovInsp runtime client at `/lovinsp-inject.js` through a host `webServer` route.
- Taps the index HTML to load that client script when `frontend-inspector.enabled` is true.
- Lazily starts the LovInsp IDE bridge (HTTP server) on first request, so an unchanged deployment that never inspects keeps no listener.

`enabled` defaults to **true**, so the plugin is live out of the box.

## Install

Plugins distribute as a **bundle** (`dsh.bundle.patch` → `cordis.patch.yml`). Install it into the `web` profile (the one `dsh web` boots):

```sh
# from git (append #<sha> to pin a commit)
dsh plugin --profile web add github:lovstudio/dsh-frontend-inspector

# or straight from npm
dsh plugin --profile web add @lovstudio/dsh-frontend-inspector
```

The plugin relies on the host profile's `webServer` service, provided by the `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` bundles. No rebuild of the web application is needed to add the runtime bridge.

## Use

1. Start the web UI: `dsh web`.
2. Hold `Shift + Option` and click any element.

## Note on the build-time markers

Click-to-source needs two parts: the **runtime bridge** this plugin provides (the served client script and the IDE-bridge), and **build-time `data-insp-path` markers** stamped onto the page's bundled JSX. The markers are added by the hosting web build's LovInsp transform. A `dsh web` served from the harness repository applies that transform, so the markers are present; the runtime bridge is exactly what this bundle contributes and is enabled by default.

## Package

The plugin ships as a self-contained `index.js` (a bundle of the host plugin with its platform peer imports left to the host) and a `cordis.patch.yml` layer.

## License

[MIT](LICENSE)
