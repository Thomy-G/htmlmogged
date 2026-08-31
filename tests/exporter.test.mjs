import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prepareOutputDirectory, writeOutputMarker } from "../src/output.ts";
import { buildGraph, escapeHtml, linkFragment, makeOutputMap, safeJson } from "../src/pure.ts";

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

const testRoot = await mkdtemp(path.join(tmpdir(), "htmlmogged-test-"));
try {
	const managed = path.join(testRoot, "managed");
	assert.equal(await prepareOutputDirectory(managed), managed);
	assert.match(await readFile(path.join(managed, ".htmlmogged.json"), "utf8"), /"generator": "htmlmogged"/u);
	assert.equal(await prepareOutputDirectory(managed), managed);
	await writeFile(path.join(managed, "stale.html"), "stale");
	await writeOutputMarker(managed, ["stale.html"]);
	await writeOutputMarker(managed, ["current.html"]);
	await assert.rejects(readFile(path.join(managed, "stale.html")), /ENOENT/u);

	const unmanaged = path.join(testRoot, "unmanaged");
	await mkdir(unmanaged);
	await writeFile(path.join(unmanaged, "index.html"), "keep me");
	await assert.rejects(prepareOutputDirectory(unmanaged), /not managed by htmlmogged/u);
	await assert.rejects(prepareOutputDirectory(path.parse(testRoot).root), /filesystem root/u);
} finally {
	await rm(testRoot, { recursive: true, force: true });
}

console.log("exporter test passed");
