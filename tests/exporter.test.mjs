import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";

import { beginOutputTransaction, writeOutputMarker } from "../src/output.ts";
import { buildGraph, escapeHtml, findBacklinks, linkFragment, makeOutputMap, matchesExportFilters, parseList, safeJson } from "../src/pure.ts";

const notes = [
  { path: "A B.md", basename: "A B" },
  { path: "A-B.md", basename: "A-B" },
  { path: "Graph Lab.md", basename: "Graph Lab" },
  { path: "Index.md", basename: "Index" },
];
const outputs = makeOutputMap(notes);

assert.equal(outputs.get("A B.md"), "a-b.html");
assert.equal(outputs.get("A-B.md"), "a-b-2.html");
assert.equal(outputs.get("Index.md"), "index-2.html");

const graph = buildGraph(notes, {
  "Graph Lab.md": { "A B.md": 1, "missing.md": 1 },
}, outputs, "Graph Lab.md");
assert.deepEqual(graph.edges, [{ source: "Graph Lab.md", target: "A B.md" }]);
assert.deepEqual(findBacklinks(notes, {
	"A B.md": { "Graph Lab.md": 1 },
	"Graph Lab.md": { "Graph Lab.md": 1 },
}, "Graph Lab.md"), [notes[0]]);
assert.equal(escapeHtml('<a "b">'), "&lt;a &quot;b&quot;&gt;");
assert.equal(safeJson({ value: "</script>" }), '{"value":"\\u003c/script>"}');
assert.equal(linkFragment("linked lists"), "#linked-lists");
assert.equal(linkFragment("^proof"), "#block-proof");
assert.deepEqual(parseList(" Public, docs/site, "), ["Public", "docs/site"]);
const filters = {
	includeFolders: ["Public"],
	excludeFolders: ["Public/private"],
	includeTags: ["publish"],
	excludeTags: ["draft"],
};
assert.equal(matchesExportFilters("Public/Note.md", ["#publish"], filters), true);
assert.equal(matchesExportFilters("Public/private/Note.md", ["publish"], filters), false);
assert.equal(matchesExportFilters("Public/Note.md", ["publish", "draft"], filters), false);
assert.equal(matchesExportFilters("Elsewhere/Note.md", ["publish"], filters), false);

const exporterSource = await readFile(new URL("../src/exporter.ts", import.meta.url), "utf8");
const pageScript = exporterSource.match(/const PAGE_SCRIPT = String\.raw`([\s\S]*)`;\s*$/u)?.[1];
assert.ok(pageScript, "exported page script exists");
const graphListeners = new Map();
const graphElement = {
	addEventListener: (type, listener) => graphListeners.set(type, listener),
	append: () => undefined,
	setAttribute: () => undefined,
};
const rootElement = { dataset: {} };
const bodyElement = { dataset: {} };
const themeListeners = new Map();
const themeElement = {
	addEventListener: (type, listener) => themeListeners.set(type, listener),
	setAttribute: () => undefined,
	textContent: "",
};
const notesListeners = new Map();
const notesElement = {
	addEventListener: (type, listener) => notesListeners.set(type, listener),
	setAttribute: () => undefined,
};
const searchListeners = new Map();
const searchElement = {
	addEventListener: (type, listener) => searchListeners.set(type, listener),
	value: "",
};
const searchLink = {
	dataset: { noteTitle: "alpha" },
	getAttribute: () => "alpha.html",
	hidden: false,
};
assert.doesNotThrow(() => new vm.Script(pageScript).runInNewContext({
	HTMLMOGGED_SEARCH: { "alpha.html": "alpha contains the hidden phrase" },
	document: {
		documentElement: rootElement,
		body: bodyElement,
		addEventListener: () => undefined,
		querySelectorAll: () => [searchLink],
		getElementById: (id) => id === "graph-data"
			? { textContent: '{"nodes":[],"edges":[],"current":""}' }
			: id === "link-graph" ? graphElement
				: id === "theme-toggle" ? themeElement
					: id === "notes-toggle" ? notesElement : id === "note-search" ? searchElement : null,
	},
	localStorage: { getItem: () => { throw new Error("storage denied"); } },
}), "graphs initialize when local storage is unavailable");
assert.ok(graphListeners.has("wheel"), "graph interaction is installed");
assert.equal(themeElement.textContent, "Light theme");
themeListeners.get("click")();
assert.equal(rootElement.dataset.theme, "light");
assert.equal(themeElement.textContent, "Dark theme");
notesListeners.get("click")();
assert.equal(bodyElement.dataset.panel, "notes");
searchElement.value = "hidden phrase";
searchListeners.get("input")();
assert.equal(searchLink.hidden, false);
searchElement.value = "missing";
searchListeners.get("input")();
assert.equal(searchLink.hidden, true);

const testRoot = await mkdtemp(path.join(tmpdir(), "htmlmogged-test-"));
try {
	const managed = path.join(testRoot, "managed");
	const first = await beginOutputTransaction(managed);
	await writeFile(path.join(first.staging, "stale.html"), "stale");
	await writeOutputMarker(first.staging, ["stale.html", "search-index.js"]);
	await first.commit();
	assert.match(await readFile(path.join(managed, ".htmlmogged.json"), "utf8"), /"generator": "htmlmogged"/u);

	const aborted = await beginOutputTransaction(managed);
	await writeFile(path.join(aborted.staging, "broken.html"), "broken");
	await aborted.abort();
	assert.equal(await readFile(path.join(managed, "stale.html"), "utf8"), "stale");

	const second = await beginOutputTransaction(managed);
	await writeFile(path.join(second.staging, "current.html"), "current");
	await writeOutputMarker(second.staging, ["current.html"]);
	await second.commit();
	await assert.rejects(readFile(path.join(managed, "stale.html")), /ENOENT/u);
	assert.equal(await readFile(path.join(managed, "current.html"), "utf8"), "current");

	const unmanaged = path.join(testRoot, "unmanaged");
	await mkdir(unmanaged);
	await writeFile(path.join(unmanaged, "index.html"), "keep me");
	await assert.rejects(beginOutputTransaction(unmanaged), /not managed by HTMLmogged/u);
	await assert.rejects(beginOutputTransaction(path.parse(testRoot).root), /filesystem root/u);
} finally {
	await rm(testRoot, { recursive: true, force: true });
}

console.log("exporter test passed");
