import assert from 'node:assert/strict'
import test from 'node:test'

import { injectInstrumentedShell } from '../index.js'

test('retains instrumented styles and preloads after replacing the DSH shell', () => {
  const html = `<!doctype html><html><head>
    <link rel="modulepreload" href="/assets/vendor-old.js">
    <link rel="stylesheet" href="/assets/index-old.css">
    <script type="module" src="/assets/index-old.js"></script>
    <script type="module" src="/plugins/example/client.js"></script>
  </head><body><div id="root"></div></body></html>`
  const instrumentedIndex = `<!doctype html><html><head>
    <script type="module">globalThis.__instrumented = true</script>
    <script type="module" src="./assets/index-new.js"></script>
    <link rel="modulepreload" href="./assets/vendor-new.js">
    <link rel="stylesheet" href="./assets/index-new.css">
  </head><body></body></html>`

  const result = injectInstrumentedShell(html, instrumentedIndex)

  assert.match(result, /src="\/lovinsp-shell\/assets\/index-new\.js"/u)
  assert.match(result, /href="\/lovinsp-shell\/assets\/vendor-new\.js"/u)
  assert.match(result, /href="\/lovinsp-shell\/assets\/index-new\.css"/u)
  assert.match(result, /src="\/lovinsp-plugins\/plugins\/example\/client\.js"/u)
  assert.doesNotMatch(result, /(?:index|vendor)-old/u)
  assert.equal(result.match(/rel="modulepreload"/gu)?.length, 1)
  assert.equal(result.match(/rel="stylesheet"/gu)?.length, 1)
})
