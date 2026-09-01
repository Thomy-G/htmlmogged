import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { beginOutputTransaction, writeOutputMarker } from "../src/output.ts";
import { buildGraph, escapeHtml, linkFragment, makeOutputMap, matchesExportFilters, parseList, safeJson } from "../src/pure.ts";

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

const testRoot = await mkdtemp(path.join(tmpdir(), "htmlmogged-test-"));
try {
	const managed = path.join(testRoot, "managed");
	const first = await beginOutputTransaction(managed);
	await writeFile(path.join(first.staging, "stale.html"), "stale");
	await writeOutputMarker(first.staging, ["stale.html"]);
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
	await assert.rejects(beginOutputTransaction(unmanaged), /not managed by htmlmogged/u);
	await assert.rejects(beginOutputTransaction(path.parse(testRoot).root), /filesystem root/u);
} finally {
	await rm(testRoot, { recursive: true, force: true });
}

console.log("exporter test passed");
