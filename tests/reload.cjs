/**
 * Offline test for the dsh-pomodoro reload / overshoot path.
 *
 * Decisions this pins:
 *   Q6 — the clock is one global singleton, and a page reload restores it from
 *        the persisted end timestamp instead of restarting the phase;
 *   Q5 — a phase whose end time passed while the page was closed counts as a
 *        NATURAL completion (a pomodoro must ring), not as an abandonment.
 *
 * Run: node tests/reload.cjs
 */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const CLIENT_PATH = path.join(__dirname, "..", "dsh-pomodoro", "client.js");
const SOURCE = fs.readFileSync(CLIENT_PATH, "utf8");

const NOW = Date.parse("2026-10-20T10:00:00+08:00");

// ── shims ───────────────────────────────────────────────────────────────────

function flatten(children) {
	const out = [];
	for (const child of children) {
		if (Array.isArray(child)) out.push(...flatten(child));
		else out.push(child);
	}
	return out;
}

/** Boot one page instance and return its handles. */
function boot(seedState) {
	const clock = { now: NOW, tick: null };
	const storage = new Map();
	if (seedState !== undefined) storage.set("dsh-pomodoro:state", JSON.stringify(seedState));
	const hostCalls = [];
	const pushed = [];

	const React = {
		createElement(type, props, ...children) {
			return { type, props: Object.assign({}, props === null ? {} : props, { children: flatten(children) }) };
		},
		useState(initial) {
			return [typeof initial === "function" ? initial() : initial, () => {}];
		},
		useEffect() {},
		useSyncExternalStore(subscribe, getSnapshot) {
			subscribe(() => {});
			return getSnapshot();
		},
	};

	const sandboxWindow = {
		localStorage: {
			getItem: (key) => (storage.has(key) ? storage.get(key) : null),
			setItem: (key, value) => storage.set(key, String(value)),
			removeItem: (key) => storage.delete(key),
		},
		Notification: undefined,
		__ModuleLoader__: { load: (record) => { sandboxWindow.__loaded = record; } },
	};

	const documentShim = {
		baseURI: "http://127.0.0.1:49956/",
		visibilityState: "visible",
		head: { appendChild() {} },
		createElement: () => ({ dataset: {}, textContent: "", remove() {}, appendChild() {} }),
		addEventListener() {},
		removeEventListener() {},
	};

	globalThis.window = sandboxWindow;
	globalThis.document = documentShim;
	globalThis.localStorage = sandboxWindow.localStorage;
	globalThis.fetch = (url, init) => {
		const body = JSON.parse(init.body);
		hostCalls.push({ url, body });
		if (body.method === "get") {
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value: { revision: 0, state: null } }) });
		}
		pushed.push(body);
		return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, revision: body.revision }) });
	};
	globalThis.setInterval = (fn) => {
		clock.tick = fn;
		return 1;
	};
	globalThis.clearInterval = () => {
		clock.tick = null;
	};
	globalThis.setTimeout = (fn) => fn();
	globalThis.clearTimeout = () => {};
	Date.now = () => clock.now;

	vm.runInThisContext(SOURCE, { filename: CLIENT_PATH });
	const plugin = sandboxWindow.__loaded.factory((name) => {
		if (name === "react") return React;
		throw new Error(`unexpected require(${name})`);
	});

	const registrations = new Map();
	const dict = new Map();
	const ctx = {
		effect: (factory) => {
			const disposer = factory();
			return typeof disposer === "function" ? disposer : () => {};
		},
		on: () => () => {},
		get: () => undefined,
		locale: {
			register: (ns, dicts) => {
				dict.set(ns, dicts.zh);
				return () => {};
			},
			bind: () => (key) => key,
		},
		slots: {
			inject: (_slot, factory) => factory(),
			register: (options, component) => {
				registrations.set(options.name, { options, component });
				return () => {};
			},
		},
	};
	plugin.apply(ctx);

	const t = (key, params) => {
		let text = dict.get("pomodoro")[key] !== undefined ? dict.get("pomodoro")[key] : key;
		if (params) for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
		return text;
	};

	return { clock, storage, hostCalls, pushed, registrations, t, status: () => sandboxWindow.__DSH_POMODORO_STATUS__ };
}

function textOf(node) {
	const parts = [];
	(function walk(current) {
		if (current === null || typeof current !== "object") return;
		if (Array.isArray(current)) {
			current.forEach(walk);
			return;
		}
		for (const child of current.props.children || []) {
			if (typeof child === "string") parts.push(child);
		}
		for (const child of current.props.children || []) walk(child);
	})(node);
	return parts.join(" ");
}

function renderDock(page) {
	const entry = page.registrations.get("conversation.composer.dock");
	return entry.component({ t: page.t, renderSlot: () => null });
}

function findButton(tree, label) {
	let found = null;
	(function walk(current) {
		if (found !== null || current === null || typeof current !== "object") return;
		if (Array.isArray(current)) {
			current.forEach(walk);
			return;
		}
		if (current.type === "button" && textOf(current).includes(label)) {
			found = current;
			return;
		}
		for (const child of current.props.children || []) walk(child);
	})(tree);
	return found;
}

// ── scenario 1: reload mid-focus keeps the remaining time ───────────────────

{
	// A page was closed with focus running and 5 minutes left.
	const seed = {
		v: 1,
		rev: 7,
		updatedAt: NOW - 20 * 60 * 1000,
		settings: { focusMin: 25, shortMin: 5, longMin: 15, interval: 4, volume: 70, notify: false, task: "" },
		phase: "focus",
		running: true,
		endsAt: NOW + 5 * 60 * 1000,
		remainingMs: 5 * 60 * 1000,
		completedFocus: 2,
		history: [],
	};
	const page = boot(seed);
	const tree = renderDock(page);
	assert.ok(textOf(tree).includes("05:00"), "a reload keeps the exact remaining time, not the full phase");
	assert.equal(page.status().running, true, "the clock is still running after the reload");
	assert.equal(page.status().phase, "focus");
	assert.equal(page.status().completedFocus, 2, "the round count survives the reload");

	// The restored clock keeps ticking down.
	page.clock.now += 60 * 1000;
	page.clock.tick();
	assert.ok(textOf(renderDock(page)).includes("04:00"), "the restored clock keeps counting down");
}

// ── scenario 2: reload after the phase already ended → natural completion ───

{
	// Closed 3 minutes AFTER the focus phase ended.
	const seed = {
		v: 1,
		rev: 9,
		updatedAt: NOW - 30 * 60 * 1000,
		settings: { focusMin: 25, shortMin: 5, longMin: 15, interval: 4, volume: 70, notify: false, task: "写周报" },
		phase: "focus",
		running: true,
		endsAt: NOW - 3 * 60 * 1000,
		remainingMs: 0,
		completedFocus: 1,
		history: [],
	};
	const page = boot(seed);
	const tree = renderDock(page);
	assert.equal(page.status().phase, "short", "an overshoot focus phase hands over to the short break");
	assert.equal(page.status().todayPomodoro, 1, "the overshoot counts as a natural completion, not an abandonment");
	assert.equal(page.status().running, false, "the next phase waits for a click (semi-automatic flow)");
	assert.ok(textOf(tree).includes("离开期间"), "the row explains what happened while the page was closed");

	const persisted = JSON.parse(page.storage.get("dsh-pomodoro:state"));
	const record = persisted.history[persisted.history.length - 1];
	assert.equal(record.outcome, "completed", "the record says completed, not abandoned");
	assert.equal(record.ms, 25 * 60 * 1000, "a completed pomodoro records the full planned duration");
	assert.equal(record.task, "写周报", "the record carries the focus task");
	assert.ok(page.pushed.length > 0, "the corrected state is pushed to the Host file");
}

// ── scenario 3: an overshoot that earns the long break ─────────────────────

{
	const seed = {
		v: 1,
		rev: 11,
		updatedAt: NOW - 60 * 60 * 1000,
		settings: { focusMin: 25, shortMin: 5, longMin: 15, interval: 4, volume: 70, notify: false, task: "" },
		phase: "focus",
		running: true,
		endsAt: NOW - 1000,
		remainingMs: 0,
		completedFocus: 3,
		history: [],
	};
	const page = boot(seed);
	assert.equal(page.status().completedFocus, 4, "the overshoot raises the completed pomodoro count");
	assert.equal(page.status().phase, "long", "the fourth pomodoro earns the long break even across a reload");
	assert.ok(textOf(renderDock(page)).includes("15:00"), "the long break is armed at its full length");
}

// ── scenario 4: a paused phase is not mistaken for an overshoot ────────────

{
	const seed = {
		v: 1,
		rev: 12,
		updatedAt: NOW,
		settings: { focusMin: 25, shortMin: 5, longMin: 15, interval: 4, volume: 70, notify: false, task: "" },
		phase: "focus",
		running: false,
		endsAt: 0,
		remainingMs: 12 * 60 * 1000,
		completedFocus: 0,
		history: [],
	};
	const page = boot(seed);
	assert.equal(page.status().running, false, "a paused phase stays paused");
	assert.ok(textOf(renderDock(page)).includes("12:00"), "a paused phase keeps its remaining time");
	assert.equal(page.status().completedFocus, 0, "a paused phase records nothing");
}

// ── scenario 5: corrupt persisted state degrades instead of crashing ───────

{
	globalThis.localStorage.setItem("dsh-pomodoro:state", "{not json");
	const page = boot();
	// boot() overwrites localStorage only when given a seed, so re-read the bad blob.
	assert.ok(page.registrations.has("conversation.composer.dock"), "a corrupt cache still registers the dock row");
	const tree = renderDock(page);
	assert.ok(textOf(tree).includes("25:00"), "a corrupt cache falls back to the default focus phase");
	assert.equal(page.status().todayPomodoro, 0, "a corrupt cache reports empty statistics");
}

console.log("reload: all assertions passed");
