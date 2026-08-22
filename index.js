// ../../../手工川DSH实战/dsh-workspace/dsh-frontend-inspector/src/index.ts
import { spawn } from "node:child_process";
import z from "@deepseek-ai/schemastery";
var name = "frontend-inspector";
var INJECT_PATH = "/lovinsp-inject.js";
var OPEN_PATH = "/lovinsp-open";
var INSPECTOR_SETTINGS_NAMESPACE = "frontend-inspector";
var Config = z.object({
  enabled: z.boolean().default(true),
  scheme: z.string().default("vscode")
});
var INSPECTOR_SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true)
});
var CLIENT_SCRIPT = `(function(){
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
})();`;
function openEditorAt(file, line, col, scheme) {
  const url = `${scheme}://file/${file}:${line}:${col}`;
  const isWin = process.platform === "win32";
  const command = isWin ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = isWin ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
  }
}
function apply(ctx, config) {
  let readSection = () => ({ enabled: config.enabled ?? true });
  ctx.inject(["settings"], (sctx) => {
    const scope = sctx.settings.register(
      INSPECTOR_SETTINGS_NAMESPACE,
      INSPECTOR_SETTINGS_SCHEMA,
      { base: { enabled: config.enabled ?? true } }
    );
    readSection = () => scope.get();
    scope.watch(() => {
    });
  });
  ctx.inject(["webServer"], (httpCtx) => {
    httpCtx.effect(() => {
      const removeClient = httpCtx.webServer.register({
        kind: "exact",
        path: INJECT_PATH,
        handler: async (_req, res) => {
          res.writeHead(200, {
            "Content-Type": "text/javascript",
            "Cache-Control": "no-cache"
          });
          res.end(CLIENT_SCRIPT);
        }
      });
      const removeOpen = httpCtx.webServer.register({
        kind: "exact",
        path: OPEN_PATH,
        handler: async (req, res) => {
          let body = "";
          for await (const chunk of req) body += String(chunk);
          let target = {};
          try {
            target = JSON.parse(body);
          } catch {
          }
          if (target.file !== void 0) {
            openEditorAt(target.file, target.line ?? 0, target.col ?? 0, config.scheme ?? "vscode");
          }
          res.writeHead(204).end();
        }
      });
      const removeTap = httpCtx.webServer.tapIndex((html) => {
        if (readSection().enabled !== true) return html;
        return html.replace("<head>", `<head><script src="${INJECT_PATH}"></script>`);
      });
      return () => {
        removeClient();
        removeOpen();
        removeTap();
      };
    }, "frontend-inspector: runtime click-to-source");
  });
}
export {
  Config,
  INJECT_PATH,
  INSPECTOR_SETTINGS_NAMESPACE,
  INSPECTOR_SETTINGS_SCHEMA,
  OPEN_PATH,
  apply,
  name
};
