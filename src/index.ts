/**
 * Frontend-inspector plugin, host half: dev-only click-to-source for React
 * apps served in tooling that keeps the JSX `__source` (vite dev). On
 * Shift+Option click this walks the element's React fiber to the nearest
 * component's `_debugSource` and opens the editor at that file:line:column.
 *
 * The plugin is completely runtime and self-contained: DSH capabilities are
 * reached through the injected Cordis `ctx` (the `webServer` service serves
 * the client script and handles the IDE-open request), and it carries no
 * build-time source transform and no package dependencies beyond node builtins.
 *
 * @module @lovstudio/dsh-frontend-inspector
 */

import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name. */
export const name = 'frontend-inspector'

/** Absolute web-server path serving the runtime client script. */
export const INJECT_PATH = '/lovinsp-inject.js'

/** Absolute web-server path receiving a click's source target. */
export const OPEN_PATH = '/lovinsp-open'

/** Settings namespace carrying the frontend inspector's enable switch. */
export const INSPECTOR_SETTINGS_NAMESPACE = 'frontend-inspector'

/** Stored and composed frontend-inspector settings. */
export interface InspectorSettings {
  /** Whether click-to-source is enabled. */
  enabled: boolean
}

/** Composition entry for the frontend inspector. */
export interface Config {
  /** Default enabled state when no settings provider is mounted. */
  enabled?: boolean
  /** Editor URL scheme used to open the source (`vscode`, `idea`, `cursor`, …). */
  scheme?: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  scheme: z.string().default('vscode'),
})

/** Schema of the frontend-inspector settings section. */
export const INSPECTOR_SETTINGS_SCHEMA: z<InspectorSettings> = z.object({
  enabled: z.boolean().default(true),
})

/** Client script: Shift+Option click → nearest component `_debugSource` → open. */
const CLIENT_SCRIPT = `(function(){
  var OPEN_PATH = ${JSON.stringify(OPEN_PATH)};
  function handler(e){
    if(!(e.altKey && e.shiftKey)) return;
    e.preventDefault();
    var el = e.target;
    while(el && !(el instanceof Element)) el = el.parentElement;
    if(!el) return;
    var key = Object.keys(el).find(function(k){ return k.indexOf('__reactFiber$') === 0; });
    var fiber = key ? el[key] : null;
    var seen = new Set();
    while(fiber && !seen.has(fiber)){
      seen.add(fiber);
      if(fiber._debugSource && typeof fiber.type === 'function'){
        var s = fiber._debugSource;
        fetch(OPEN_PATH, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ file:s.fileName, line:s.lineNumber, col:s.columnNumber }) });
        return;
      }
      fiber = fiber.return;
    }
    console.warn('[frontend-inspector] no component _debugSource found for', el);
  }
  document.addEventListener('click', handler, true);
})();`

/** Open the editor at `file:line:col` via the configured URL scheme. */
function openEditorAt(file: string, line: number, col: number, scheme: string): void {
  const url = `${scheme}://file/${file}:${line}:${col}`
  // macOS ships `open`; Linux uses xdg-open; Windows uses `cmd /c start`.
  const isWin = process.platform === 'win32'
  const command = isWin ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = isWin ? ['/c', 'start', '', url] : [url]
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref()
  } catch {
    // Opening the editor is best-effort; a failure must not break the click.
  }
}

/**
 * Register the `frontend-inspector` settings namespace and the runtime
 * click-to-source surface gated on `enabled`.
 * @param ctx - cordis context carrying the optional settings and webServer services.
 * @param config - composition entry, layered below the user settings section.
 */
export function apply(ctx: Context, config: Config): void {
  let readSection: (() => InspectorSettings) = () => ({ enabled: config.enabled ?? true })

  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(
      INSPECTOR_SETTINGS_NAMESPACE,
      INSPECTOR_SETTINGS_SCHEMA,
      { base: { enabled: config.enabled ?? true } },
    )
    readSection = () => scope.get()
    scope.watch(() => {})
  })

  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => {
      const removeClient = httpCtx.webServer.register({
        kind: 'exact',
        path: INJECT_PATH,
        handler: async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
          res.writeHead(200, {
            'Content-Type': 'text/javascript',
            'Cache-Control': 'no-cache',
          })
          res.end(CLIENT_SCRIPT)
        },
      })
      const removeOpen = httpCtx.webServer.register({
        kind: 'exact',
        path: OPEN_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
          let body = ''
          for await (const chunk of req) body += String(chunk)
          let target: { file?: string, line?: number, col?: number } = {}
          try { target = JSON.parse(body) } catch { /* ignore malformed body */ }
          if (target.file !== undefined) {
            openEditorAt(target.file, target.line ?? 0, target.col ?? 0, config.scheme ?? 'vscode')
          }
          res.writeHead(204).end()
        },
      })
      const removeTap = httpCtx.webServer.tapIndex((html) => {
        if (readSection().enabled !== true) return html
        return html.replace('<head>', `<head><script src="${INJECT_PATH}"></script>`)
      })
      return () => {
        removeClient()
        removeOpen()
        removeTap()
      }
    }, 'frontend-inspector: runtime click-to-source')
  })
}
