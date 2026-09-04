import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
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
* The Host plugin starts a persistent Lovinsp/Vite build whose output lives
* under DSH_HOME, serves that output on a named webServer route, and rewrites
* only the shell asset tags in the authenticated index page. DSH keeps owning
* boot-data injection and its official static fallback.
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
const Config = z.object({
	enabled: z.boolean().default(true),
	sourceRoot: z.string(),
	port: z.natural().max(65535).default(5678),
	editor: z.string().default("vscode"),
	startupTimeoutMs: z.natural().default(12e4)
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
function isJsxCallee(callee) {
	const name = jsxCalleeName(callee);
	return name !== void 0 && /^_?jsx(?:s|DEV)?(?:\$\d+)?$/u.test(name);
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
/** Add Lovinsp DOM markers to one loader combo script using its indexed map. */
function instrumentClientBundle(code, sourceMap, modules, sourcePath) {
	let ast;
	try {
		ast = parse(code, {
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
		return code;
	}
	const map = AnyMap(sourceMap, "");
	const ids = comboIds(sourcePath);
	const output = new MagicString(code);
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
		const original = originalPositionFor(map, {
			line: loc.start.line,
			column: loc.start.column
		});
		if (original.source === null || original.line === null || original.column === null) return;
		const sectionId = sectionIdAtLine(sourceMap, loc.start.line, ids);
		const marker = `${localPluginSource(original.source, modules, sectionId)}:${String(original.line)}:${String(original.column + 1)}:${tag}`;
		output.appendLeft(props.start + 1, `${JSON.stringify("data-insp-path")}:${JSON.stringify(marker)},`);
	});
	return output.toString();
}
async function fetchLocalAsset(port, path) {
	return fetch(`http://127.0.0.1:${String(port)}${path}`);
}
/** Proxy and instrument one client-module combo response. */
async function serveInstrumentedPlugin(req, res, port, modules, cache) {
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
		} else {
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
	if (sourceRoot === void 0) throw new Error("frontend-inspector: sourceRoot must name a clean DeepSeek Harness checkout (or launch dsh from that checkout)");
	const cacheRoot = resolveCacheRoot();
	const distRoot = join(cacheRoot, "dist");
	await ctx.effect(async () => {
		const builder = await startBuilder(config, sourceRoot, cacheRoot);
		return async () => {
			await stopBuilder(builder);
		};
	}, "frontend-inspector: persistent Lovinsp shell build");
	ctx.inject(["webServer", "clientModules"], (httpCtx) => {
		httpCtx.effect(() => {
			const modules = httpCtx.get("clientModules");
			const pluginCache = /* @__PURE__ */ new Map();
			const removeRoute = httpCtx.webServer.register({
				kind: "prefix",
				path: SHELL_PATH,
				handler: async (req, res) => {
					await serveInstrumentedAsset(req, res, distRoot);
				}
			});
			const removePluginRoute = httpCtx.webServer.register({
				kind: "prefix",
				path: PLUGIN_PATH,
				handler: async (req, res) => {
					await serveInstrumentedPlugin(req, res, httpCtx.webServer.port, modules, pluginCache);
				}
			});
			const removeTap = httpCtx.webServer.tapIndex((html) => {
				if (readSection().enabled !== true) return html;
				return injectInstrumentedShell(html, readFileSync(join(distRoot, "index.html"), "utf8"));
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
export { Config, INSPECTOR_SETTINGS_NAMESPACE, INSPECTOR_SETTINGS_SCHEMA, PLUGIN_PATH, SHELL_PATH, apply, injectInstrumentedShell, name };
