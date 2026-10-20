/**
 * Offline test for the dsh-pomodoro Host half.
 *
 * Exercises the real route handler with fake node HTTP requests: the trust
 * fence (loopback vs foreign Host, cross-site marker, Origin mismatch), the
 * JSON content-type and body limits, revision monotonicity, and atomic writes
 * into a throwaway DSH_HOME.
 *
 * Run: node tests/host-api.cjs
 */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-pomodoro-home-"));
process.env.DSH_HOME = HOME;

const plugin = require(path.join(__dirname, "..", "dsh-pomodoro", "index.js"));

// ── fakes ───────────────────────────────────────────────────────────────────

/** One fake request: an EventEmitter whose body is emitted on read. */
function makeRequest({ method = "POST", headers = {}, body = "" }) {
	const req = new EventEmitter();
	req.method = method;
	req.headers = headers;
	req.destroy = () => {};
	if (body !== undefined) {
		// Emit on the next turn so the handler has attached its listeners.
		setImmediate(() => {
			if (body.length > 0) req.emit("data", Buffer.from(body));
			req.emit("end");
		});
	}
	return req;
}

/** One fake response capturing status and JSON body. */
function makeResponse() {
	const res = {
		status: 0,
		headers: {},
		payload: undefined,
		writeHead(status, headers) {
			res.status = status;
			res.headers = headers || {};
		},
		end(text) {
			res.payload = text === undefined ? undefined : JSON.parse(text);
		},
	};
	return res;
}

/** Register the plugin against a fake host context and return the route handler. */
function mount() {
	let route = null;
	const effects = [];
	const ctx = {
		effect(factory) {
			effects.push(factory());
			return () => {};
		},
		get() {
			return undefined;
		},
		webServer: {
			register(spec) {
				route = spec;
				return () => {};
			},
		},
	};
	plugin.apply(ctx);
	assert.ok(route !== null, "the plugin registers exactly one route");
	assert.equal(route.path, "/pomodoro/api");
	assert.equal(route.kind, "prefix");
	return { route, effects };
}

/** POST one JSON payload through the registered route handler. */
async function post(route, payload, options) {
	const settings = options === undefined ? {} : options;
	const headers = Object.assign(
		{ host: "127.0.0.1:49956", "content-type": "application/json" },
		settings.headers === undefined ? {} : settings.headers,
	);
	const body = settings.rawBody === undefined ? JSON.stringify(payload) : settings.rawBody;
	const req = makeRequest({ method: settings.method === undefined ? "POST" : settings.method, headers, body });
	const res = makeResponse();
	await route.handler(req, res);
	return res;
}

// ── assertions ──────────────────────────────────────────────────────────────

async function main() {
	const mounted = mount();
	const route = mounted.route;
	const effects = mounted.effects;
	assert.equal(typeof plugin.name, "string", "the plugin declares its package name");
	assert.deepEqual(plugin.inject, ["webServer"], "the Host half declares its webServer dependency");

	// 1. Trust fence: a foreign Host is refused.
	{
		const res = await post(route, { method: "get" }, { headers: { host: "evil.example.com" } });
		assert.equal(res.status, 403, "a foreign Host header is refused");
	}

	// 2. A cross-site marker is refused even on loopback.
	{
		const res = await post(route, { method: "get" }, { headers: { "sec-fetch-site": "cross-site" } });
		assert.equal(res.status, 403, "a cross-site browser request is refused");
	}

	// 3. An Origin that does not match the Host is refused.
	{
		const res = await post(route, { method: "get" }, { headers: { origin: "http://attacker.example" } });
		assert.equal(res.status, 403, "a mismatched Origin is refused");
	}

	// 4. A same-origin loopback request is served, empty at first.
	{
		const res = await post(route, { method: "get" });
		assert.equal(res.status, 200);
		assert.equal(res.payload.ok, true);
		assert.equal(res.payload.value.revision, 0, "a fresh install has no saved revision");
		assert.equal(res.payload.value.state, null, "a fresh install has no saved state");
	}

	// 5. Wrong method and wrong content type are rejected before any write.
	{
		assert.equal((await post(route, { method: "get" }, { method: "GET" })).status, 405);
		assert.equal((await post(route, { method: "get" }, { headers: { "content-type": "text/plain" } })).status, 415);
		assert.equal((await post(route, {}, { rawBody: "not json" })).status, 400);
	}

	// 6. A set writes atomically and is readable afterwards.
	{
		const state = {
			v: 1,
			rev: 5,
			settings: { focusMin: 25, shortMin: 5, longMin: 15, interval: 4, volume: 70, notify: false, task: "写周报" },
			phase: "focus",
			running: false,
			endsAt: 0,
			remainingMs: 1500000,
			completedFocus: 2,
			history: [{ at: 1, day: "2026-10-20", phase: "focus", outcome: "completed", ms: 1500000 }],
		};
		const write = await post(route, { method: "set", revision: 6, state });
		assert.equal(write.status, 200);
		assert.equal(write.payload.ok, true);
		assert.equal(write.payload.revision, 6);

		const file = path.join(HOME, "pomodoro.json");
		assert.ok(fs.existsSync(file), "the state file exists");
		assert.ok(!fs.existsSync(`${file}.tmp`), "no temp file is left behind");
		const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(onDisk.schemaVersion, 1);
		assert.equal(onDisk.revision, 6);
		assert.equal(onDisk.state.settings.task, "写周报");

		const read = await post(route, { method: "get" });
		assert.equal(read.payload.value.revision, 6);
		assert.equal(read.payload.value.state.completedFocus, 2);
	}

	// 7. A stale page cannot roll the file backwards.
	{
		const stale = await post(route, {
			method: "set",
			revision: 3,
			state: { v: 1, rev: 3, history: [], completedFocus: 0 },
		});
		assert.equal(stale.status, 200);
		assert.equal(stale.payload.ignored, true, "an older revision is ignored");
		assert.equal(stale.payload.revision, 6, "the stored revision is reported back");

		const read = await post(route, { method: "get" });
		assert.equal(read.payload.value.revision, 6, "the file kept the newer revision");
	}

	// 8. Malformed payloads are rejected without touching the file.
	{
		assert.equal((await post(route, { method: "set", revision: 0, state: {} })).status, 400);
		assert.equal((await post(route, { method: "set", revision: 9, state: [] })).status, 400);
		assert.equal((await post(route, { method: "set", revision: 9, state: null })).status, 400);
		assert.equal((await post(route, { method: "nope" })).status, 404);
		const read = await post(route, { method: "get" });
		assert.equal(read.payload.value.revision, 6, "rejected writes left the file untouched");
	}

	// 9. A corrupt file degrades to the empty record instead of throwing.
	{
		fs.writeFileSync(path.join(HOME, "pomodoro.json"), "{ this is not json");
		const read = await post(route, { method: "get" });
		assert.equal(read.status, 200, "a corrupt file still answers");
		assert.equal(read.payload.value.revision, 0);
		assert.equal(read.payload.value.state, null);
	}

	// 10. A configured trusted authority is accepted.
	{
		let trustedRoute = null;
		plugin.apply({
			effect(factory) {
				factory();
				return () => {};
			},
			get(name) {
				return name === "webRuntime" ? { trustedHosts: ["mybox.local:8443"] } : undefined;
			},
			webServer: {
				register(spec) {
					trustedRoute = spec;
					return () => {};
				},
			},
		});
		const trusted = await post(trustedRoute, { method: "get" }, { headers: { host: "mybox.local:8443" } });
		assert.equal(trusted.status, 200, "a declared trusted authority is served");
		const untrusted = await post(trustedRoute, { method: "get" }, { headers: { host: "other.local:8443" } });
		assert.equal(untrusted.status, 403, "an undeclared authority is still refused");
	}

	// 11. Every effect is disposable.
	for (const disposer of effects) {
		if (typeof disposer === "function") disposer();
	}

	fs.rmSync(HOME, { recursive: true, force: true });
	console.log("host-api: all assertions passed");
}

main().catch((error) => {
	fs.rmSync(HOME, { recursive: true, force: true });
	console.error(error);
	process.exitCode = 1;
});
