/**
 * @lovstudio/dsh-frontend-inspector — production click-to-source for the DSH
 * Web surface without modifying the DeepSeek Harness checkout.
 *
 * The Host plugin starts a persistent Lovinsp/Vite build whose output lives
 * under DSH_HOME, serves that output on a named webServer route, and rewrites
 * only the shell asset tags in the authenticated index page. DSH keeps owning
 * boot-data injection and its official static fallback.
 * @module @lovstudio/dsh-frontend-inspector
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AnyMap, originalPositionFor } from '@jridgewell/trace-mapping'
import MagicString from 'magic-string'

/** Stable Cordis plugin name. */
export const name = 'frontend-inspector'

/** Named route prefix serving the instrumented shell. */
export const SHELL_PATH = '/lovinsp-shell'

/** Named route prefix instrumenting loader-delivered Client plugin bundles. */
export const PLUGIN_PATH = '/lovinsp-plugins'

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
  /** Clean DeepSeek Harness source checkout used as build input. */
  sourceRoot?: string
  /** Lovinsp bridge port search starting point. */
  port?: number
  /** Editor identifier accepted by Lovinsp (`vscode`, `cursor`, `webstorm`, etc.). */
  editor?: string
  /** Maximum time allowed for the first instrumented shell build. */
  startupTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  sourceRoot: z.string(),
  port: z.natural().max(65535).default(5678),
  editor: z.string().default('vscode'),
  startupTimeoutMs: z.natural().default(120_000),
})

/** Schema of the frontend-inspector settings section. */
export const INSPECTOR_SETTINGS_SCHEMA: z<InspectorSettings> = z.object({
  enabled: z.boolean().default(true),
})

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gz': 'application/gzip',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

interface RunnerMessage {
  type: 'ready' | 'failed'
  error?: string
}

interface ClientModulesReader {
  clientPath(id: string): string | undefined
}

function jsxCalleeName(callee: Record<string, unknown>): string | undefined {
  if (callee.type === 'SequenceExpression' && Array.isArray(callee.expressions)) {
    const last = callee.expressions.at(-1)
    return typeof last === 'object' && last !== null ? jsxCalleeName(last as Record<string, unknown>) : undefined
  }
  if (callee.type === 'ParenthesizedExpression') {
    const expression = callee.expression
    return typeof expression === 'object' && expression !== null
      ? jsxCalleeName(expression as Record<string, unknown>)
      : undefined
  }
  if (callee.type === 'Identifier' && typeof callee.name === 'string') return callee.name
  if (callee.type !== 'MemberExpression') return undefined
  const property = callee.property as Record<string, unknown> | undefined
  if (property?.type === 'Identifier' && typeof property.name === 'string') return property.name
  if (callee.computed === true && property?.type === 'StringLiteral' && typeof property.value === 'string') return property.value
  return undefined
}

function isJsxCallee(callee: Record<string, unknown>): boolean {
  const name = jsxCalleeName(callee)
  return name !== undefined && /^_?jsx(?:s|DEV)?(?:\$\d+)?$/u.test(name)
}

function domTag(node: Record<string, unknown> | undefined): string | undefined {
  if (node?.type === 'StringLiteral' && typeof node.value === 'string') return node.value
  if (node?.type !== 'TemplateLiteral' || !Array.isArray(node.expressions) || node.expressions.length !== 0) return undefined
  const quasi = Array.isArray(node.quasis) ? node.quasis[0] as Record<string, unknown> | undefined : undefined
  const value = quasi?.value as Record<string, unknown> | undefined
  return typeof value?.cooked === 'string' ? value.cooked : undefined
}

function hasInspectorPath(objectExpression: Record<string, unknown>): boolean {
  if (!Array.isArray(objectExpression.properties)) return false
  return objectExpression.properties.some((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return false
    const property = candidate as Record<string, unknown>
    if (property.type !== 'ObjectProperty') return false
    const key = property.key as Record<string, unknown> | undefined
    return (key?.type === 'Identifier' && key.name === 'data-insp-path')
      || (key?.type === 'StringLiteral' && key.value === 'data-insp-path')
  })
}

function walk(root: unknown, visit: (node: Record<string, unknown>) => void): void {
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const candidate = stack.pop()
    if (typeof candidate !== 'object' || candidate === null) continue
    const node = candidate as Record<string, unknown>
    if (typeof node.type === 'string') visit(node)
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'errors'].includes(key) || key.endsWith('Comments')) continue
      if (Array.isArray(value)) stack.push(...value)
      else if (typeof value === 'object' && value !== null) stack.push(value)
    }
  }
}

function packageIdFromPluginSource(source: string): string | undefined {
  if (!source.startsWith('/plugins/')) return undefined
  const parts = source.slice('/plugins/'.length).split('/')
  if (parts[0]?.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined
  return parts[0]
}

function localPluginSource(source: string, modules: ClientModulesReader, sectionId?: string): string {
  const id = sectionId ?? packageIdFromPluginSource(source)
  if (id === undefined) return source
  const clientPath = modules.clientPath(id)
  if (clientPath === undefined) return source
  const sourcePrefix = id.startsWith('@') ? `/plugins/${id.split('/')[0]}/` : '/plugins/'
  const exactPrefix = `/plugins/${id}/`
  const relative = source.startsWith(exactPrefix)
    ? source.slice(exactPrefix.length)
    : source.startsWith(sourcePrefix) ? source.slice(sourcePrefix.length) : source
  return resolve(join(clientPath, '..', '..'), relative)
}

function comboIds(path: string): string[] {
  const resources = path.split('??')[1]?.split('&rev=', 1)[0]
  if (resources === undefined) return []
  return resources.split(',').map(resource => resource.replace(/\/client\.js(?:\.map)?$/u, ''))
}

function sectionIdAtLine(sourceMap: unknown, line: number, ids: readonly string[]): string | undefined {
  if (typeof sourceMap !== 'object' || sourceMap === null) return undefined
  const sections = (sourceMap as { sections?: unknown }).sections
  if (!Array.isArray(sections)) return ids.length === 1 ? ids[0] : undefined
  let selected: number | undefined
  for (const [index, candidate] of sections.entries()) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const offset = (candidate as { offset?: { line?: unknown } }).offset
    if (typeof offset?.line !== 'number' || offset.line > line - 1) break
    selected = index
  }
  return selected === undefined ? undefined : ids[selected]
}

/** Add Lovinsp DOM markers to one loader combo script using its indexed map. */
function instrumentClientBundle(
  code: string,
  sourceMap: unknown,
  modules: ClientModulesReader,
  sourcePath: string,
): string {
  let ast: ReturnType<typeof parse>
  try {
    ast = parse(code, {
      sourceType: 'unambiguous',
      allowAwaitOutsideFunction: true,
      errorRecovery: true,
      plugins: ['importAttributes', 'jsx', 'typescript', 'topLevelAwait'],
    })
  } catch {
    return code
  }
  const map = AnyMap(sourceMap as Parameters<typeof AnyMap>[0], '')
  const ids = comboIds(sourcePath)
  const output = new MagicString(code)
  walk(ast, (node) => {
    if (node.type !== 'CallExpression' || !Array.isArray(node.arguments) || node.arguments.length < 2) return
    const callee = node.callee as Record<string, unknown> | undefined
    if (callee === undefined || !isJsxCallee(callee)) return
    const tag = domTag(node.arguments[0] as Record<string, unknown> | undefined)
    const props = node.arguments[1] as Record<string, unknown> | undefined
    if (tag === undefined || !/^[a-z][\w:.-]*$/u.test(tag) || props?.type !== 'ObjectExpression') return
    if (hasInspectorPath(props) || typeof props.start !== 'number') return
    const loc = node.loc as { start?: { line?: unknown, column?: unknown } } | undefined
    if (typeof loc?.start?.line !== 'number' || typeof loc.start.column !== 'number') return
    const original = originalPositionFor(map, { line: loc.start.line, column: loc.start.column })
    if (original.source === null || original.line === null || original.column === null) return
    const sectionId = sectionIdAtLine(sourceMap, loc.start.line, ids)
    const file = localPluginSource(original.source, modules, sectionId)
    const marker = `${file}:${String(original.line)}:${String(original.column + 1)}:${tag}`
    output.appendLeft(props.start + 1, `${JSON.stringify('data-insp-path')}:${JSON.stringify(marker)},`)
  })
  return output.toString()
}

async function fetchLocalAsset(port: number, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(port)}${path}`)
}

/** Proxy and instrument one client-module combo response. */
async function serveInstrumentedPlugin(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  modules: ClientModulesReader,
  cache: Map<string, Buffer>,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end()
    return
  }
  const raw = req.url ?? ''
  const originalPath = raw.startsWith(PLUGIN_PATH) ? raw.slice(PLUGIN_PATH.length) : ''
  if (!originalPath.startsWith('/plugins/')) {
    res.writeHead(404).end()
    return
  }
  let body = cache.get(originalPath)
  let contentType = 'text/javascript; charset=utf-8'
  if (body === undefined) {
    const original = await fetchLocalAsset(port, originalPath)
    if (!original.ok) {
      res.writeHead(original.status).end()
      return
    }
    contentType = original.headers.get('content-type') ?? contentType
    const source = await original.text()
    if (originalPath.includes('client.js.map')) {
      body = Buffer.from(source)
      contentType = 'application/json'
    } else {
      const mapPath = /\/\/# sourceMappingURL=([^\s]+)/u.exec(source)?.[1]
      if (mapPath === undefined) body = Buffer.from(source)
      else {
        const mapResponse = await fetchLocalAsset(port, mapPath)
        const transformed = mapResponse.ok
          ? instrumentClientBundle(source, JSON.parse(await mapResponse.text()), modules, originalPath)
          : source
        body = Buffer.from(transformed)
      }
    }
    if (cache.size >= 32) cache.clear()
    cache.set(originalPath, body)
  }
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' })
  res.end(req.method === 'HEAD' ? undefined : body)
}

/** Find a source checkout without embedding a machine-specific path in the bundle. */
function resolveSourceRoot(configured: string | undefined): string | undefined {
  const candidates = [configured, process.env.DSH_SOURCE_ROOT, process.cwd()]
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === '') continue
    const root = resolve(candidate)
    if (
      existsSync(join(root, 'apps/web/vite.config.ts'))
      && existsSync(join(root, 'apps/web/package.json'))
    ) return root
  }
  return undefined
}

/** DSH-owned cache location; build products never enter the source checkout. */
function resolveCacheRoot(): string {
  const dshHome = process.env.DSH_HOME === undefined || process.env.DSH_HOME === ''
    ? join(homedir(), '.dsh')
    : resolve(process.env.DSH_HOME)
  return join(dshHome, 'cache', 'frontend-inspector')
}

/** Start the persistent instrumented shell build and wait for its first output. */
async function startBuilder(config: Config, sourceRoot: string, cacheRoot: string): Promise<ChildProcess> {
  await mkdir(cacheRoot, { recursive: true })
  const runner = fileURLToPath(new URL('./runtime-build-runner.mjs', import.meta.url))
  const child = spawn(process.execPath, [runner, JSON.stringify({
    sourceRoot,
    cacheRoot,
    port: config.port ?? 5678,
    editor: config.editor ?? 'vscode',
  })], {
    cwd: cacheRoot,
    env: { ...process.env, LOVINSP: '1', NODE_ENV: 'production' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })

  try {
    await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error(`frontend-inspector: initial Lovinsp build exceeded ${String(config.startupTimeoutMs ?? 120_000)}ms`))
    }, config.startupTimeoutMs ?? 120_000)
    const finish = (callback: () => void): void => {
      clearTimeout(timeout)
      child.off('error', onError)
      child.off('exit', onExit)
      child.off('message', onMessage)
      callback()
    }
    const onError = (error: Error): void => { finish(() => { rejectReady(error) }) }
    const onExit = (code: number | null): void => {
      finish(() => { rejectReady(new Error(`frontend-inspector: Lovinsp builder exited before ready (code ${String(code)})`)) })
    }
    const onMessage = (message: unknown): void => {
      if (typeof message !== 'object' || message === null) return
      const row = message as RunnerMessage
      if (row.type === 'ready') finish(resolveReady)
      if (row.type === 'failed') finish(() => { rejectReady(new Error(row.error ?? 'frontend-inspector: Lovinsp build failed')) })
    }
    child.once('error', onError)
    child.once('exit', onExit)
    child.on('message', onMessage)
    })
  } catch (error) {
    child.kill('SIGTERM')
    throw error
  }
  return child
}

/** Stop one builder without leaving its Lovinsp bridge or Vite watcher alive. */
async function stopBuilder(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolveStopped) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      resolveStopped()
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolveStopped()
    })
    child.kill('SIGTERM')
  })
}

/** Serve one file from the external instrumented output. */
async function serveInstrumentedAsset(req: IncomingMessage, res: ServerResponse, distRoot: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end()
    return
  }
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  const relative = pathname.slice(SHELL_PATH.length).replace(/^\/+/, '')
  const target = resolve(normalize(join(distRoot, relative)))
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403).end()
    return
  }
  try {
    if (!(await stat(target)).isFile()) {
      res.writeHead(404).end()
      return
    }
    const body = await readFile(target)
    res.writeHead(200, {
      'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      res.writeHead(404).end()
      return
    }
    throw error
  }
}

/** Prefix relative URLs in one built tag with the plugin-owned shell route. */
function routeTag(tag: string): string {
  return tag.replace(/\b(src|href)=(['"])(\.\/)?([^'"]+)\2/gu, (_match, name, quote, _dot, value) =>
    `${String(name)}=${String(quote)}${SHELL_PATH}/${String(value).replace(/^\/+/, '')}${String(quote)}`)
}

/** Swap only Vite shell tags while retaining DSH's authenticated boot injections. */
export function injectInstrumentedShell(html: string, instrumentedIndex: string): string {
  const inlineModules = instrumentedIndex.match(/<script\b(?=[^>]*\btype=['"]module['"])(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/giu) ?? []
  const entry = instrumentedIndex.match(/<script\b(?=[^>]*\btype=['"]module['"])(?=[^>]*\bsrc=)[^>]*><\/script>/iu)?.[0]
  if (entry === undefined) throw new Error('frontend-inspector: instrumented index has no module entry')
  const preloads = instrumentedIndex.match(/<link\b(?=[^>]*\brel=['"]modulepreload['"])[^>]*>/giu) ?? []
  const styles = instrumentedIndex.match(/<link\b(?=[^>]*\brel=['"]stylesheet['"])[^>]*>/giu) ?? []
  const replacement = [...inlineModules, entry, ...preloads, ...styles].map(routeTag).join('')
  const shell = html
    .replace(/<link\b(?=[^>]*\brel=['"]modulepreload['"])[^>]*>/giu, '')
    .replace(/<link\b(?=[^>]*\brel=['"]stylesheet['"])[^>]*>/giu, '')
  let replaced = false
  const out = shell.replace(/<script\b(?=[^>]*\btype=['"]module['"])(?=[^>]*\bsrc=)[^>]*><\/script>/iu, () => {
    replaced = true
    return replacement
  })
  if (!replaced) throw new Error('frontend-inspector: DSH index has no module entry')
  return out.replaceAll('/plugins/', `${PLUGIN_PATH}/plugins/`)
}

/** Mount the build watcher, instrumented asset route, and authenticated index transform. */
export async function apply(ctx: Context, config: Config): Promise<void> {
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

  if (config.enabled === false) return
  const sourceRoot = resolveSourceRoot(config.sourceRoot)
  if (sourceRoot === undefined) {
    throw new Error('frontend-inspector: sourceRoot must name a clean DeepSeek Harness checkout (or launch dsh from that checkout)')
  }
  const cacheRoot = resolveCacheRoot()
  const distRoot = join(cacheRoot, 'dist')

  await ctx.effect(async () => {
    const builder = await startBuilder(config, sourceRoot, cacheRoot)
    return async () => { await stopBuilder(builder) }
  }, 'frontend-inspector: persistent Lovinsp shell build')

  ctx.inject(['webServer', 'clientModules'], (httpCtx) => {
    httpCtx.effect(() => {
      const modules = httpCtx.get('clientModules') as ClientModulesReader
      const pluginCache = new Map<string, Buffer>()
      const removeRoute = httpCtx.webServer.register({
        kind: 'prefix',
        path: SHELL_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
          await serveInstrumentedAsset(req, res, distRoot)
        },
      })
      const removePluginRoute = httpCtx.webServer.register({
        kind: 'prefix',
        path: PLUGIN_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
          await serveInstrumentedPlugin(req, res, httpCtx.webServer.port, modules, pluginCache)
        },
      })
      const removeTap = httpCtx.webServer.tapIndex((html) => {
        if (readSection().enabled !== true) return html
        return injectInstrumentedShell(html, readFileSync(join(distRoot, 'index.html'), 'utf8'))
      })
      return () => {
        removeRoute()
        removePluginRoute()
        removeTap()
      }
    }, 'frontend-inspector: instrumented shell route')
  })
}
