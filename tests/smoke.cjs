/**
 * Offline smoke test for the dsh-pomodoro browser half.
 *
 * The browser half is a plain-CJS module body registered into
 * `window.__ModuleLoader__`. This harness supplies a minimal React/DOM/window
 * shim, materializes the factory, calls apply(ctx) against a fake cordis
 * context, then drives the real state machine through the rendered dock row:
 * start → tick to 0 → completions → long break → skip/reset (abandoned) →
 * settings change → notification degradation.
 *
 * Run: node tests/smoke.cjs
 */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const CLIENT_PATH = path.join(__dirname, "..", "dsh-pomodoro", "client.js");
const SOURCE = fs.readFileSync(CLIENT_PATH, "utf8");

// ── React shim ──────────────────────────────────────────────────────────────

/** Flatten children into a plain array. */
function flatten(children) {
	const out = [];
	for (const child of children) {
		if (Array.isArray(child)) out.push(...flatten(child));
		else out.push(child);
	}
	return out;
}

const hooks = { cursor: 0, byComponent: new Map(), component: "default" };
const React = {
	createElement(type, props, ...children) {
		return { type, props: Object.assign({}, props === null ? {} : props, { children: flatten(children) }), key: props && props.key };
	},
	useState(initial) {
		const index = hooks.cursor;
		hooks.cursor += 1;
		let values = hooks.byComponent.get(hooks.component);
		if (values === undefined) {
			values = [];
			hooks.byComponent.set(hooks.component, values);
		}
		if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
		const setter = (next) => {
			values[index] = typeof next === "function" ? next(values[index]) : next;
		};
		return [values[index], setter];
	},
	useEffect() {},
	useSyncExternalStore(subscribe, getSnapshot) {
		// Subscribe with a no-op listener: this harness re-renders explicitly.
		const unsubscribe = subscribe(() => {});
		if (typeof unsubscribe !== "function") throw new Error("useSyncExternalStore subscribe must return a disposer");
		return getSnapshot();
	},
};

// ── window / document / timers ──────────────────────────────────────────────

/** Controlled clock so a 25-minute phase can elapse instantly. */
const clock = { now: Date.parse("2026-10-20T09:00:00+08:00"), interval: null, intervals: 0 };
const realDateNow = Date.now;

const storage = new Map();
const listeners = new Map();
const documentShim = {
	baseURI: "http://127.0.0.1:49956/",
	visibilityState: "visible",
	head: { appendChild() {} },
	createElement(tag) {
		return { tag, dataset: {}, textContent: "", setAttribute() {}, remove() {}, appendChild() {} };
	},
	addEventListener(name, handler) {
		listeners.set(name, handler);
	},
	removeEventListener(name) {
		listeners.delete(name);
	},
};
const windowShim = {
	localStorage: {
		getItem: (key) => (storage.has(key) ? storage.get(key) : null),
		setItem: (key, value) => storage.set(key, String(value)),
		removeItem: (key) => storage.delete(key),
	},
	Notification: undefined,
	__ModuleLoader__: { load: (record) => { windowShim.__loaded = record; } },
};

const hostCalls = [];
function fetchShim(url, init) {
	const body = JSON.parse(init.body);
	hostCalls.push({ url, body });
	if (body.method === "get") {
		return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value: { revision: 0, state: null } }) });
	}
	return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, revision: body.revision }) });
}

globalThis.window = windowShim;
globalThis.document = documentShim;
globalThis.localStorage = windowShim.localStorage;
globalThis.fetch = fetchShim;
globalThis.setInterval = (fn) => {
	clock.intervals += 1;
	clock.interval = fn;
	return clock.intervals;
};
globalThis.clearInterval = () => {
	clock.interval = null;
};
globalThis.setTimeout = (fn) => {
	// Host pushes are debounced; run them eagerly so the test can assert them.
	pendingTimers.push(fn);
	return pendingTimers.length;
};
globalThis.clearTimeout = () => {};
const pendingTimers = [];
Date.now = () => clock.now;

// ── materialize the factory ─────────────────────────────────────────────────

vm.runInThisContext(SOURCE, { filename: CLIENT_PATH });
const loaded = windowShim.__loaded;
assert.ok(loaded !== undefined, "client.js must call window.__ModuleLoader__.load");
assert.equal(loaded.id, "dsh-pomodoro", "module id must equal the package name");
const plugin = loaded.factory((name) => {
	if (name === "react") return React;
	throw new Error(`unexpected require(${name})`);
});
assert.equal(typeof plugin.apply, "function", "factory must return an apply()");
assert.deepEqual(plugin.inject, ["slots", "locale"], "the plugin injects the slots and locale services");

// ── fake cordis context ─────────────────────────────────────────────────────

const registrations = new Map();
const effects = [];
const localeDicts = new Map();
const ctx = {
	effect(factory, label) {
		const disposer = factory();
		effects.push({ label, disposer });
		return () => {};
	},
	on() {
		return () => {};
	},
	get(name) {
		return name === "locale"
			? {
					register: (ns, dicts) => {
						localeDicts.set(ns, dicts);
						return () => {};
					},
					bind: () => (key) => key,
				}
			: undefined;
	},
	locale: {
		register: (ns, dicts) => {
			localeDicts.set(ns, dicts);
			return () => {};
		},
		bind: () => (key) => key,
	},
	slots: {
		inject(slotName, factory) {
			const disposer = factory();
			return disposer;
		},
		register(options, component) {
			// The real registry is keyed by (slot name, id); the same id may be
			// registered into two different slots.
			registrations.set(`${options.name}#${options.id}`, { options, component });
			return () => {};
		},
	},
};

plugin.apply(ctx);

assert.equal(registrations.size, 2, "the plugin registers into exactly two slots");
const dock = registrations.get("conversation.composer.dock#dsh-pomodoro");
const settings = registrations.get("settings.section#dsh-pomodoro");
assert.ok(dock !== undefined, "the dock row is registered");
assert.ok(settings !== undefined, "the settings section is registered");
assert.equal(dock.options.name, "conversation.composer.dock");
assert.equal(dock.options.locale, "pomodoro", "the dock declares its locale face");
assert.equal(settings.options.label, "番茄闹钟", "the settings nav entry is named 番茄闹钟");
assert.ok(localeDicts.has("pomodoro"), "dictionary registered under the same namespace");
assert.ok(clock.interval !== null, "the ticker is installed inside apply");

// ── render helpers ──────────────────────────────────────────────────────────

/** Translate through the registered dictionary, as the slot kit would. */
function translator() {
	const dict = localeDicts.get("pomodoro").zh;
	return (key, params) => {
		let text = dict[key] !== undefined ? dict[key] : key;
		if (params !== null && typeof params === "object") {
			for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
		}
		return text;
	};
}

/** Render a registered component once. */
function render(entry, extraProps) {
	const name = entry.options.name;
	const previous = hooks.component;
	hooks.component = name;
	hooks.cursor = 0;
	try {
		return entry.component(Object.assign({ t: translator(), renderSlot: () => null }, extraProps));
	} finally {
		hooks.component = previous;
	}
}

/** Depth-first walk of the element tree. */
function walk(node, visit) {
	if (node === null || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit);
		return;
	}
	visit(node);
	for (const child of node.props.children || []) walk(child, visit);
}

/** All text under a node. */
function textOf(node) {
	const parts = [];
	walk(node, (element) => {
		for (const child of element.props.children || []) {
			if (typeof child === "string") parts.push(child);
		}
	});
	return parts.join(" ");
}

/** Wrap one element so clicking it also flushes queued Host pushes. */
function withFlush(element) {
	if (element === null) return null;
	return Object.assign({}, element, {
		props: Object.assign({}, element.props, {
			onClick: (event) => {
				element.props.onClick(event);
				flushTimers();
			},
		}),
	});
}

/** Find the first button whose text matches. */
function findButton(tree, label) {
	let found = null;
	walk(tree, (element) => {
		if (found !== null) return;
		if (element.type !== "button") return;
		if (textOf(element).includes(label)) found = element;
	});
	return withFlush(found);
}

/** Find every button whose text matches. */
function findButtons(tree, label) {
	const found = [];
	walk(tree, (element) => {
		if (element.type === "button" && textOf(element).includes(label)) found.push(withFlush(element));
	});
	return found;
}

function readStatus() {
	return windowShim.__DSH_POMODORO_STATUS__;
}

/** Run the debounced Host pushes that are already queued. */
function flushTimers() {
	const runs = pendingTimers.splice(0);
	for (const run of runs) run();
}

/** Advance the fake clock and run one real ticker turn. */
function advance(ms) {
	clock.now += ms;
	clock.interval();
	flushTimers();
}

// ── assertions ──────────────────────────────────────────────────────────────

// 1. Idle state shows the full next-phase duration.
let tree = render(dock);
assert.ok(textOf(tree).includes("专注"), "idle shows the focus phase");
assert.ok(textOf(tree).includes("25:00"), "idle shows the full 25:00 duration");
assert.ok(textOf(tree).includes("0/4"), "idle shows the round counter");
assert.equal(readStatus().phase, "focus", "the diagnostics mirror reports the focus phase");

// 2. Start → runs, counts down.
findButton(tree, "开始").props.onClick();
assert.equal(readStatus().running, true, "start makes the clock run");
advance(60 * 1000);
tree = render(dock);
assert.ok(textOf(tree).includes("24:00"), "one minute elapsed");
assert.ok(findButton(tree, "暂停") !== null, "the primary button flips to pause");

// 3. Pause keeps the remaining time; resume continues.
findButton(tree, "暂停").props.onClick();
assert.equal(readStatus().running, false);
const pausedRemaining = readStatus().remainingMs;
advance(5 * 60 * 1000);
assert.equal(readStatus().remainingMs, pausedRemaining, "a paused clock does not drift");
tree = render(dock);
assert.ok(findButton(tree, "继续") !== null, "paused shows resume");

// 4. Completing a focus phase records one pomodoro and arms the short break.
findButton(tree, "继续").props.onClick();
advance(25 * 60 * 1000);
assert.equal(readStatus().phase, "short", "a finished focus phase arms the short break");
assert.equal(readStatus().todayPomodoro, 1, "a naturally finished focus counts as one pomodoro");
assert.equal(readStatus().running, false, "the next phase does not auto-start");
tree = render(dock);
assert.ok(textOf(tree).includes("05:00"), "the short break is armed at 5:00");
assert.ok(textOf(tree).includes("专注完成"), "the row announces the completed focus phase");
assert.ok(findButton(tree, "开始短休") !== null, "the alert offers the next phase");

// 5. Three more pomodoros earn the long break (interval 4). Each iteration
//    completes whatever phase is currently armed, so long breaks and short
//    breaks are both exercised through the real phase machine.
function completeArmedPhase() {
	const current = render(dock);
	const startButton =
		findButton(current, "开始短休") ||
		findButton(current, "开始专注") ||
		findButton(current, "开始长休") ||
		findButton(current, "继续") ||
		findButton(current, "开始");
	assert.ok(startButton !== undefined, "an armed phase always offers a start control");
	startButton.props.onClick();
	advance(readStatus().remainingMs + 1000);
}

let guard = 0;
while (readStatus().todayPomodoro < 4 && guard < 12) {
	completeArmedPhase();
	guard += 1;
}
assert.equal(readStatus().todayPomodoro, 4, "four pomodoros completed");
assert.equal(readStatus().phase, "long", "the fourth pomodoro earns the long break");
tree = render(dock);
assert.ok(textOf(tree).includes("15:00"), "the long break is armed at 15:00");
assert.ok(textOf(tree).includes("4/4"), "the round counter reads full during the earned long break");

// 6. Skipping a started focus phase records an abandonment, not a pomodoro.
{
	// Leave the earned long break (idle break skip returns to focus).
	const longBreak = render(dock);
	findButton(longBreak, "跳过").props.onClick();
	const idle = render(dock);
	assert.ok(textOf(idle).includes("专注"), "skipping an idle break returns to focus");
	findButton(idle, "开始").props.onClick();
	advance(60 * 1000);
	const running = render(dock);
	findButton(running, "跳过").props.onClick();
	const confirming = render(dock);
	assert.ok(textOf(confirming).includes("放弃这一轮"), "skipping a started focus asks for confirmation");
	findButton(confirming, "确认放弃").props.onClick();
	const after = render(dock);
	assert.equal(readStatus().todayPomodoro, 4, "an abandoned focus adds no pomodoro");
	assert.equal(readStatus().phase, "short", "an abandoned focus leads to a short break");
	assert.ok(textOf(after).includes("0/4"), "the round counter drops back to 0/4");
}

// 7. Resetting a started focus also counts as an abandonment, and stays in focus.
{
	const breakTree = render(dock);
	findButton(breakTree, "跳过").props.onClick();
	const focusIdle = render(dock);
	assert.ok(textOf(focusIdle).includes("专注"), "skipping an idle break returns to focus");
	findButton(focusIdle, "开始").props.onClick();
	advance(2 * 60 * 1000);
	const running = render(dock);
	findButton(running, "重置").props.onClick();
	const confirming = render(dock);
	assert.ok(textOf(confirming).includes("放弃这一轮"), "resetting a started focus asks for confirmation");
	findButton(confirming, "确认放弃").props.onClick();
	const after = render(dock);
	assert.equal(readStatus().phase, "focus", "reset keeps the focus phase");
	assert.equal(readStatus().todayPomodoro, 4, "a reset adds no pomodoro");
	assert.ok(textOf(after).includes("25:00"), "reset re-arms the full focus duration");
}

// 7b. An idle reset and an idle skip never record anything.
{
	const idle = render(dock);
	findButton(idle, "重置").props.onClick();
	assert.equal(readStatus().phase, "focus", "idle reset stays in focus");
	const stillIdle = render(dock);
	findButton(stillIdle, "跳过").props.onClick();
	assert.equal(readStatus().todayPomodoro, 4, "idle skip records no pomodoro");
	assert.equal(readStatus().todayAbandoned ?? 0, 0, "idle controls never fabricate a record");
}

// 8. Settings changes re-arm an idle clock at the new duration.
{
	const settingsTree = render(settings);
	assert.ok(textOf(settingsTree).includes("番茄闹钟"), "the settings page is titled 番茄闹钟");
	assert.ok(textOf(settingsTree).includes("今日番茄"), "the statistics block is present");
	assert.ok(textOf(settingsTree).includes("连续天数"), "the streak statistic is present");
	let chart = null;
	walk(settingsTree, (element) => {
		if (element.props && element.props["aria-label"] === "近 7 天完成") chart = element;
	});
	assert.ok(chart !== null, "the 7-day chart is present and labelled");
	assert.equal(flatten(chart.props.children).length, 7, "the chart has exactly seven columns");
	const bars = [];
	walk(settingsTree, (element) => {
		if (element.props && element.props.children === undefined) return;
		if (typeof element.props.className === "string" && element.props.className.includes("dsh-pomodoro-chart__bar")) bars.push(element);
	});
	assert.ok(bars.length >= 1, "the chart draws bars for completed days");
	const chips = findButtons(settingsTree, "50 / 10 / 20");
	assert.equal(chips.length, 1, "the 50/10/20 preset is offered");
	chips[0].props.onClick();
	const current = render(dock);
	assert.ok(textOf(current).includes("50:00"), "the preset re-arms the idle clock at 50:00");
}

// 9. Notification is unavailable here, and enabling it degrades instead of lying.
{
	const settingsTree = render(settings);
	const sw = [];
	walk(settingsTree, (element) => {
		if (element.props && element.props.role === "switch") sw.push(element);
	});
	assert.equal(sw.length, 1, "exactly one notification switch");
	sw[0].props.onClick();
	const after = render(settings);
	assert.ok(textOf(after).includes("不支持系统通知"), "an unsupported Notification API is reported, not hidden");
}

// 10. Host persistence was exercised: a get at boot and pushes on change.
//     Pushes are debounced through setTimeout, so flush them first.
for (const run of pendingTimers.slice()) run();
assert.ok(hostCalls.length > 0, "the Host persistence route is called");
assert.equal(hostCalls[0].body.method, "get", "boot pulls the durable state first");
const pushes = hostCalls.filter((call) => call.body.method === "set");
assert.ok(pushes.length > 0, "state changes are pushed");
assert.ok(
	pushes.every((call) => typeof call.body.revision === "number" && call.body.state !== null),
	"each push carries a revision and a full state snapshot",
);
assert.ok(
	pushes[pushes.length - 1].body.revision > pushes[0].body.revision,
	"the revision grows monotonically so a stale page cannot roll the file back",
);
assert.equal(hostCalls[0].url, "/pomodoro/api", "the route path matches the Host half");

// 11. Statistics survive a simulated reload: the persisted blob is re-adopted.
{
	const persisted = storage.get("dsh-pomodoro:state");
	assert.ok(typeof persisted === "string", "state is cached in localStorage for the first paint");
	const parsed = JSON.parse(persisted);
	assert.equal(parsed.settings.focusMin, 50, "the chosen preset was persisted");
	assert.ok(Array.isArray(parsed.history), "the history is persisted");
}

// 12. Pending debounced Host pushes were flushed by the timer shim.
for (const run of pendingTimers.slice()) run();

// 13. Teardown disposes every effect it installed.
for (const effect of effects) {
	if (typeof effect.disposer === "function") effect.disposer();
}
assert.equal(clock.interval, null, "teardown clears the ticker");

Date.now = realDateNow;
console.log("smoke: all assertions passed");
