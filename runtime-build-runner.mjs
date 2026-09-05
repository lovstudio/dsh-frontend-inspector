import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from '@babel/parser'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import MagicString from 'magic-string'
import { lovinspPlugin } from 'lovinsp'

const raw = process.argv[2]
if (raw === undefined) throw new Error('frontend-inspector runner: missing configuration')
const options = JSON.parse(raw)
const sourceRoot = resolve(options.sourceRoot)
const cacheRoot = resolve(options.cacheRoot)
const appRoot = join(sourceRoot, 'apps', 'web')
const configFile = join(appRoot, 'vite.config.ts')
const outDir = join(cacheRoot, 'dist')

// Vite comes from the harness checkout (apps/web depends on it), not from
// this package: declaring it here would pull esbuild into the profile install,
// where pnpm 10+ refuses its install script and `dsh plugin add` aborts.
const { build, loadConfigFromFile } = await import(
  pathToFileURL(createRequire(join(appRoot, 'package.json')).resolve('vite')).href
)

await mkdir(cacheRoot, { recursive: true })
process.chdir(cacheRoot)

const environment = { command: 'build', mode: 'production', isSsrBuild: false, isPreview: false }
const loaded = await loadConfigFromFile(environment, configFile, appRoot, 'runner')
if (loaded === null) throw new Error(`frontend-inspector runner: cannot load ${configFile}`)
const base = loaded.config
const originalPlugins = (base.plugins ?? []).flat(Infinity).filter(Boolean)
  .filter(plugin => plugin.name !== 'dsh-emit-preview-page')

function jsxCalleeName(callee) {
  if (callee?.type === 'SequenceExpression') return jsxCalleeName(callee.expressions.at(-1))
  if (callee?.type === 'ParenthesizedExpression') return jsxCalleeName(callee.expression)
  if (callee?.type === 'Identifier') return callee.name
  if (callee?.type !== 'MemberExpression') return undefined
  if (!callee.computed && callee.property.type === 'Identifier') return callee.property.name
  if (callee.computed && callee.property.type === 'StringLiteral') return callee.property.value
  return undefined
}

function calleeObjectName(callee) {
  if (callee?.type !== 'MemberExpression') return undefined
  if (callee.object?.type === 'Identifier') return callee.object.name
  if (callee.object?.type === 'MemberExpression') return calleeObjectName(callee.object)
  return undefined
}

function isJsxCallee(callee) {
  const name = jsxCalleeName(callee)
  if (name === undefined) return false
  if (/^_?jsx(?:s|DEV)?(?:\$\d+)?$/.test(name)) return true
  return /^_?createElement(?:\$\d+)?$/.test(name) && calleeObjectName(callee) !== 'document'
}

function domTag(node) {
  if (node?.type === 'StringLiteral') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked
  }
  return undefined
}

function hasInspectorPath(objectExpression) {
  return objectExpression.properties.some(property => {
    if (property.type !== 'ObjectProperty') return false
    if (property.key.type === 'Identifier') return property.key.name === 'data-insp-path'
    if (property.key.type === 'StringLiteral') return property.key.value === 'data-insp-path'
    return false
  })
}

function walk(root, visit) {
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === null || typeof node !== 'object') continue
    if (typeof node.type === 'string') visit(node)
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'errors'].includes(key) || key.endsWith('Comments')) continue
      if (Array.isArray(value)) stack.push(...value)
      else if (value !== null && typeof value === 'object') stack.push(value)
    }
  }
}

function sourceLocator(moduleId) {
  const mapPath = `${moduleId}.map`
  if (!existsSync(mapPath)) {
    return (line, column) => ({ file: moduleId, line, column: column + 1 })
  }
  let map
  try {
    map = new TraceMap(JSON.parse(readFileSync(mapPath, 'utf8')))
  } catch {
    return (line, column) => ({ file: moduleId, line, column: column + 1 })
  }
  return (line, column) => {
    const original = originalPositionFor(map, { line, column })
    if (original.source === null || original.line === null || original.column === null) {
      return { file: moduleId, line, column: column + 1 }
    }
    return {
      file: resolve(dirname(mapPath), original.source),
      line: original.line,
      column: original.column + 1,
    }
  }
}

function compiledJsxSourcePlugin() {
  return {
    name: 'dsh-compiled-jsx-source-locations',
    enforce: 'post',
    transform(code, rawId) {
      const id = rawId.split('?', 1)[0]
      if (!id.startsWith(`${sourceRoot}/`) || !/\.(?:js|jsx|ts|tsx)$/.test(id)) return null
      if (!code.includes('jsx')) return null
      let ast
      try {
        ast = parse(code, {
          sourceType: 'module',
          allowAwaitOutsideFunction: true,
          errorRecovery: true,
          plugins: ['importAttributes', 'jsx', 'typescript', 'topLevelAwait'],
        })
      } catch {
        return null
      }
      const locate = sourceLocator(id)
      const output = new MagicString(code)
      let count = 0
      walk(ast, node => {
        if (node.type !== 'CallExpression' || !isJsxCallee(node.callee) || node.arguments.length < 2) return
        const tag = domTag(node.arguments[0])
        const props = node.arguments[1]
        if (tag === undefined || !/^[a-z][\w:.-]*$/.test(tag)) return
        if (props?.type !== 'ObjectExpression' || hasInspectorPath(props)) return
        if (node.loc === undefined || typeof props.start !== 'number') return
        const source = locate(node.loc.start.line, node.loc.start.column)
        const marker = `${source.file}:${String(source.line)}:${String(source.column)}:${tag}`
        output.appendLeft(props.start + 1, `${JSON.stringify('data-insp-path')}:${JSON.stringify(marker)},`)
        count += 1
      })
      if (count === 0) return null
      return { code: output.toString(), map: null }
    },
  }
}

const watcher = await build({
  ...base,
  configFile: false,
  root: appRoot,
  cacheDir: join(cacheRoot, 'vite-cache'),
  plugins: [
    lovinspPlugin({
      bundler: 'vite',
      dev: true,
      pathType: 'absolute',
      port: options.port,
      printServer: true,
      showSwitch: true,
      hideConsole: false,
      editor: options.editor,
      injectTo: join(appRoot, 'src', 'main.ts'),
      match: /$a/,
      skipSnippets: ['htmlScript'],
      behavior: { locate: true, copy: true, defaultAction: 'locate' },
    }),
    ...originalPlugins,
    compiledJsxSourcePlugin(),
  ],
  build: {
    ...base.build,
    outDir,
    emptyOutDir: true,
    sourcemap: false,
    watch: {},
  },
})

if (Array.isArray(watcher) || typeof watcher?.on !== 'function') {
  throw new Error('frontend-inspector runner: Vite did not return a persistent watcher')
}

let ready = false
watcher.on('event', event => {
  if (event.code === 'BUNDLE_END' && !ready) {
    ready = true
    process.send?.({ type: 'ready' })
  }
  if (event.code === 'ERROR' && !ready) {
    process.send?.({ type: 'failed', error: event.error?.message ?? String(event.error) })
  }
})

const stop = async () => {
  await watcher.close()
  process.exit(0)
}
process.once('SIGINT', () => { void stop() })
process.once('SIGTERM', () => { void stop() })
