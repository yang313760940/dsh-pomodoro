/**
 * Static consistency check for dsh-pomodoro: every `t("key")` used by a
 * component must exist in the dictionary, and every dictionary key should be
 * reachable (no dead copy). Also checks that the locale resources and the client
 * dictionary agree on the plugin title.
 *
 * Run: node tests/copy.cjs
 */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "dsh-pomodoro", "client.js"), "utf8");

/** Extract the DICT literal as a Map of key -> value. */
function dictEntries() {
	const start = SOURCE.indexOf("const DICT = {");
	assert.ok(start > 0, "the dictionary literal is found");
	const end = SOURCE.indexOf("\n      };", start);
	assert.ok(end > start, "the dictionary literal ends");
	const body = SOURCE.slice(start, end);
	const map = new Map();
	for (const match of body.matchAll(/"([a-zA-Z][\w.]*)":\s*"((?:[^"\\]|\\.)*)"/g)) {
		map.set(match[1], match[2].replace(/\\"/g, '"'));
	}
	return map;
}

/** Extract every literal key passed to t(...) or DICT[...]. */
function usedKeys() {
	const keys = new Set();
	for (const match of SOURCE.matchAll(/\bt\(\s*"([a-zA-Z][\w.]*)"/g)) keys.add(match[1]);
	for (const match of SOURCE.matchAll(/DICT\[\s*"([a-zA-Z][\w.]*)"\s*\]/g)) keys.add(match[1]);
	return keys;
}

const dict = dictEntries();
const used = usedKeys();

const missing = [...used].filter((key) => !dict.has(key));
assert.deepEqual(missing, [], `every t() key exists in the dictionary; missing: ${missing.join(", ")}`);

// Preset keys are built dynamically as `settings.preset.${id}`; account for them.
const dynamic = ["settings.preset.classic", "settings.preset.deep", "settings.preset.ultradian"];
const dead = [...dict.keys()].filter((key) => !used.has(key) && !dynamic.includes(key));
assert.deepEqual(dead, [], `no dead copy in the dictionary; unreachable: ${dead.join(", ")}`);

// The dynamic preset keys must exist, or the chips would render raw keys.
for (const key of dynamic) {
	assert.ok(dict.has(key), `preset label ${key} exists`);
}

// The locale resources carry the plugin title used by the plugin manager.
for (const file of ["zh.json", "en.json"]) {
	const resource = JSON.parse(fs.readFileSync(path.join(ROOT, "dsh-pomodoro", "locale", file), "utf8"));
	assert.equal(typeof resource.meta.title, "string", `${file} has meta.title`);
	assert.equal(typeof resource.meta.description, "string", `${file} has meta.description`);
	assert.ok(resource.meta.title.length > 0 && resource.meta.description.length > 0, `${file} metadata is non-empty`);
}

const zh = JSON.parse(fs.readFileSync(path.join(ROOT, "dsh-pomodoro", "locale", "zh.json"), "utf8"));
assert.equal(zh.meta.title, dict.get("meta.title"), "the plugin manager title matches the UI title");

// Placeholder hygiene: every {name} placeholder used by a template must be
// supplied at its call site, otherwise the user sees a literal `{n}`.
for (const match of SOURCE.matchAll(/\bt\(\s*"([a-zA-Z][\w.]*)"\s*\)/g)) {
	const template = dict.get(match[1]);
	if (template === undefined) continue;
	const placeholders = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
	assert.deepEqual(
		placeholders,
		[],
		`t("${match[1]}") is called without params but its template needs {${placeholders.join(", ")}}`,
	);
}

// The icon must be a real, small SVG so the plugin row renders artwork.
const icon = fs.readFileSync(path.join(ROOT, "dsh-pomodoro", "icon.svg"), "utf8");
assert.ok(icon.startsWith("<svg") || icon.includes("<svg"), "the icon is SVG markup");
assert.ok(icon.length < 256 * 1024, "the icon is under the 256 KiB limit");

// The manifest exports the display resources the plugin manager reads.
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "dsh-pomodoro", "package.json"), "utf8"));
assert.equal(manifest.dsh.client.platform, "web", "the client targets the web platform");
assert.equal(manifest.exports["./client"], "./client.js", "the client subpath export exists");
assert.ok(manifest.exports["./locale/*.json"] !== undefined, "locale resources are exported");
assert.ok(manifest.icon === "./icon.svg" || manifest.exports["./icon"] !== undefined, "an icon is exported");
for (const entry of ["index.js", "client.js", "cordis.patch.yml", "icon.svg"]) {
	assert.ok(manifest.files.includes(entry), `files lists ${entry}`);
}

console.log(`copy: all assertions passed (${dict.size} dictionary keys, ${used.size} reachable)`);
