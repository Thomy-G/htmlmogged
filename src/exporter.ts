import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { App, Component, MarkdownRenderer, TFile } from "obsidian";

import { prepareOutputDirectory, writeOutputMarker } from "./output";
import { buildGraph, escapeHtml, linkFragment, makeOutputMap, safeJson, slug } from "./pure";

export interface ExportResult {
  destination: string;
  pagesWritten: number;
  startPage: string;
}

interface ImageResource {
  file: TFile;
  mime: string;
}

export class HtmlExporter {
  constructor(private readonly app: App) {}

  async export(files: TFile[], destination: string): Promise<ExportResult> {
    if (files.length === 0) throw new Error("there are no Markdown notes to export");

    const target = await prepareOutputDirectory(destination);
    const notes = files.map((file) => ({ path: file.path, basename: file.basename }));
    const outputs = makeOutputMap(notes);
    const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));
    const navigation = this.navigation(sortedFiles, outputs);
    const images = this.imageResources();

    for (const file of sortedFiles) {
      const output = outputs.get(file.path);
      if (!output) continue;
      const content = await this.render(file, outputs, images);
      const graph = buildGraph(notes, this.app.metadataCache.resolvedLinks, outputs, file.path);
      const title = this.title(file);
      await writeFile(
        path.join(target, output),
        this.page(title, content, navigation, graph),
        "utf8",
      );
    }

    const showcase = sortedFiles.find((file) => file.basename.toLowerCase() === "showcase") ?? sortedFiles[0];
    const startPage = showcase ? outputs.get(showcase.path) ?? "index.html" : "index.html";
    await writeFile(path.join(target, "index.html"), redirectPage(startPage), "utf8");
    await writeOutputMarker(target, ["index.html", ...outputs.values()]);
    return { destination: target, pagesWritten: sortedFiles.length + 1, startPage };
  }

  private title(file: TFile): string {
    const value: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.title;
    return typeof value === "string" && value.trim() ? value : file.basename;
  }

  private async render(
    file: TFile,
    outputs: ReadonlyMap<string, string>,
    images: ReadonlyMap<string, ImageResource>,
  ): Promise<string> {
    const component = new Component();
    const host = document.body.createDiv({ cls: ["markdown-rendered", "htmlmogged-render-host"] });
    component.load();

    try {
      const markdown = this.addBlockAnchorsToMarkdown(await this.app.vault.cachedRead(file), file);
      await MarkdownRenderer.render(this.app, markdown, host, file.path, component);
      await delay(50);
      const mermaidButtons = Array.from(host.querySelectorAll<HTMLButtonElement>(".mermaid-guard-actions button"));
      mermaidButtons.forEach((button) => button.click());
      if (mermaidButtons.length > 0 && !await waitFor(() => !host.querySelector(".mermaid-guard-actions"), 5000)) {
        throw new Error(`Mermaid did not render in ${file.path}`);
      }
      await waitFor(() => !host.querySelector(".lotus-js-graph-surface:empty"), 5000);
      await delay(100);

      const firstHeading = host.querySelector("h1");
      if (firstHeading?.textContent?.trim().toLowerCase() === this.title(file).trim().toLowerCase()) {
        const wrapper = firstHeading.parentElement;
        if (wrapper?.childElementCount === 1) wrapper.remove();
        else firstHeading.remove();
      }
      host.querySelectorAll("script").forEach((element) => element.remove());
      host.querySelectorAll(
        ".copy-code-button, .lotus-code-toolbar, .lotus-inline-output-host:empty, .lotus-output-image-toolbar",
      ).forEach((element) => element.remove());
      this.addAnchors(host);
      host.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((link) => {
        const linkPath = link.dataset.href ?? link.getAttribute("href") ?? "";
        const hashIndex = linkPath.indexOf("#");
        const notePath = hashIndex === -1 ? linkPath : linkPath.slice(0, hashIndex);
        const subpath = hashIndex === -1 ? "" : linkPath.slice(hashIndex + 1);
        const target = notePath ? this.app.metadataCache.getFirstLinkpathDest(notePath, file.path) : file;
        const output = target ? outputs.get(target.path) : undefined;
        if (output) {
          link.setAttribute("href", `${output}${linkFragment(subpath)}`);
          link.target = "_self";
        }
      });
      await this.inlineImages(host, images);
      host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((checkbox) => {
        checkbox.toggleAttribute("checked", checkbox.checked);
        checkbox.disabled = true;
      });
      return host.innerHTML;
    } finally {
      component.unload();
      host.remove();
    }
  }

  private addBlockAnchorsToMarkdown(markdown: string, file: TFile): string {
    const blockIds = new Set(Object.keys(this.app.metadataCache.getFileCache(file)?.blocks ?? {}));
    if (blockIds.size === 0) return markdown;

    return markdown.split("\n").map((line) => {
      const match = line.match(/(?:^|\s)\^([\w-]+)\s*$/u);
      const blockId = match?.[1];
      if (!match || !blockId || !blockIds.has(blockId)) return line;
      return `${line.slice(0, match.index)} <span id="block-${slug(blockId)}"></span>`;
    }).join("\n");
  }

  private addAnchors(host: HTMLElement): void {
    const used = new Map<string, number>();
    host.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6").forEach((heading) => {
      const base = slug(heading.textContent ?? "heading");
      const count = (used.get(base) ?? 0) + 1;
      used.set(base, count);
      heading.id = count === 1 ? base : `${base}-${count}`;
    });
    host.querySelectorAll<HTMLElement>("[data-block-id]").forEach((block) => {
      const blockId = block.dataset.blockId;
      if (blockId) block.id = `block-${slug(blockId)}`;
    });
  }

  private imageResources(): Map<string, ImageResource> {
    const resources = new Map<string, ImageResource>();
    for (const file of this.app.vault.getFiles()) {
      const mime = imageMime(file.extension);
      if (!mime) continue;
      resources.set(normalizeResource(this.app.vault.getResourcePath(file)), { file, mime });
    }
    return resources;
  }

  private async inlineImages(host: HTMLElement, resources: ReadonlyMap<string, ImageResource>): Promise<void> {
    await Promise.all(Array.from(host.querySelectorAll<HTMLImageElement>("img[src]"), async (image) => {
      const source = image.getAttribute("src");
      if (!source || source.startsWith("data:")) return;
      const resource = resources.get(normalizeResource(source)) ?? resources.get(normalizeResource(image.src));
      if (!resource) return;
      const data = Buffer.from(await this.app.vault.readBinary(resource.file)).toString("base64");
      image.setAttribute("src", `data:${resource.mime};base64,${data}`);
    }));
  }

  private navigation(files: TFile[], outputs: ReadonlyMap<string, string>): string {
    return files.map((file) => {
      const href = outputs.get(file.path) ?? "index.html";
      const title = this.title(file);
      return `<a class="note-link" data-note-title="${escapeHtml(title.toLowerCase())}" href="${escapeHtml(href)}">${escapeHtml(title)}</a>`;
    }).join("\n");
  }

  private page(
    title: string,
    content: string,
    navigation: string,
    graph: ReturnType<typeof buildGraph>,
  ): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="generator" content="htmlmogged 1.0.0">
  <title>${escapeHtml(title)}</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <header class="topbar">
    <a class="brand" href="index.html"><span>hm</span> htmlmogged</a>
    <button id="theme-toggle" type="button" aria-label="Toggle color theme">◐</button>
  </header>
  <div class="shell">
    <aside class="navigation">
      <label for="note-search">notes</label>
      <input id="note-search" type="search" placeholder="filter notes…" autocomplete="off">
      <nav>${navigation}</nav>
    </aside>
    <main>
      <article>
        <p class="eyebrow">exported note</p>
        <h1 class="page-title">${escapeHtml(title)}</h1>
        <div class="note-content">${content}</div>
      </article>
    </main>
    <aside class="graph-card">
      <div class="graph-heading">
        <div><p class="eyebrow">vault map</p><h2>interactive graph</h2></div>
        <span>${graph.nodes.length} nodes</span>
      </div>
      <svg id="link-graph" viewBox="0 0 360 320" role="img" aria-label="Interactive graph of linked notes"></svg>
      <p class="graph-help">drag nodes · click to open</p>
    </aside>
  </div>
  <script id="graph-data" type="application/json">${safeJson(graph)}</script>
  <script>${PAGE_SCRIPT}</script>
</body>
</html>`;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitFor(condition: () => boolean, timeout: number): Promise<boolean> {
  const started = Date.now();
  while (!condition() && Date.now() - started < timeout) await delay(25);
  return condition();
}

function redirectPage(target: string): string {
  const safeTarget = escapeHtml(target);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safeTarget}"><title>htmlmogged</title></head><body><a href="${safeTarget}">open exported notes</a></body></html>`;
}

function normalizeResource(value: string): string {
  const resource = value.split(/[?#]/u, 1)[0] ?? value;
  try {
    return decodeURI(resource);
  } catch {
    return resource;
  }
}

function imageMime(extension: string): string | undefined {
  return ({
    avif: "image/avif",
    bmp: "image/bmp",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    svg: "image/svg+xml",
    webp: "image/webp",
  } as Record<string, string>)[extension.toLowerCase()];
}

const PAGE_STYLES = String.raw`
:root {
  color-scheme: dark;
  --bg: #080b14;
  --panel: rgba(17, 24, 39, .76);
  --panel-solid: #111827;
  --line: rgba(148, 163, 184, .18);
  --text: #e8edf7;
  --muted: #94a3b8;
  --violet: #a78bfa;
  --cyan: #22d3ee;
  --glow: rgba(124, 58, 237, .24);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #f5f7ff;
  --panel: rgba(255, 255, 255, .82);
  --panel-solid: #fff;
  --line: rgba(51, 65, 85, .14);
  --text: #172033;
  --muted: #64748b;
  --violet: #6d28d9;
  --cyan: #0891b2;
  --glow: rgba(124, 58, 237, .12);
}
* { box-sizing: border-box; }
html { min-height: 100%; background: var(--bg); }
body {
  min-height: 100vh;
  margin: 0;
  color: var(--text);
  background:
    radial-gradient(circle at 78% 4%, var(--glow), transparent 30rem),
    radial-gradient(circle at 8% 80%, rgba(34, 211, 238, .08), transparent 28rem),
    var(--bg);
}
a { color: var(--cyan); text-decoration: none; }
a:hover { color: var(--violet); }
.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: blur(18px);
}
.brand { color: var(--text); font-weight: 750; letter-spacing: -.02em; }
.brand span {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  margin-right: 8px;
  border-radius: 9px;
  color: white;
  background: linear-gradient(135deg, #7c3aed, #0891b2);
  box-shadow: 0 0 24px var(--glow);
}
button, input { font: inherit; }
#theme-toggle {
  width: 36px;
  height: 36px;
  border: 1px solid var(--line);
  border-radius: 10px;
  color: var(--text);
  background: var(--panel);
  cursor: pointer;
}
.shell {
  width: min(1540px, 100%);
  margin: 0 auto;
  padding: 28px;
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr) 360px;
  gap: 24px;
  align-items: start;
}
.navigation, .graph-card, article {
  border: 1px solid var(--line);
  border-radius: 18px;
  background: var(--panel);
  box-shadow: 0 20px 60px rgba(0, 0, 0, .14);
  backdrop-filter: blur(16px);
}
.navigation, .graph-card { position: sticky; top: 92px; }
.navigation { padding: 16px; }
.navigation label, .eyebrow {
  margin: 0 0 8px;
  color: var(--muted);
  font-size: .72rem;
  font-weight: 750;
  letter-spacing: .12em;
  text-transform: uppercase;
}
#note-search {
  width: 100%;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  outline: none;
  color: var(--text);
  background: color-mix(in srgb, var(--panel-solid) 74%, transparent);
}
#note-search:focus { border-color: var(--violet); box-shadow: 0 0 0 3px var(--glow); }
.navigation nav { display: grid; gap: 4px; max-height: calc(100vh - 190px); overflow: auto; }
.note-link { padding: 8px 10px; border-radius: 8px; color: var(--muted); font-size: .9rem; }
.note-link:hover { color: var(--text); background: var(--glow); }
.note-link[hidden] { display: none; }
main { min-width: 0; }
article { padding: clamp(24px, 5vw, 64px); }
.page-title {
  margin: 0 0 36px;
  font-size: clamp(2.3rem, 7vw, 5.5rem);
  line-height: .95;
  letter-spacing: -.065em;
  background: linear-gradient(110deg, var(--text) 25%, var(--violet), var(--cyan));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.note-content { line-height: 1.75; font-size: 1.03rem; }
.note-content > :first-child { margin-top: 0; }
.note-content h1, .note-content h2, .note-content h3 { margin-top: 2.2em; line-height: 1.18; letter-spacing: -.025em; }
.note-content h2 { padding-bottom: .4em; border-bottom: 1px solid var(--line); }
.note-content p, .note-content ul, .note-content ol { color: color-mix(in srgb, var(--text) 88%, var(--muted)); }
.note-content code { padding: .18em .4em; border: 1px solid var(--line); border-radius: 6px; color: var(--cyan); background: var(--panel-solid); }
.note-content pre { overflow: auto; padding: 18px; border: 1px solid var(--line); border-radius: 14px; background: #080c16; }
.note-content pre code { padding: 0; border: 0; color: #dbeafe; background: none; }
.note-content table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; overflow: hidden; border-radius: 12px; }
.note-content th, .note-content td { padding: 11px 14px; border: 1px solid var(--line); text-align: left; }
.note-content th { color: var(--cyan); background: var(--glow); }
.note-content > iframe, .lotus-output-html-iframe { display: block; width: 100%; min-height: 520px; border: 0; background: white; }
.callout { margin: 1.6rem 0; padding: 16px 18px; border: 1px solid color-mix(in srgb, var(--violet) 55%, transparent); border-left: 4px solid var(--violet); border-radius: 12px; background: var(--glow); }
.callout-title { display: flex; gap: 8px; align-items: center; font-weight: 750; color: var(--violet); }
.callout-icon svg { width: 18px; height: 18px; }
.task-list-item { list-style: none; }
.task-list-item-checkbox { accent-color: var(--violet); }
.mermaid { display: grid; place-items: center; margin: 2rem 0; overflow: auto; }
.mermaid svg { max-width: 100%; height: auto; }
.lotus-managed-display, .lotus-output-display { display: grid; gap: 8px; }
.lotus-output-display { margin: 1.5rem 0; }
.lotus-output-stream-label { color: var(--muted); font-size: .75rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.lotus-output-html-frame, .lotus-js-graph-frame { overflow: hidden; border: 1px solid var(--line); border-radius: 12px; background: white; }
.lotus-js-graph-surface { width: 100%; margin: auto; color: #111; background: white; }
.lotus-js-graph-svg { display: block; max-width: 100%; background: white; }
.lotus-js-graph-print-snapshot { display: none; width: 100%; height: auto; background: white; }
.lotus-js-graph-has-print-snapshot > .lotus-js-graph-print-snapshot { display: block; }
.lotus-js-graph-has-print-snapshot > :not(.lotus-js-graph-print-snapshot) { display: none; }
.lotus-output-image-viewport { overflow: auto; border-radius: 12px; background: white; }
.lotus-output-image { display: block; max-width: 100% !important; height: auto !important; margin: auto; }
.lotus-output-pre { overflow: auto; padding: 18px; border: 1px solid var(--line); border-radius: 12px; background: #080c16; }
.graph-card { padding: 18px; overflow: hidden; }
.graph-heading { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
.graph-heading h2 { margin: 0; font-size: 1.05rem; letter-spacing: -.02em; }
.graph-heading span { padding: 5px 8px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: .72rem; }
#link-graph { width: 100%; min-height: 320px; touch-action: none; }
.graph-edge { stroke: color-mix(in srgb, var(--muted) 42%, transparent); stroke-width: 1.2; }
.graph-node { cursor: grab; outline: none; }
.graph-node:active { cursor: grabbing; }
.graph-node circle { fill: var(--panel-solid); stroke: var(--cyan); stroke-width: 2; transition: r .15s, fill .15s; }
.graph-node:hover circle, .graph-node:focus circle { fill: var(--glow); stroke: var(--violet); r: 10; }
.graph-node.current circle { fill: #7c3aed; stroke: #c4b5fd; stroke-width: 3; }
.graph-node text { fill: var(--text); font: 600 10px ui-sans-serif, system-ui; paint-order: stroke; stroke: var(--bg); stroke-width: 3px; stroke-linejoin: round; }
.graph-help { margin: 0; text-align: center; color: var(--muted); font-size: .75rem; }
@media (max-width: 1120px) {
  .shell { grid-template-columns: 190px minmax(0, 1fr); }
  .graph-card { position: relative; top: 0; grid-column: 1 / -1; }
}
@media (max-width: 720px) {
  .shell { display: block; padding: 14px; }
  .navigation, .graph-card { position: relative; top: 0; margin-bottom: 14px; }
  .navigation nav { max-height: 180px; }
  article { padding: 24px; }
}
`;

const PAGE_SCRIPT = String.raw`
(() => {
  const root = document.documentElement;
  const savedTheme = localStorage.getItem("htmlmogged-theme");
  if (savedTheme) root.dataset.theme = savedTheme;
  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
    localStorage.setItem("htmlmogged-theme", root.dataset.theme);
  });

  const search = document.getElementById("note-search");
  search?.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    document.querySelectorAll("[data-note-title]").forEach((link) => {
      link.hidden = !link.dataset.noteTitle.includes(query);
    });
  });

  const data = JSON.parse(document.getElementById("graph-data").textContent);
  const svg = document.getElementById("link-graph");
  const namespace = "http://www.w3.org/2000/svg";
  const current = data.nodes.find((node) => node.id === data.current);
  const others = data.nodes.filter((node) => node.id !== data.current);
  const positions = new Map();
  if (current) positions.set(current.id, { x: 180, y: 160 });
  others.forEach((node, index) => {
    const angle = (index / Math.max(others.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const ring = 112 + (index % 2) * 22;
    positions.set(node.id, { x: 180 + Math.cos(angle) * ring, y: 160 + Math.sin(angle) * ring });
  });

  const edgeElements = data.edges.map((edge) => {
    const line = document.createElementNS(namespace, "line");
    line.classList.add("graph-edge");
    svg.append(line);
    return { edge, line };
  });

  function updateEdges() {
    edgeElements.forEach(({ edge, line }) => {
      const source = positions.get(edge.source);
      const target = positions.get(edge.target);
      if (!source || !target) return;
      line.setAttribute("x1", source.x);
      line.setAttribute("y1", source.y);
      line.setAttribute("x2", target.x);
      line.setAttribute("y2", target.y);
    });
  }

  function point(event) {
    const value = svg.createSVGPoint();
    value.x = event.clientX;
    value.y = event.clientY;
    return value.matrixTransform(svg.getScreenCTM().inverse());
  }

  let zoom = 1;
  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoom = Math.max(1, Math.min(2.5, zoom * (event.deltaY < 0 ? 1.12 : .89)));
    const width = 360 / zoom;
    const height = 320 / zoom;
    svg.setAttribute("viewBox", (180 - width / 2) + " " + (160 - height / 2) + " " + width + " " + height);
  }, { passive: false });

  data.nodes.forEach((node) => {
    const position = positions.get(node.id);
    if (!position) return;
    const group = document.createElementNS(namespace, "g");
    const circle = document.createElementNS(namespace, "circle");
    const label = document.createElementNS(namespace, "text");
    const title = document.createElementNS(namespace, "title");
    group.classList.add("graph-node");
    if (node.id === data.current) group.classList.add("current");
    group.setAttribute("tabindex", "0");
    group.setAttribute("role", "link");
    group.setAttribute("aria-label", "Open " + node.label);
    circle.setAttribute("r", node.id === data.current ? "11" : "7");
    label.setAttribute("x", "13");
    label.setAttribute("y", "4");
    label.textContent = node.label;
    title.textContent = node.label;
    group.append(circle, label, title);
    group.setAttribute("transform", "translate(" + position.x + " " + position.y + ")");
    svg.append(group);

    let dragged = false;
    let start = null;
    group.addEventListener("pointerdown", (event) => {
      start = point(event);
      dragged = false;
      group.setPointerCapture(event.pointerId);
    });
    group.addEventListener("pointermove", (event) => {
      if (!group.hasPointerCapture(event.pointerId) || !start) return;
      const next = point(event);
      if (Math.hypot(next.x - start.x, next.y - start.y) > 3) dragged = true;
      position.x = Math.max(10, Math.min(350, next.x));
      position.y = Math.max(10, Math.min(310, next.y));
      group.setAttribute("transform", "translate(" + position.x + " " + position.y + ")");
      updateEdges();
    });
    group.addEventListener("pointerup", (event) => {
      group.releasePointerCapture(event.pointerId);
      if (!dragged) window.location.href = node.href;
      start = null;
    });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") window.location.href = node.href;
    });
  });
  updateEdges();
})();
`;
