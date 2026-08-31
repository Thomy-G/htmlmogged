export interface NoteRef {
  path: string;
  basename: string;
}

export interface GraphNode {
  id: string;
  label: string;
  href: string;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  current: string;
}

export function slug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/g, "") || "note";
}

export function makeOutputMap(notes: readonly NoteRef[]): Map<string, string> {
  const outputs = new Map<string, string>();
  const used = new Set(["index.html"]);

  for (const note of [...notes].sort((a, b) => a.path.localeCompare(b.path))) {
    const stem = slug(note.path.replace(/\.md$/iu, "").replaceAll("/", "--"));
    let candidate = `${stem}.html`;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${stem}-${suffix++}.html`;
    used.add(candidate);
    outputs.set(note.path, candidate);
  }

  return outputs;
}

export function buildGraph(
  notes: readonly NoteRef[],
  resolvedLinks: Readonly<Record<string, Readonly<Record<string, number>>>>,
  outputs: ReadonlyMap<string, string>,
  current: string,
): GraphData {
  const nodes = notes.map((note) => ({
    id: note.path,
    label: note.basename,
    href: outputs.get(note.path) ?? "index.html",
  }));
  const edges: GraphEdge[] = [];

  for (const note of notes) {
    for (const target of Object.keys(resolvedLinks[note.path] ?? {})) {
      if (outputs.has(target)) edges.push({ source: note.path, target });
    }
  }

  return { nodes, edges, current };
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

export function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function linkFragment(subpath: string): string {
  if (!subpath) return "";
  return subpath.startsWith("^")
    ? `#block-${slug(subpath.slice(1))}`
    : `#${slug(subpath)}`;
}
