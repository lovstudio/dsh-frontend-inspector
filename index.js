import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import z from "@deepseek-ai/schemastery";
import { AnyMap, originalPositionFor } from "@jridgewell/trace-mapping";
import MagicString from "magic-string";
//#region src/index.ts
/**
* @lovstudio/dsh-frontend-inspector — production click-to-source for the DSH
* Web surface without modifying the DeepSeek Harness checkout.
*
* Two modes, chosen at startup by whether a harness source checkout is found:
*
* - **checkout**: a persistent Lovinsp/Vite build of `apps/web` lives under
*   DSH_HOME, is served on a named webServer route, and only the shell asset
*   tags in the authenticated index page are swapped. Markers carry exact
*   TypeScript positions from source maps and clicks open the editor.
* - **npx** (no checkout, e.g. `npx @deepseek-ai/dsh`): nothing is rebuilt.
*   The Lovinsp overlay is inlined into the index page, plugin bundles are
*   marked from the `//#region` file markers tsdown leaves in the published
*   `lib/client.js`, and a click opens the file on GitHub at the installed
*   harness version. File-level only: published packages ship no source maps.
*
* DSH keeps owning boot-data injection and its official static fallback.
* @module @lovstudio/dsh-frontend-inspector
*/
/** Stable Cordis plugin name. */
const name = "frontend-inspector";
/** Named route prefix serving the instrumented shell. */
const SHELL_PATH = "/lovinsp-shell";
/** Named route prefix instrumenting loader-delivered Client plugin bundles. */
const PLUGIN_PATH = "/lovinsp-plugins";
/** Settings namespace carrying the frontend inspector's enable switch. */
const INSPECTOR_SETTINGS_NAMESPACE = "frontend-inspector";
/** Where the published harness packages come from; `repository.url` in their manifests. */
const HARNESS_REPOSITORY = "https://github.com/deepseek-ai/deepseek-harness";
const Config = z.object({
	enabled: z.boolean().default(true),
	sourceRoot: z.string(),
	port: z.natural().max(65535).default(5678),
	editor: z.string().default("vscode"),
	startupTimeoutMs: z.natural().default(12e4),
	repository: z.string().default(HARNESS_REPOSITORY),
	sourceRef: z.string(),
	refs: z.dict(z.string()).default({})
});
/** Schema of the frontend-inspector settings section. */
const INSPECTOR_SETTINGS_SCHEMA = z.object({ enabled: z.boolean().default(true) });
const MIME = {
	".css": "text/css; charset=utf-8",
	".gz": "application/gzip",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json",
	".map": "application/json",
	".svg": "image/svg+xml",
	".ttf": "font/ttf",
	".webmanifest": "application/manifest+json",
	".woff": "font/woff",
	".woff2": "font/woff2"
};
function jsxCalleeName(callee) {
	if (callee.type === "SequenceExpression" && Array.isArray(callee.expressions)) {
		const last = callee.expressions.at(-1);
		return typeof last === "object" && last !== null ? jsxCalleeName(last) : void 0;
	}
	if (callee.type === "ParenthesizedExpression") {
		const expression = callee.expression;
		return typeof expression === "object" && expression !== null ? jsxCalleeName(expression) : void 0;
	}
	if (callee.type === "Identifier" && typeof callee.name === "string") return callee.name;
	if (callee.type !== "MemberExpression") return void 0;
	const property = callee.property;
	if (property?.type === "Identifier" && typeof property.name === "string") return property.name;
	if (callee.computed === true && property?.type === "StringLiteral" && typeof property.value === "string") return property.value;
}
/** The receiver of `x.y.createElement(...)`, which tells React apart from the DOM. */
function calleeObjectName(callee) {
	if (callee.type !== "MemberExpression") return void 0;
	const object = callee.object;
	if (object?.type === "Identifier" && typeof object.name === "string") return object.name;
	if (object?.type === "MemberExpression") return calleeObjectName(object);
}
function isJsxCallee(callee) {
	const name = jsxCalleeName(callee);
	if (name === void 0) return false;
	if (/^_?jsx(?:s|DEV)?(?:\$\d+)?$/u.test(name)) return true;
	return /^_?createElement(?:\$\d+)?$/u.test(name) && calleeObjectName(callee) !== "document";
}
function domTag(node) {
	if (node?.type === "StringLiteral" && typeof node.value === "string") return node.value;
	if (node?.type !== "TemplateLiteral" || !Array.isArray(node.expressions) || node.expressions.length !== 0) return void 0;
	const value = (Array.isArray(node.quasis) ? node.quasis[0] : void 0)?.value;
	return typeof value?.cooked === "string" ? value.cooked : void 0;
}
function hasInspectorPath(objectExpression) {
	if (!Array.isArray(objectExpression.properties)) return false;
	return objectExpression.properties.some((candidate) => {
		if (typeof candidate !== "object" || candidate === null) return false;
		const property = candidate;
		if (property.type !== "ObjectProperty") return false;
		const key = property.key;
		return key?.type === "Identifier" && key.name === "data-insp-path" || key?.type === "StringLiteral" && key.value === "data-insp-path";
	});
}
function walk(root, visit) {
	const stack = [root];
	while (stack.length > 0) {
		const candidate = stack.pop();
		if (typeof candidate !== "object" || candidate === null) continue;
		const node = candidate;
		if (typeof node.type === "string") visit(node);
		for (const [key, value] of Object.entries(node)) {
			if ([
				"loc",
				"start",
				"end",
				"errors"
			].includes(key) || key.endsWith("Comments")) continue;
			if (Array.isArray(value)) stack.push(...value);
			else if (typeof value === "object" && value !== null) stack.push(value);
		}
	}
}
function packageIdFromPluginSource(source) {
	if (!source.startsWith("/plugins/")) return void 0;
	const parts = source.slice(9).split("/");
	if (parts[0]?.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : void 0;
	return parts[0];
}
function localPluginSource(source, modules, sectionId) {
	const id = sectionId ?? packageIdFromPluginSource(source);
	if (id === void 0) return source;
	const clientPath = modules.clientPath(id);
	if (clientPath === void 0) return source;
	const sourcePrefix = id.startsWith("@") ? `/plugins/${id.split("/")[0]}/` : "/plugins/";
	const exactPrefix = `/plugins/${id}/`;
	const relative = source.startsWith(exactPrefix) ? source.slice(exactPrefix.length) : source.startsWith(sourcePrefix) ? source.slice(sourcePrefix.length) : source;
	return resolve(join(clientPath, "..", ".."), relative);
}
function comboIds(path) {
	const resources = path.split("??")[1]?.split("&rev=", 1)[0];
	if (resources === void 0) return [];
	return resources.split(",").map((resource) => resource.replace(/\/client\.js(?:\.map)?$/u, ""));
}
function sectionIdAtLine(sourceMap, line, ids) {
	if (typeof sourceMap !== "object" || sourceMap === null) return void 0;
	const sections = sourceMap.sections;
	if (!Array.isArray(sections)) return ids.length === 1 ? ids[0] : void 0;
	let selected;
	for (const [index, candidate] of sections.entries()) {
		if (typeof candidate !== "object" || candidate === null) continue;
		const offset = candidate.offset;
		if (typeof offset?.line !== "number" || offset.line > line - 1) break;
		selected = index;
	}
	return selected === void 0 ? void 0 : ids[selected];
}
/**
* Normalize any `repository` spelling npm accepts — `git+https://…​.git`,
* `git@host:owner/repo`, `github:owner/repo`, bare `owner/repo` — to the plain
* `https://host/owner/repo` a browser can open.
* @param url - the manifest's `repository` string or `repository.url`.
*/
function normalizeRepository(url) {
	if (url === void 0 || url === "") return void 0;
	const shorthand = /^(?:github:)?([\w.-]+)\/([\w.-]+)$/u.exec(url);
	const plain = shorthand === null ? url.replace(/^git\+/u, "").replace(/\.git$/u, "").replace(/\/$/u, "") : `https://github.com/${shorthand[1]}/${shorthand[2]}`;
	const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/u.exec(plain);
	const https = ssh === null ? plain : `https://${ssh[1]}/${ssh[2]}`;
	return /^https:\/\/[^/]+\/[^/]+\/[^/]+/u.test(https) ? https : void 0;
}
/** Read `repository.url` / `repository.directory` of the package serving `id`. */
function packageOrigin(modules, id, cache) {
	const cached = cache.get(id);
	if (cached !== void 0) return cached;
	let origin = {};
	const clientPath = modules.clientPath(id);
	if (clientPath !== void 0) try {
		const manifest = JSON.parse(readFileSync(join(clientPath, "..", "..", "package.json"), "utf8"));
		const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
		origin = {
			name: manifest.name,
			version: manifest.version,
			repository: normalizeRepository(repository),
			directory: typeof manifest.repository === "object" ? manifest.repository?.directory : void 0
		};
	} catch {}
	cache.set(id, origin);
	return origin;
}
/**
* Every match of a global `pattern` (one capture group) with the 1-based line
* it starts on; multi-line matches such as a loader call whose `id:` sits on
* the next line anchor to their first line.
*/
function scanCode(code, pattern) {
	const anchors = [];
	let line = 1;
	let scanned = 0;
	for (const match of code.matchAll(pattern)) {
		const value = match[1];
		if (value === void 0) continue;
		for (let i = scanned; i < match.index; i++) if (code.charCodeAt(i) === 10) line++;
		scanned = match.index;
		anchors.push({
			line,
			value
		});
	}
	return anchors;
}
/** The last anchor at or before `line`. */
function anchorAt(anchors, line) {
	let found;
	for (const anchor of anchors) {
		if (anchor.line > line) break;
		found = anchor.value;
	}
	return found;
}
/**
* Map one tsdown `//#region` marker of a published bundle onto a path inside
* the package's repository. Own files appear as tsc output (`lib/types/…/x.js`),
* so they go back to `src/…/x.tsx` — the marker sits on a JSX call, hence the
* extension; cross-package files appear relative to the package directory.
* @param region - the marker text after `//#region `.
* @param directory - `repository.directory` of the package; a package published
* from its own repository has none, so its files sit at the repository root.
* @returns the repository-relative file, or undefined for CSS modules and escapes.
*/
function repositoryPathFor(region, directory = "") {
	if (region.startsWith("\0") || region.includes("\\0")) return void 0;
	const own = /^(?:\.\/)?lib\/types\/(.+)\.js$/u.exec(region);
	const relative = own === null ? region : `src/${own[1]}.tsx`;
	const path = posix.normalize(posix.join(directory, relative));
	return path.startsWith("..") || path.startsWith("/") ? void 0 : path;
}
/**
* The git ref one package's markers point at: the harness keeps its own
* `dsh-v…` tag, every other package follows the `v<version>` tag that npm
* release workflows push next to the published version, and `refs` overrides
* both. Undefined means the package cannot be linked and stays unmarked.
*/
function refFor(origin, options) {
	const override = origin.name === void 0 ? void 0 : options.refs?.[origin.name];
	if (override !== void 0) return override;
	if (origin.repository !== void 0 && origin.repository === options.harnessRepository) return options.harnessRef;
	return origin.version === void 0 ? void 0 : `v${origin.version}`;
}
/** Parse one combo script; undefined when Babel cannot recover a tree. */
function parseBundle(code) {
	try {
		return parse(code, {
			sourceType: "unambiguous",
			allowAwaitOutsideFunction: true,
			errorRecovery: true,
			plugins: [
				"importAttributes",
				"jsx",
				"typescript",
				"topLevelAwait"
			]
		});
	} catch {
		return;
	}
}
/** Visit every host-DOM JSX call of a parsed bundle with its start position. */
function eachDomJsxCall(ast, visit) {
	walk(ast, (node) => {
		if (node.type !== "CallExpression" || !Array.isArray(node.arguments) || node.arguments.length < 2) return;
		const callee = node.callee;
		if (callee === void 0 || !isJsxCallee(callee)) return;
		const tag = domTag(node.arguments[0]);
		const props = node.arguments[1];
		if (tag === void 0 || !/^[a-z][\w:.-]*$/u.test(tag) || props?.type !== "ObjectExpression") return;
		if (hasInspectorPath(props) || typeof props.start !== "number") return;
		const loc = node.loc;
		if (typeof loc?.start?.line !== "number" || typeof loc.start.column !== "number") return;
		visit({
			tag,
			propsStart: props.start,
			line: loc.start.line,
			column: loc.start.column
		});
	});
}
const MARKER_ATTRIBUTE = JSON.stringify("data-insp-path");
/** Add Lovinsp DOM markers to one loader combo script using its indexed map (checkout mode). */
function instrumentClientBundle(code, sourceMap, modules, sourcePath) {
	const ast = parseBundle(code);
	if (ast === void 0) return code;
	const map = AnyMap(sourceMap, "");
	const ids = comboIds(sourcePath);
	const output = new MagicString(code);
	eachDomJsxCall(ast, ({ tag, propsStart, line, column }) => {
		const original = originalPositionFor(map, {
			line,
			column
		});
		if (original.source === null || original.line === null || original.column === null) return;
		const sectionId = sectionIdAtLine(sourceMap, line, ids);
		const marker = `${localPluginSource(original.source, modules, sectionId)}:${String(original.line)}:${String(original.column + 1)}:${tag}`;
		output.appendLeft(propsStart + 1, `${MARKER_ATTRIBUTE}:${JSON.stringify(marker)},`);
	});
	return output.toString();
}
/**
* Add Lovinsp DOM markers to one loader combo script from its `//#region`
* markers (npx mode): the file is exact, the compiled line is not, so the
* marker carries a whole `…/blob/<ref>/<file>` URL and no line.
*
* Every package that declares a `repository` and an installed version is
* marked, each pointing at its own release — the combo script mixes harness
* packages with third-party plugins, and a single repository would send most
* clicks to the wrong project.
*/
function instrumentPublishedBundle(code, modules, sourcePath, options = {}) {
	const ast = parseBundle(code);
	if (ast === void 0) return code;
	const ids = comboIds(sourcePath);
	const sections = scanCode(code, /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/gu);
	const regions = scanCode(code, /^[ \t]*\/\/#region (.+?)[ \t]*$/gmu);
	const origins = options.origins ?? /* @__PURE__ */ new Map();
	const output = new MagicString(code);
	eachDomJsxCall(ast, ({ tag, propsStart, line, column }) => {
		const sectionId = anchorAt(sections, line) ?? (ids.length === 1 ? ids[0] : void 0);
		if (sectionId === void 0) return;
		const origin = packageOrigin(modules, sectionId, origins);
		if (origin.repository === void 0) return;
		const ref = refFor(origin, options);
		if (ref === void 0) return;
		const region = anchorAt(regions, line);
		if (region === void 0) return;
		const file = repositoryPathFor(region, origin.directory);
		if (file === void 0) return;
		const marker = `${origin.repository}/blob/${ref}/${file}:${String(line)}:${String(column + 1)}:${tag}`;
		output.appendLeft(propsStart + 1, `${MARKER_ATTRIBUTE}:${JSON.stringify(marker)},`);
	});
	return output.toString();
}
async function fetchLocalAsset(port, path) {
	return fetch(`http://127.0.0.1:${String(port)}${path}`);
}
/** Proxy and instrument one client-module combo response. */
async function serveInstrumentedPlugin(req, res, port, modules, cache, mode) {
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405).end();
		return;
	}
	const raw = req.url ?? "";
	const originalPath = raw.startsWith("/lovinsp-plugins") ? raw.slice(16) : "";
	if (!originalPath.startsWith("/plugins/")) {
		res.writeHead(404).end();
		return;
	}
	let body = cache.get(originalPath);
	let contentType = "text/javascript; charset=utf-8";
	if (body === void 0) {
		const original = await fetchLocalAsset(port, originalPath);
		if (!original.ok) {
			res.writeHead(original.status).end();
			return;
		}
		contentType = original.headers.get("content-type") ?? contentType;
		const source = await original.text();
		if (originalPath.includes("client.js.map")) {
			body = Buffer.from(source);
			contentType = "application/json";
		} else if (mode.kind === "npx") body = Buffer.from(instrumentPublishedBundle(source, modules, originalPath, mode.marks));
		else {
			const mapPath = /\/\/# sourceMappingURL=([^\s]+)/u.exec(source)?.[1];
			if (mapPath === void 0) body = Buffer.from(source);
			else {
				const mapResponse = await fetchLocalAsset(port, mapPath);
				const transformed = mapResponse.ok ? instrumentClientBundle(source, JSON.parse(await mapResponse.text()), modules, originalPath) : source;
				body = Buffer.from(transformed);
			}
		}
		if (cache.size >= 32) cache.clear();
		cache.set(originalPath, body);
	}
	res.writeHead(200, {
		"Content-Type": contentType,
		"Cache-Control": "no-cache"
	});
	res.end(req.method === "HEAD" ? void 0 : body);
}
/** Find a source checkout without embedding a machine-specific path in the bundle. */
function resolveSourceRoot(configured) {
	const candidates = [
		configured,
		process.env.DSH_SOURCE_ROOT,
		process.cwd()
	];
	for (const candidate of candidates) {
		if (candidate === void 0 || candidate === "") continue;
		const root = resolve(candidate);
		if (existsSync(join(root, "apps/web/vite.config.ts")) && existsSync(join(root, "apps/web/package.json"))) return root;
	}
}
/** DSH-owned cache location; build products never enter the source checkout. */
function resolveCacheRoot() {
	const dshHome = process.env.DSH_HOME === void 0 || process.env.DSH_HOME === "" ? join(homedir(), ".dsh") : resolve(process.env.DSH_HOME);
	return join(dshHome, "cache", "frontend-inspector");
}
/** Start the persistent instrumented shell build and wait for its first output. */
async function startBuilder(config, sourceRoot, cacheRoot) {
	await mkdir(cacheRoot, { recursive: true });
	const runner = fileURLToPath(new URL("./runtime-build-runner.mjs", import.meta.url));
	const child = spawn(process.execPath, [runner, JSON.stringify({
		sourceRoot,
		cacheRoot,
		port: config.port ?? 5678,
		editor: config.editor ?? "vscode"
	})], {
		cwd: cacheRoot,
		env: {
			...process.env,
			LOVINSP: "1",
			NODE_ENV: "production"
		},
		stdio: [
			"ignore",
			"inherit",
			"inherit",
			"ipc"
		]
	});
	try {
		await new Promise((resolveReady, rejectReady) => {
			const timeout = setTimeout(() => {
				rejectReady(/* @__PURE__ */ new Error(`frontend-inspector: initial Lovinsp build exceeded ${String(config.startupTimeoutMs ?? 12e4)}ms`));
			}, config.startupTimeoutMs ?? 12e4);
			const finish = (callback) => {
				clearTimeout(timeout);
				child.off("error", onError);
				child.off("exit", onExit);
				child.off("message", onMessage);
				callback();
			};
			const onError = (error) => {
				finish(() => {
					rejectReady(error);
				});
			};
			const onExit = (code) => {
				finish(() => {
					rejectReady(/* @__PURE__ */ new Error(`frontend-inspector: Lovinsp builder exited before ready (code ${String(code)})`));
				});
			};
			const onMessage = (message) => {
				if (typeof message !== "object" || message === null) return;
				const row = message;
				if (row.type === "ready") finish(resolveReady);
				if (row.type === "failed") finish(() => {
					rejectReady(new Error(row.error ?? "frontend-inspector: Lovinsp build failed"));
				});
			};
			child.once("error", onError);
			child.once("exit", onExit);
			child.on("message", onMessage);
		});
	} catch (error) {
		child.kill("SIGTERM");
		throw error;
	}
	return child;
}
/** Stop one builder without leaving its Lovinsp bridge or Vite watcher alive. */
async function stopBuilder(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise((resolveStopped) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			resolveStopped();
		}, 5e3);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveStopped();
		});
		child.kill("SIGTERM");
	});
}
/** Serve one file from the external instrumented output. */
async function serveInstrumentedAsset(req, res, distRoot) {
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405).end();
		return;
	}
	const relative = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname).slice(14).replace(/^\/+/, "");
	const target = resolve(normalize(join(distRoot, relative)));
	if (target !== distRoot && !target.startsWith(distRoot + sep)) {
		res.writeHead(403).end();
		return;
	}
	try {
		if (!(await stat(target)).isFile()) {
			res.writeHead(404).end();
			return;
		}
		const body = await readFile(target);
		res.writeHead(200, {
			"Content-Type": MIME[extname(target)] ?? "application/octet-stream",
			"Cache-Control": "no-cache"
		});
		res.end(req.method === "HEAD" ? void 0 : body);
	} catch (error) {
		if (error.code === "ENOENT") {
			res.writeHead(404).end();
			return;
		}
		throw error;
	}
}
/** Prefix relative URLs in one built tag with the plugin-owned shell route. */
function routeTag(tag) {
	return tag.replace(/\b(src|href)=(['"])(\.\/)?([^'"]+)\2/gu, (_match, name, quote, _dot, value) => `${String(name)}=${String(quote)}${SHELL_PATH}/${String(value).replace(/^\/+/, "")}${String(quote)}`);
}
/** Swap only Vite shell tags while retaining DSH's authenticated boot injections. */
function injectInstrumentedShell(html, instrumentedIndex) {
	const inlineModules = instrumentedIndex.match(/<script\b(?=[^>]*\btype=['"]module['"])(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/giu) ?? [];
	const entry = instrumentedIndex.match(/<script\b(?=[^>]*\btype=['"]module['"])(?=[^>]*\bsrc=)[^>]*><\/script>/iu)?.[0];
	if (entry === void 0) throw new Error("frontend-inspector: instrumented index has no module entry");
	const preloads = instrumentedIndex.match(/<link\b(?=[^>]*\brel=['"]modulepreload['"])[^>]*>/giu) ?? [];
	const styles = instrumentedIndex.match(/<link\b(?=[^>]*\brel=['"]stylesheet['"])[^>]*>/giu) ?? [];
	const replacement = [
		...inlineModules,
		entry,
		...preloads,
		...styles
	].map(routeTag).join("");
	const shell = html.replace(/<link\b(?=[^>]*\brel=['"]modulepreload['"])[^>]*>/giu, "").replace(/<link\b(?=[^>]*\brel=['"]stylesheet['"])[^>]*>/giu, "");
	let replaced = false;
	const out = shell.replace(/<script\b(?=[^>]*\btype=['"]module['"])(?=[^>]*\bsrc=)[^>]*><\/script>/iu, () => {
		replaced = true;
		return replacement;
	});
	if (!replaced) throw new Error("frontend-inspector: DSH index has no module entry");
	return out.replaceAll("/plugins/", `${PLUGIN_PATH}/plugins/`);
}
/**
* npx mode: keep DSH's own shell, inline the Lovinsp overlay ahead of it, and
* route plugin bundles through the marking proxy.
* @param html - the authenticated DSH index page.
* @param overlayScript - the self-contained script `@lovinsp/core` generates.
*/
function injectOverlay(html, overlayScript) {
	const tag = `<script>${overlayScript.replaceAll("<\/script", "<\\/script")}<\/script>`;
	return (/<\/head>/iu.test(html) ? html.replace(/<\/head>/iu, `${tag}</head>`) : `${tag}${html}`).replaceAll("/plugins/", `${PLUGIN_PATH}/plugins/`);
}
/**
* The git ref matching the running harness: `dsh-v<version>` of the
* `@deepseek-ai/dsh` package that launched this process, else `master`.
* @param entry - the launcher script; defaults to `process.argv[1]`.
*/
function detectHarnessRef(entry = process.argv[1]) {
	let dir;
	if (entry !== void 0) try {
		dir = dirname(realpathSync(entry));
	} catch {
		dir = dirname(resolve(entry));
	}
	while (dir !== void 0) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) try {
			const parsed = JSON.parse(readFileSync(manifest, "utf8"));
			if (parsed.name === "@deepseek-ai/dsh" && typeof parsed.version === "string") return `dsh-v${parsed.version}`;
		} catch {}
		const parent = dirname(dir);
		dir = parent === dir ? void 0 : parent;
	}
	return "master";
}
/**
* Build the inlined overlay for npx mode: copy the source URL or open it on
* GitHub, never a local editor. Each marker already holds the full
* `…/blob/<ref>/<file>` URL of its own package, so both actions are `{file}`
* — the compiled line would point at the wrong place in the source file and
* is deliberately left out.
*/
async function overlayScript(config) {
	const { getWebComponentCode } = await import("@lovinsp/core");
	const port = config.port ?? 5678;
	return getWebComponentCode({
		bundler: "vite",
		port,
		showSwitch: true,
		hideConsole: false,
		editor: config.editor,
		behavior: {
			locate: false,
			copy: "{file}",
			target: "{file}",
			defaultAction: "copy",
			keys: {
				copy: ["shiftKey", "altKey"],
				target: [
					"shiftKey",
					"altKey",
					"metaKey"
				]
			}
		},
		sourcePriority: [{
			match: "ui-renderer/src/client/scoped-slots",
			priority: -1
		}]
	}, port).replace(/inspector\.targetKeys = '[^']*';/u, `inspector.targetKeys = (/mac|iphone|ipad|ipod/i.test(navigator.userAgent)) ? 'shiftKey,altKey,metaKey' : 'shiftKey,altKey,ctrlKey';`) + hintBadge();
}
/**
* A one-off transient hint naming the chords, since the overlay itself shows
* nothing until the keys are held — first-time users otherwise assume the
* plugin is inert. Non-interactive and self-retiring so it can never swallow a
* click or sit on top of the app chrome.
*/
function hintBadge() {
	return `
;(function () {
  if (typeof document === 'undefined') return
  var key = 'frontend-inspector.hint-shown'
  try { if (localStorage.getItem(key) === '1') return } catch (_e) {}
  function mount() {
    try { localStorage.setItem(key, '1') } catch (_e) {}
    var badge = document.createElement('div')
    badge.textContent = /mac|iphone|ipad|ipod/i.test(navigator.userAgent) ? ${JSON.stringify("源码定位 · 按住 ⇧⌥ 点击复制源码链接，再加 ⌘ 在 GitHub 打开")} : ${JSON.stringify("源码定位 · 按住 Shift+Alt 点击复制源码链接，再加 Ctrl 在 GitHub 打开")}
    badge.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483646;font:12px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;color:#181818;background:#F0EEE6;border:1px solid #E8E6DC;border-radius:8px;padding:6px 10px;box-shadow:0 1px 2px rgba(0,0,0,.06);pointer-events:none;user-select:none;opacity:0;transition:opacity .25s ease'
    document.body.appendChild(badge)
    requestAnimationFrame(function () { badge.style.opacity = '1' })
    setTimeout(function () {
      badge.style.opacity = '0'
      setTimeout(function () { badge.remove() }, 300)
    }, 6000)
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount)
})();
`;
}
/** Mount the build watcher, instrumented asset route, and authenticated index transform. */
async function apply(ctx, config) {
	let readSection = () => ({ enabled: config.enabled ?? true });
	ctx.inject(["settings"], (sctx) => {
		const scope = sctx.settings.register(INSPECTOR_SETTINGS_NAMESPACE, INSPECTOR_SETTINGS_SCHEMA, { base: { enabled: config.enabled ?? true } });
		readSection = () => scope.get();
		scope.watch(() => {});
	});
	if (config.enabled === false) return;
	const sourceRoot = resolveSourceRoot(config.sourceRoot);
	const cacheRoot = resolveCacheRoot();
	const distRoot = join(cacheRoot, "dist");
	let mode;
	let overlay = "";
	if (sourceRoot === void 0) {
		const harnessRepository = (config.repository ?? "https://github.com/deepseek-ai/deepseek-harness").replace(/\/$/u, "");
		const harnessRef = config.sourceRef ?? detectHarnessRef();
		mode = {
			kind: "npx",
			marks: {
				harnessRepository,
				harnessRef,
				refs: config.refs,
				origins: /* @__PURE__ */ new Map()
			}
		};
		overlay = await overlayScript(config);
		console.info(`frontend-inspector: no harness checkout found, marking published bundles; every plugin links to its own repository, the harness to ${harnessRepository}/blob/${harnessRef}`);
	} else {
		mode = { kind: "checkout" };
		await ctx.effect(async () => {
			const builder = await startBuilder(config, sourceRoot, cacheRoot);
			return async () => {
				await stopBuilder(builder);
			};
		}, "frontend-inspector: persistent Lovinsp shell build");
	}
	ctx.inject(["webServer", "clientModules"], (httpCtx) => {
		httpCtx.effect(() => {
			const modules = httpCtx.get("clientModules");
			const pluginCache = /* @__PURE__ */ new Map();
			const removeRoute = mode.kind === "checkout" ? httpCtx.webServer.register({
				kind: "prefix",
				path: SHELL_PATH,
				handler: async (req, res) => {
					await serveInstrumentedAsset(req, res, distRoot);
				}
			}) : () => {};
			const removePluginRoute = httpCtx.webServer.register({
				kind: "prefix",
				path: PLUGIN_PATH,
				handler: async (req, res) => {
					await serveInstrumentedPlugin(req, res, httpCtx.webServer.port, modules, pluginCache, mode);
				}
			});
			const removeTap = httpCtx.webServer.tapIndex((html) => {
				if (readSection().enabled !== true) return html;
				return mode.kind === "checkout" ? injectInstrumentedShell(html, readFileSync(join(distRoot, "index.html"), "utf8")) : injectOverlay(html, overlay);
			});
			return () => {
				removeRoute();
				removePluginRoute();
				removeTap();
			};
		}, "frontend-inspector: instrumented shell route");
	});
}
//#endregion
export { Config, HARNESS_REPOSITORY, INSPECTOR_SETTINGS_NAMESPACE, INSPECTOR_SETTINGS_SCHEMA, PLUGIN_PATH, SHELL_PATH, apply, detectHarnessRef, injectInstrumentedShell, injectOverlay, instrumentPublishedBundle, name, normalizeRepository, overlayScript, repositoryPathFor };
