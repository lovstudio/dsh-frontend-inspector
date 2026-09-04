import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  HARNESS_REPOSITORY, detectHarnessRef, injectOverlay, instrumentPublishedBundle, overlayScript, repositoryPathFor,
} from '../index.js'

test('repositoryPathFor maps tsc output and cross-package regions onto repository paths', () => {
  assert.equal(repositoryPathFor('lib/types/client/chat/Foo.js', 'packages/client/ui-chat'), 'packages/client/ui-chat/src/client/chat/Foo.tsx')
  assert.equal(repositoryPathFor('../../core/session/src/surface.ts', 'packages/client/ui-chat'), 'packages/core/session/src/surface.ts')
  assert.equal(repositoryPathFor('../../../vendor/cosmokit/src/misc.ts', 'packages/client/ui-chat'), 'vendor/cosmokit/src/misc.ts')
  assert.equal(repositoryPathFor('\0dsh-css:/x/y.module.css', 'packages/client/ui-chat'), undefined)
  assert.equal(repositoryPathFor('../../../../etc/passwd', 'packages/client/ui-chat'), undefined)
})

test('instrumentPublishedBundle marks JSX from region markers of harness packages only', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inspector-'))
  const pkg = (id, dir, repository) => {
    const home = join(root, ...id.split('/'))
    mkdirSync(join(home, 'lib'), { recursive: true })
    writeFileSync(join(home, 'package.json'), JSON.stringify({ name: id, repository: { url: `git+${repository}.git`, directory: dir } }))
    return join(home, 'lib', 'client.js')
  }
  const paths = {
    '@deepseek-ai/dsh-client-ui-chat': pkg('@deepseek-ai/dsh-client-ui-chat', 'packages/client/ui-chat', HARNESS_REPOSITORY),
    '@lovstudio/dsh-plugin-marketplace': pkg('@lovstudio/dsh-plugin-marketplace', '', 'https://github.com/lovstudio/dsh-plugin-marketplace'),
  }
  const modules = { clientPath: id => paths[id] }
  const bundle = [
    'window.__ModuleLoader__.load({',
    '  id: "@deepseek-ai/dsh-client-ui-chat",',
    '  factory: (require) => {',
    '    //#region lib/types/client/chat/Row.js',
    '    const a = (0, react_jsx_runtime.jsx)("div", { className: "row" });',
    '    //#region ../../core/session/src/surface.ts',
    '    const b = (0, react_jsx_runtime.jsxs)("span", { children: [] });',
    '  } });',
    'window.__ModuleLoader__.load({',
    '  id: "@lovstudio/dsh-plugin-marketplace",',
    '  factory: (require) => {',
    '    //#region lib/types/client/x.js',
    '    const c = (0, react_jsx_runtime.jsx)("p", { id: "c" });',
    '  } });',
  ].join('\n')
  const out = instrumentPublishedBundle(bundle, modules, '/plugins/??@deepseek-ai/dsh-client-ui-chat/client.js,@lovstudio/dsh-plugin-marketplace/client.js&rev=1', HARNESS_REPOSITORY)
  assert.match(out, /"data-insp-path":"packages\/client\/ui-chat\/src\/client\/chat\/Row\.tsx:5:\d+:div"/u)
  assert.match(out, /"data-insp-path":"packages\/core\/session\/src\/surface\.ts:7:\d+:span"/u)
  assert.doesNotMatch(out, /"data-insp-path":"[^"]*:p"/u)
})

test('injectOverlay inlines the overlay before </head> and routes plugin bundles through the proxy', () => {
  const html = '<!doctype html><html><head><title>x</title></head><body><script type="module" src="/plugins/??a/client.js"></script></body></html>'
  const out = injectOverlay(html, 'console.log("</script>")')
  assert.match(out, /<script>console\.log\("<\\\/script>"\)<\/script><\/head>/u)
  assert.match(out, /src="\/lovinsp-plugins\/plugins\/\?\?a\/client\.js"/u)
})

test('overlayScript keeps copy on the bare chord and reserves the meta key for GitHub', async () => {
  const out = await overlayScript({}, 'dsh-v0.1.2-rc.1')
  assert.match(out, /inspector\.copyKeys = 'shiftKey,altKey';/u)
  assert.match(out, /inspector\.targetKeys = \(\/mac\|iphone\|ipad\|ipod\/i\.test\(navigator\.userAgent\)\) \? 'shiftKey,altKey,metaKey' : 'shiftKey,altKey,ctrlKey';/u)
  assert.match(out, /inspector\.defaultAction = "copy";/u)
  assert.match(out, new RegExp(`inspector\\.target = '${HARNESS_REPOSITORY}/blob/dsh-v0\\.1\\.2-rc\\.1/\\{file\\}';`, 'u'))
  // The hint must never intercept a click meant for the app underneath.
  assert.match(out, /pointer-events:none/u)
  assert.doesNotMatch(out, /addEventListener\('click'/u)
})

test('detectHarnessRef reads the launching dsh package version and falls back to master', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ref-'))
  mkdirSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.2-rc.1' }))
  assert.equal(detectHarnessRef(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')), 'dsh-v0.1.2-rc.1')
  assert.equal(detectHarnessRef(join(root, 'elsewhere', 'bin.js')), 'master')
})
