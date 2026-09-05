import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  HARNESS_REPOSITORY, detectHarnessRef, injectOverlay, instrumentPublishedBundle, normalizeRepository, overlayScript,
  repositoryPathFor,
} from '../index.js'

test('repositoryPathFor maps tsc output and cross-package regions onto repository paths', () => {
  assert.equal(repositoryPathFor('lib/types/client/chat/Foo.js', 'packages/client/ui-chat'), 'packages/client/ui-chat/src/client/chat/Foo.tsx')
  assert.equal(repositoryPathFor('../../core/session/src/surface.ts', 'packages/client/ui-chat'), 'packages/core/session/src/surface.ts')
  assert.equal(repositoryPathFor('../../../vendor/cosmokit/src/misc.ts', 'packages/client/ui-chat'), 'vendor/cosmokit/src/misc.ts')
  assert.equal(repositoryPathFor('\0dsh-css:/x/y.module.css', 'packages/client/ui-chat'), undefined)
  assert.equal(repositoryPathFor('../../../../etc/passwd', 'packages/client/ui-chat'), undefined)
  // A package published from its own repository declares no `repository.directory`.
  assert.equal(repositoryPathFor('src/client/RestartAction.tsx'), 'src/client/RestartAction.tsx')
  assert.equal(repositoryPathFor('lib/types/client/Card.js'), 'src/client/Card.tsx')
})

test('normalizeRepository accepts every repository spelling npm allows', () => {
  const url = 'https://github.com/lovstudio/dsh-better-restart'
  assert.equal(normalizeRepository('git+https://github.com/lovstudio/dsh-better-restart.git'), url)
  assert.equal(normalizeRepository('git@github.com:lovstudio/dsh-better-restart.git'), url)
  assert.equal(normalizeRepository('ssh://git@github.com/lovstudio/dsh-better-restart.git'), url)
  assert.equal(normalizeRepository('github:lovstudio/dsh-better-restart'), url)
  assert.equal(normalizeRepository('lovstudio/dsh-better-restart'), url)
  assert.equal(normalizeRepository(undefined), undefined)
  assert.equal(normalizeRepository('not a repository'), undefined)
})

test('instrumentPublishedBundle points every package at its own repository and release', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inspector-'))
  const pkg = (id, manifest) => {
    const home = join(root, ...id.split('/'))
    mkdirSync(join(home, 'lib'), { recursive: true })
    writeFileSync(join(home, 'package.json'), JSON.stringify({ name: id, ...manifest }))
    return join(home, 'lib', 'client.js')
  }
  const paths = {
    '@deepseek-ai/dsh-client-ui-chat': pkg('@deepseek-ai/dsh-client-ui-chat', {
      version: '0.1.2-rc.1',
      repository: { url: `git+${HARNESS_REPOSITORY}.git`, directory: 'packages/client/ui-chat' },
    }),
    // A third-party plugin: own repository, own release tag, no `directory`.
    '@lovstudio/dsh-better-restart': pkg('@lovstudio/dsh-better-restart', {
      version: '0.1.4',
      repository: { url: 'git+https://github.com/lovstudio/dsh-better-restart.git' },
    }),
    // A plugin published without a repository cannot be linked anywhere.
    '@example/dsh-anonymous': pkg('@example/dsh-anonymous', { version: '1.0.0' }),
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
    '  id: "@lovstudio/dsh-better-restart",',
    '  factory: (require) => {',
    '    //#region src/client/RestartAction.tsx',
    '    const c = (0, react_jsx_runtime.jsx)("p", { id: "c" });',
    '  } });',
    'window.__ModuleLoader__.load({',
    '  id: "@example/dsh-anonymous",',
    '  factory: (require) => {',
    '    //#region src/client/Nowhere.tsx',
    '    const d = (0, react_jsx_runtime.jsx)("i", { id: "d" });',
    '  } });',
  ].join('\n')
  const path = '/plugins/??@deepseek-ai/dsh-client-ui-chat/client.js,@lovstudio/dsh-better-restart/client.js,@example/dsh-anonymous/client.js&rev=1'
  const out = instrumentPublishedBundle(bundle, modules, path, {
    harnessRepository: HARNESS_REPOSITORY,
    harnessRef: 'dsh-v0.1.2-rc.1',
  })
  const blob = `${HARNESS_REPOSITORY}/blob/dsh-v0.1.2-rc.1`
  assert.ok(out.includes(`"data-insp-path":"${blob}/packages/client/ui-chat/src/client/chat/Row.tsx:5:`))
  assert.ok(out.includes(`"data-insp-path":"${blob}/packages/core/session/src/surface.ts:7:`))
  assert.ok(out.includes('"data-insp-path":"https://github.com/lovstudio/dsh-better-restart/blob/v0.1.4/src/client/RestartAction.tsx:13:'))
  assert.doesNotMatch(out, /"data-insp-path":"[^"]*:i"/u)
})

test('instrumentPublishedBundle marks the classic React runtime but not document.createElement', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inspector-classic-'))
  const home = join(root, 'balance')
  mkdirSync(join(home, 'lib'), { recursive: true })
  writeFileSync(join(home, 'package.json'), JSON.stringify({
    name: '@lovstudio/dsh-account-balance',
    version: '0.1.3',
    repository: { url: 'git+https://github.com/lovstudio/dsh-account-balance.git' },
  }))
  const modules = { clientPath: () => join(home, 'lib', 'client.js') }
  const bundle = [
    '//#region src/client/AccountBalanceCard.ts',
    'const a = react.default.createElement("div", { className: "ab-bar" });',
    'const b = document.createElement("div", { is: "x" });',
  ].join('\n')
  const out = instrumentPublishedBundle(bundle, modules, '/plugins/??@lovstudio/dsh-account-balance/client.js&rev=1', {})
  assert.ok(out.includes('"data-insp-path":"https://github.com/lovstudio/dsh-account-balance/blob/v0.1.3/src/client/AccountBalanceCard.ts:2:'))
  assert.equal(out.match(/data-insp-path/gu).length, 1)
})

test('instrumentPublishedBundle honours per-package ref overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inspector-refs-'))
  const home = join(root, 'restart')
  mkdirSync(join(home, 'lib'), { recursive: true })
  writeFileSync(join(home, 'package.json'), JSON.stringify({
    name: '@lovstudio/dsh-better-restart',
    version: '0.1.4',
    repository: 'lovstudio/dsh-better-restart',
  }))
  const modules = { clientPath: () => join(home, 'lib', 'client.js') }
  const bundle = [
    '//#region src/client/RestartAction.tsx',
    'const c = (0, react_jsx_runtime.jsx)("p", { id: "c" });',
  ].join('\n')
  const out = instrumentPublishedBundle(bundle, modules, '/plugins/??@lovstudio/dsh-better-restart/client.js&rev=1', {
    refs: { '@lovstudio/dsh-better-restart': 'main' },
  })
  assert.ok(out.includes('"data-insp-path":"https://github.com/lovstudio/dsh-better-restart/blob/main/src/client/RestartAction.tsx:2:'))
})

test('injectOverlay inlines the overlay before </head> and routes plugin bundles through the proxy', () => {
  const html = '<!doctype html><html><head><title>x</title></head><body><script type="module" src="/plugins/??a/client.js"></script></body></html>'
  const out = injectOverlay(html, 'console.log("</script>")')
  assert.match(out, /<script>console\.log\("<\\\/script>"\)<\/script><\/head>/u)
  assert.match(out, /src="\/lovinsp-plugins\/plugins\/\?\?a\/client\.js"/u)
})

test('overlayScript keeps copy on the bare chord and reserves the meta key for GitHub', async () => {
  const out = await overlayScript({})
  assert.match(out, /inspector\.copyKeys = 'shiftKey,altKey';/u)
  assert.match(out, /inspector\.targetKeys = \(\/mac\|iphone\|ipad\|ipod\/i\.test\(navigator\.userAgent\)\) \? 'shiftKey,altKey,metaKey' : 'shiftKey,altKey,ctrlKey';/u)
  assert.match(out, /inspector\.defaultAction = "copy";/u)
  // Each marker carries its own package's blob URL, so the templates are bare.
  assert.match(out, /inspector\.target = '\{file\}';/u)
  assert.match(out, /inspector\.copy = '\{file\}';/u)
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
