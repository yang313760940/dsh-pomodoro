/**
 * dsh-pomodoro — Host half.
 *
 * Durable, origin-independent persistence for the browser half.
 *
 * WHY THIS EXISTS. The browser half cannot use `localStorage` as the source of
 * truth: DSH Desktop binds its web server to an OS-assigned port on every
 * launch, `localStorage` is scoped per origin (scheme + host + port), so the
 * GUI origin changes on every restart and the saved settings and statistics
 * are "forgotten" — the bytes are still in the browser's leveldb, just under
 * the previous port's origin. The Host settings document is not an option
 * either: its wire only exposes an allowlisted set of namespaces to browser
 * clients, so a third-party namespace answers `settings-not-exposed`.
 *
 * This half therefore owns one small JSON state file and one fenced route:
 *
 *   - `$DSH_HOME/pomodoro.json` — `{ schemaVersion, revision, savedAt, state }`,
 *     written atomically (tmp + rename, direct-write fallback on Windows).
 *   - `POST /pomodoro/api` —
 *       `{ method: "get" }`                       → `{ ok: true, value: record }`
 *       `{ method: "set", revision, state }`      → `{ ok: true, revision }`
 *     A `set` whose revision is not greater than the revision already on disk is
 *     ignored (`{ ok: true, ignored: true }`), so a page that boots with stale
 *     local data cannot roll the file backwards.
 *
 * Route security mirrors the trust fence of an already-published plugin in this
 * profile: the request `Host` must be the loopback authority (or a configured
 * trusted authority), the browser must not mark the request cross-site, and an
 * `Origin` header, when present, must match the Host. That is a DNS-rebinding
 * and cross-site-write defense, not authentication.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/** Plugin identity declared in cordis.patch.yml. */
export const name = "dsh-pomodoro";
/** The web server carries the persistence route. */
export const inject = ["webServer"];

/** State file name inside the DSH home directory. */
const STATE_FILENAME = "pomodoro.json";
/** Schema version this build writes and understands. */
const SCHEMA_VERSION = 1;
/** Route prefix owned by this plugin. */
const API_PREFIX = "/pomodoro/api";
/** Request bodies here are small settings snapshots; keep a hard cap anyway. */
const MAX_BODY_BYTES = 1024 * 1024;

// ── state file ────────────────────────────────────────────────────────────

/** Absolute path of the state file under the DSH home directory. */
function statePath() {
	const home =
		process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
			? process.env.DSH_HOME
			: join(homedir(), ".dsh");
	return join(home, STATE_FILENAME);
}

/** The empty record: no revision, no state. */
function emptyRecord() {
	return { schemaVersion: SCHEMA_VERSION, revision: 0, savedAt: 0, state: null };
}

/**
 * Read the state file. A missing or unparsable file reads as the empty record —
 * the browser half still holds the values in localStorage and re-pushes them,
 * and a corrupt file must never take the plugin down.
 */
function readRecord() {
	try {
		const parsed = JSON.parse(readFileSync(statePath(), "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return emptyRecord();
		const revision = Number(parsed.revision);
		const savedAt = Number(parsed.savedAt);
		return {
			schemaVersion: Number(parsed.schemaVersion) || 0,
			revision: Number.isFinite(revision) && revision > 0 ? Math.floor(revision) : 0,
			savedAt: Number.isFinite(savedAt) && savedAt > 0 ? Math.floor(savedAt) : 0,
			state:
				parsed.state !== null && typeof parsed.state === "object" && !Array.isArray(parsed.state)
					? parsed.state
					: null,
		};
	} catch {
		return emptyRecord();
	}
}

/** Persist one record atomically. */
function writeRecord(record) {
	const file = statePath();
	mkdirSync(dirname(file), { recursive: true });
	const body = JSON.stringify({
		schemaVersion: SCHEMA_VERSION,
		revision: record.revision,
		savedAt: record.savedAt,
		state: record.state,
	});
	const tmp = `${file}.tmp`;
	// The file is the user's own study log; keep it owner-only where the
	// platform honours the mode (it is ignored on Windows).
	writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
	try {
		renameSync(tmp, file);
	} catch {
		// rename can fail on Windows while the target is transiently locked; a
		// direct write is a safe fallback for this single-process case.
		writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
	}
}

// ── trust fence ───────────────────────────────────────────────────────────

/** Parsed URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority) {
	try {
		return new URL(`http://${authority}`);
	} catch {
		return undefined;
	}
}

/** Whether a hostname names the local loopback authority. */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return (
		parts.length === 4 &&
		parts[0] === "127" &&
		parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
	);
}

/** Whether the request Host matches one configured trusted authority. */
function isTrustedAuthority(hostUrl, trustedHosts) {
	return trustedHosts.some((entry) => {
		if (typeof entry !== "string" || entry.length === 0) return false;
		const entryUrl = parseAuthority(entry);
		if (entryUrl === undefined) return false;
		const entryHasPort = entryUrl.port !== "";
		return entryHasPort ? entryUrl.host === hostUrl.host : entryUrl.hostname === hostUrl.hostname;
	});
}

/**
 * Decide whether one request may reach the plugin route.
 * @param req - node HTTP request facts (headers).
 * @param trustedHosts - non-loopback authorities this deployment serves.
 * @returns true when the Host is ours and browser markers are same-origin.
 */
function isTrustedApiRequest(req, trustedHosts) {
	const host = typeof req.headers.host === "string" ? req.headers.host : undefined;
	if (host === undefined) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === undefined) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = req.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

// ── JSON body / response helpers ──────────────────────────────────────────

/** Sentinel: the request body exceeded MAX_BODY_BYTES. */
const PAYLOAD_TOO_LARGE = Symbol("payload-too-large");

/** Read a JSON request body, capped at MAX_BODY_BYTES. */
function readJsonBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		let size = 0;
		let aborted = false;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES && !aborted) {
				aborted = true;
				req.destroy();
				resolve(PAYLOAD_TOO_LARGE);
				return;
			}
			if (!aborted) chunks.push(chunk);
		});
		req.on("end", () => {
			if (aborted) return;
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				resolve(null);
			}
		});
		req.on("error", () => {
			if (!aborted) resolve(null);
		});
	});
}

/** Write a JSON response with the given status code. */
function writeJson(res, status, value) {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(value));
}

/** Handle one fenced API request. */
async function handleApi(req, res) {
	if (req.method !== "POST") {
		writeJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } });
		return;
	}
	const contentType =
		typeof req.headers["content-type"] === "string" ? req.headers["content-type"].toLowerCase() : "";
	if (!contentType.startsWith("application/json")) {
		writeJson(res, 415, {
			ok: false,
			error: { code: "unsupported-media-type", message: "content-type must be application/json" },
		});
		return;
	}
	const payload = await readJsonBody(req);
	if (payload === PAYLOAD_TOO_LARGE) {
		writeJson(res, 413, { ok: false, error: { code: "payload-too-large", message: "request body too large" } });
		return;
	}
	if (payload === null || typeof payload !== "object" || typeof payload.method !== "string") {
		writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "bad request" } });
		return;
	}
	if (payload.method === "get") {
		writeJson(res, 200, { ok: true, value: readRecord() });
		return;
	}
	if (payload.method === "set") {
		const incomingRevision = Number(payload.revision);
		const incomingState = payload.state;
		if (!Number.isFinite(incomingRevision) || incomingRevision <= 0) {
			writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "revision must be a positive number" } });
			return;
		}
		if (incomingState === null || typeof incomingState !== "object" || Array.isArray(incomingState)) {
			writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "state must be a plain object" } });
			return;
		}
		const revision = Math.floor(incomingRevision);
		const current = readRecord();
		if (revision <= current.revision) {
			// A stale page must not roll the file backwards.
			writeJson(res, 200, { ok: true, ignored: true, revision: current.revision });
			return;
		}
		writeRecord({ schemaVersion: SCHEMA_VERSION, revision: revision, savedAt: Date.now(), state: incomingState });
		writeJson(res, 200, { ok: true, revision: revision });
		return;
	}
	writeJson(res, 404, { ok: false, error: { code: "not-found", message: `unknown method "${payload.method}"` } });
}

/**
 * Host loader entry: mount the fenced persistence route.
 * @param ctx - host cordis context (webServer, optionally webRuntime).
 */
export function apply(ctx) {
	/** Configured non-loopback authorities, when the deployment declares them. */
	const trustedHosts = () => {
		const runtime = ctx.get("webRuntime");
		const list = runtime !== undefined && runtime !== null ? runtime.trustedHosts : undefined;
		return Array.isArray(list) ? list : [];
	};
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "prefix",
				path: API_PREFIX,
				handler: async (req, res) => {
					if (!isTrustedApiRequest(req, trustedHosts())) {
						writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
						return;
					}
					try {
						await handleApi(req, res);
					} catch (error) {
						// Never echo internal errors (file paths) back to the page.
						console.error("[dsh-pomodoro] persistence API error:", error);
						writeJson(res, 500, { ok: false, error: { code: "internal", message: "internal error" } });
					}
				},
			}),
		"dsh-pomodoro: persistence API route",
	);
}
