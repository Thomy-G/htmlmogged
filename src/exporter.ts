import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { App, Component, MarkdownRenderer, TFile } from "obsidian";

import { beginOutputTransaction, writeOutputMarker } from "./output";
import { buildGraph, escapeHtml, linkFragment, makeOutputMap, safeJson, slug } from "./pure";

export interface ExportResult {
  destination: string;
  pagesWritten: number;
  startPage: string;
}

interface VaultResource {
  file: TFile;
  mime: string;
  output?: string;
}

export class HtmlExporter {
  private readonly resourceData = new Map<string, Promise<string>>();
  private readonly resourceWrites = new Map<string, Promise<void>>();

  constructor(private readonly app: App) {}

  async export(files: TFile[], destination: string, landingPath?: string): Promise<ExportResult> {
    if (files.length === 0) throw new Error("there are no Markdown notes to export");

    const transaction = await beginOutputTransaction(destination);
    const target = transaction.staging;
    const notes = files.map((file) => ({ path: file.path, basename: file.basename }));
    const outputs = makeOutputMap(notes);
    const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));
    const navigation = this.navigation(sortedFiles, outputs);
    const resources = this.vaultResources();

    try {
      const searchEntries = await Promise.all(sortedFiles.map(async (file) => [
        outputs.get(file.path) ?? "index.html",
        `${this.title(file)}\n${await this.app.vault.cachedRead(file)}`.toLowerCase(),
      ] as const));
      await writeFile(
        path.join(target, "search-index.js"),
        `globalThis.HTMLMOGGED_SEARCH=${safeJson(Object.fromEntries(searchEntries))};`,
        "utf8",
      );
      for (const file of sortedFiles) {
        const output = outputs.get(file.path);
        if (!output) continue;
        const content = await this.render(file, outputs, resources, target);
        const graph = buildGraph(notes, this.app.metadataCache.resolvedLinks, outputs, file.path);
        const title = this.title(file);
        await writeFile(
          path.join(target, output),
          this.page(title, content, navigation, graph),
          "utf8",
        );
      }

      const landing = sortedFiles.find((file) => file.path === landingPath)
        ?? sortedFiles.find((file) => file.basename.toLowerCase() === "showcase")
        ?? sortedFiles[0];
      const startPage = landing ? outputs.get(landing.path) ?? "index.html" : "index.html";
      await writeFile(path.join(target, "index.html"), redirectPage(startPage), "utf8");
      await writeOutputMarker(target, ["index.html", "search-index.js", ...outputs.values()]);
      await transaction.commit();
      return { destination: transaction.destination, pagesWritten: sortedFiles.length + 1, startPage };
    } catch (error) {
      await transaction.abort();
      throw error;
    }
  }

  private title(file: TFile): string {
    const value: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.title;
    return typeof value === "string" && value.trim() ? value : file.basename;
  }

  private async render(
    file: TFile,
    outputs: ReadonlyMap<string, string>,
    resources: ReadonlyMap<string, VaultResource>,
    target: string,
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
      await waitFor(() => !host.querySelector(".lotus-output-display[data-lotus-render-state=\"pending\"]"), 5000);
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
        } else if (target) {
          link.setAttribute("href", this.app.vault.getResourcePath(target));
        }
      });
      await this.makeResourcesPortable(host, resources, target);
      host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((checkbox) => {
        checkbox.toggleAttribute("checked", checkbox.checked);
        checkbox.disabled = true;
      });
      const exported = host.cloneNode(true);
      if (!exported.instanceOf(HTMLElement)) throw new Error(`could not serialize ${file.path}`);
      exported.querySelectorAll<HTMLIFrameElement>("iframe[data-htmlmogged-pdf-src]").forEach((frame) => {
        const source = frame.dataset.htmlmoggedPdfSrc;
        if (!source) return;
        frame.src = source;
        delete frame.dataset.htmlmoggedPdfSrc;
      });
      return exported.innerHTML;
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

  private vaultResources(): Map<string, VaultResource> {
    const resources = new Map<string, VaultResource>();
    const used = new Set<string>();
    for (const file of [...this.app.vault.getFiles()].sort((a, b) => a.path.localeCompare(b.path))) {
      const mime = resourceMime(file.extension);
      if (!mime) continue;
      let output: string | undefined;
      if (!mime.startsWith("image/")) {
        const stem = slug(file.path.slice(0, -(file.extension.length + 1)).replaceAll("/", "--"));
        let name = `${stem}.${file.extension.toLowerCase()}`;
        let suffix = 2;
        while (used.has(name)) name = `${stem}-${suffix++}.${file.extension.toLowerCase()}`;
        used.add(name);
        output = `assets/${name}`;
      }
      const resource = { file, mime, output };
      resources.set(normalizeResource(this.app.vault.getResourcePath(file)), resource);
      resources.set(normalizeResource(file.path), resource);
    }
    return resources;
  }

  private async makeResourcesPortable(
    host: HTMLElement,
    resources: ReadonlyMap<string, VaultResource>,
    target: string,
  ): Promise<void> {
    const pdfEmbeds = Array.from(host.querySelectorAll<HTMLElement>(".internal-embed.pdf-embed[src]"));
    await Promise.all(pdfEmbeds.map(async (embed) => {
      const source = embed.getAttribute("src");
      const resource = source ? resources.get(normalizeResource(source)) : undefined;
      if (!source || resource?.mime !== "application/pdf") return;
      const frame = createEl("iframe");
      frame.className = "htmlmogged-pdf-embed";
      frame.title = embed.getAttribute("alt") ?? resource.file.basename;
      frame.dataset.htmlmoggedPdfSrc = await this.portableResource(resource, target);
      embed.replaceWith(frame);
    }));
    const targets = [
      ...Array.from(host.querySelectorAll<HTMLElement>("img[src], audio[src], video[src], source[src], embed[src]"), (element) => ({ element, attribute: "src" })),
      ...Array.from(host.querySelectorAll<HTMLElement>("object[data]"), (element) => ({ element, attribute: "data" })),
      ...Array.from(host.querySelectorAll<HTMLAnchorElement>("a[href]"), (element) => ({ element, attribute: "href" })),
    ];
    await Promise.all(targets.map(async ({ element, attribute }) => {
      const source = element.getAttribute(attribute);
      if (!source || source.startsWith("data:")) return;
      const absolute = attribute === "href" && element.instanceOf(HTMLAnchorElement) ? element.href : source;
      const resource = resources.get(normalizeResource(source)) ?? resources.get(normalizeResource(absolute));
      if (!resource) return;
      element.setAttribute(attribute, await this.portableResource(resource, target));
      if (element.instanceOf(HTMLAnchorElement)) element.download = resource.file.name;
    }));
  }

  private async portableResource(resource: VaultResource, target: string): Promise<string> {
    if (resource.output) {
      let write = this.resourceWrites.get(resource.file.path);
      if (!write) {
        write = this.app.vault.readBinary(resource.file).then(async (data) => {
          await mkdir(path.join(target, "assets"), { recursive: true });
          await writeFile(path.join(target, resource.output ?? ""), Buffer.from(data));
        });
        this.resourceWrites.set(resource.file.path, write);
      }
      await write;
      return resource.output;
    }

    let dataUrl = this.resourceData.get(resource.file.path);
    if (!dataUrl) {
      dataUrl = this.app.vault.readBinary(resource.file).then((data) =>
        `data:${resource.mime};base64,${Buffer.from(data).toString("base64")}`);
      this.resourceData.set(resource.file.path, dataUrl);
    }
    return dataUrl;
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
  <meta name="generator" content="HTMLmogged 1.0.0">
  <title>${escapeHtml(title)}</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <header class="topbar">
    <a class="brand" href="index.html">HTMLmogged</a>
    <div class="topbar-actions">
      <div class="mobile-controls" aria-label="Page panels">
        <button id="notes-toggle" type="button" aria-controls="notes-panel" aria-expanded="false">Notes</button>
        <button id="graph-toggle" type="button" aria-controls="graph-panel" aria-expanded="false">Graph</button>
      </div>
      <button id="theme-toggle" type="button">Light theme</button>
    </div>
  </header>
  <div class="shell">
    <aside id="notes-panel" class="navigation">
      <label for="note-search">Notes</label>
      <input id="note-search" type="search" placeholder="Filter notes…" autocomplete="off">
      <nav>${navigation}</nav>
    </aside>
    <main>
      <article>
        <p class="eyebrow">Exported note</p>
        <h1 class="page-title">${escapeHtml(title)}</h1>
        <div class="note-content">${content}</div>
      </article>
    </main>
    <aside id="graph-panel" class="graph-card">
      <div class="graph-heading">
        <div><p class="eyebrow">Vault map</p><h2>Interactive graph</h2></div>
        <span>${graph.nodes.length} nodes</span>
      </div>
      <svg id="link-graph" viewBox="0 0 360 320" role="img" aria-label="Interactive graph of linked notes"></svg>
      <p class="graph-help">Drag nodes · click to open · scroll to zoom</p>
    </aside>
  </div>
  <script id="graph-data" type="application/json">${safeJson(graph)}</script>
  <script src="search-index.js"></script>
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safeTarget}"><title>HTMLmogged</title></head><body><a href="${safeTarget}">Open exported notes</a></body></html>`;
}

function normalizeResource(value: string): string {
  const resource = value.split(/[?#]/u, 1)[0] ?? value;
  try {
    return decodeURI(resource);
  } catch {
    return resource;
  }
}

function resourceMime(extension: string): string | undefined {
  return ({
    avif: "image/avif",
    bmp: "image/bmp",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    svg: "image/svg+xml",
    webp: "image/webp",
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    oga: "audio/ogg",
    ogg: "audio/ogg",
    wav: "audio/wav",
    mov: "video/quicktime",
    mp4: "video/mp4",
    ogv: "video/ogg",
    webm: "video/webm",
    pdf: "application/pdf",
  } as Record<string, string>)[extension.toLowerCase()];
}

const PAGE_STYLES = String.raw`
:root {
  color-scheme: dark;
  --bg: #202020;
  --panel: #262626;
  --panel-solid: #1e1e1e;
  --hover: #363636;
  --line: #3a3a3a;
  --text: #dcddde;
  --muted: #999;
  --accent: #8b7cf6;
  --code-bg: #171717;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #fff;
  --panel: #f6f6f6;
  --panel-solid: #fff;
  --hover: #e9e9e9;
  --line: #ddd;
  --text: #2e3338;
  --muted: #6b6b6b;
  --accent: #705dcf;
  --code-bg: #f5f5f5;
}
* { box-sizing: border-box; }
html { min-height: 100%; background: var(--bg); }
body {
  min-height: 100vh;
  margin: 0;
  color: var(--text);
  background: var(--bg);
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.brand { color: var(--text); font-weight: 600; }
button, input { font: inherit; }
.topbar-actions, .mobile-controls { display: flex; align-items: center; gap: 6px; }
.mobile-controls { display: none; }
#theme-toggle, .mobile-controls button {
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--text);
  background: var(--panel-solid);
  cursor: pointer;
}
.shell {
  width: 100%;
  min-height: calc(100vh - 48px);
  margin: 0 auto;
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr) 320px;
  align-items: start;
}
.navigation, .graph-card, article {
  background: transparent;
}
.navigation, .graph-card { position: sticky; top: 48px; height: calc(100vh - 48px); background: var(--panel); }
.navigation { padding: 16px 12px; border-right: 1px solid var(--line); }
.navigation label, .eyebrow {
  margin: 0 0 8px;
  color: var(--muted);
  font-size: .75rem;
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
}
#note-search {
  width: 100%;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 4px;
  outline: none;
  color: var(--text);
  background: var(--panel-solid);
}
#note-search:focus { border-color: var(--accent); }
.navigation nav { display: grid; gap: 2px; max-height: calc(100vh - 138px); overflow: auto; }
.note-link { padding: 6px 8px; border-radius: 4px; color: var(--muted); font-size: .9rem; }
.note-link:hover { color: var(--text); background: var(--hover); text-decoration: none; }
.note-link[hidden] { display: none; }
main { min-width: 0; }
article { width: min(760px, 100%); margin: 0 auto; padding: 48px 32px 80px; }
.page-title {
  margin: 0 0 32px;
  color: var(--text);
  font-size: 2.25rem;
  line-height: 1.2;
  letter-spacing: -.025em;
}
.note-content { line-height: 1.75; font-size: 1.03rem; }
.note-content > :first-child { margin-top: 0; }
.note-content h1, .note-content h2, .note-content h3 { margin-top: 2.2em; line-height: 1.18; letter-spacing: -.025em; }
.note-content h2 { padding-bottom: .4em; border-bottom: 1px solid var(--line); }
.note-content p, .note-content ul, .note-content ol { color: var(--text); }
.note-content code { padding: .18em .4em; border-radius: 3px; color: var(--text); background: var(--code-bg); }
.note-content pre { overflow: auto; padding: 16px; border: 1px solid var(--line); border-radius: 4px; background: var(--code-bg); }
.note-content pre code { padding: 0; border: 0; color: inherit; background: none; }
.note-content table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; overflow: hidden; border-radius: 12px; }
.note-content th, .note-content td { padding: 11px 14px; border: 1px solid var(--line); text-align: left; }
.note-content th { color: var(--text); background: var(--panel); }
.note-content > iframe, .lotus-output-html-iframe { display: block; width: 100%; min-height: 520px; border: 0; background: white; }
.htmlmogged-pdf-embed { min-height: 70vh; border-radius: 4px; }
.callout { margin: 1.6rem 0; padding: 14px 16px; border-left: 3px solid var(--accent); border-radius: 3px; background: var(--panel); }
.callout-title { display: flex; gap: 8px; align-items: center; font-weight: 600; color: var(--text); }
.callout-icon svg { width: 18px; height: 18px; }
.task-list-item { list-style: none; }
.task-list-item-checkbox { accent-color: var(--violet); }
.mermaid { display: grid; place-items: center; margin: 2rem 0; overflow: auto; }
.mermaid svg { max-width: 100%; height: auto; }
.lotus-managed-display, .lotus-output-display { display: grid; gap: 8px; }
.lotus-output-display { margin: 1.5rem 0; }
.lotus-output-stream-label { color: var(--muted); font-size: .75rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.lotus-output-html-frame, .lotus-js-graph-frame { overflow: hidden; border: 1px solid var(--line); border-radius: 4px; background: white; }
.lotus-js-graph-surface { width: 100%; margin: auto; color: #111; background: white; }
.lotus-js-graph-svg { display: block; max-width: 100%; background: white; }
.lotus-js-graph-print-snapshot { display: none; width: 100%; height: auto; background: white; }
.lotus-js-graph-has-print-snapshot > .lotus-js-graph-print-snapshot { display: block; }
.lotus-js-graph-has-print-snapshot > :not(.lotus-js-graph-print-snapshot) { display: none; }
.lotus-output-image-viewport { overflow: auto; border-radius: 4px; background: white; }
.lotus-output-image { display: block; max-width: 100% !important; height: auto !important; margin: auto; }
.lotus-output-pre { overflow: auto; padding: 16px; border: 1px solid var(--line); border-radius: 4px; background: var(--code-bg); }
.graph-card { padding: 16px; overflow: hidden; border-left: 1px solid var(--line); }
.graph-heading { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
.graph-heading h2 { margin: 0; font-size: 1rem; }
.graph-heading span { color: var(--muted); font-size: .75rem; }
#link-graph { width: 100%; min-height: 320px; touch-action: none; }
.graph-edge { stroke: var(--line); stroke-width: 1.2; }
.graph-node { cursor: grab; outline: none; }
.graph-node:active { cursor: grabbing; }
.graph-node circle { fill: var(--panel-solid); stroke: var(--muted); stroke-width: 1.5; }
.graph-node:hover circle, .graph-node:focus circle { stroke: var(--accent); r: 10; }
.graph-node.current circle { fill: var(--accent); stroke: var(--accent); stroke-width: 2; }
.graph-node text { opacity: 0; fill: var(--text); font: 600 10px ui-sans-serif, system-ui; paint-order: stroke; stroke: var(--panel); stroke-width: 3px; stroke-linejoin: round; pointer-events: none; }
.graph-node:hover text, .graph-node:focus text, .graph-node.current text { opacity: 1; }
.graph-help { margin: 0; text-align: center; color: var(--muted); font-size: .75rem; }
@media (max-width: 1120px) {
  .shell { display: block; }
  .mobile-controls { display: flex; }
  .navigation, .graph-card {
    display: none;
    position: fixed;
    top: 48px;
    bottom: 0;
    z-index: 9;
    width: min(320px, 100%);
    height: auto;
    overflow: auto;
    box-shadow: 0 12px 32px #0006;
  }
  .navigation { left: 0; }
  .graph-card { right: 0; }
  body[data-panel="notes"] .navigation, body[data-panel="graph"] .graph-card { display: block; }
}
@media (max-width: 720px) {
  article { padding: 24px; }
}
@media (max-width: 420px) {
  .topbar { padding: 0 8px; }
  #theme-toggle, .mobile-controls button { padding: 0 7px; }
}
`;

const PAGE_SCRIPT = String.raw`
(() => {
  const root = document.documentElement;
  let savedTheme = null;
  try {
    savedTheme = localStorage.getItem("htmlmogged-theme");
  } catch {
    // Some browsers deny storage to local file:// exports; the page still works without it.
  }
  if (savedTheme) root.dataset.theme = savedTheme;
  else if (globalThis.matchMedia?.("(prefers-color-scheme: light)").matches) root.dataset.theme = "light";

  const themeToggle = document.getElementById("theme-toggle");
  function updateThemeToggle() {
    const next = root.dataset.theme === "light" ? "Dark" : "Light";
    if (!themeToggle) return;
    themeToggle.textContent = next + " theme";
    themeToggle.setAttribute("aria-label", "Switch to " + next.toLowerCase() + " theme");
  }
  updateThemeToggle();
  themeToggle?.addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
    updateThemeToggle();
    try {
      localStorage.setItem("htmlmogged-theme", root.dataset.theme);
    } catch {
      // Keep the theme for this page even when local storage is unavailable.
    }
  });

  const panelButtons = ["notes", "graph"].map((panel) => ({
    panel,
    button: document.getElementById(panel + "-toggle"),
  }));
  function setPanel(panel) {
    document.body.dataset.panel = document.body.dataset.panel === panel ? "" : panel;
    panelButtons.forEach(({ panel: name, button }) => {
      button?.setAttribute("aria-expanded", String(document.body.dataset.panel === name));
    });
  }
  panelButtons.forEach(({ panel, button }) => button?.addEventListener("click", () => setPanel(panel)));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.dataset.panel) setPanel(document.body.dataset.panel);
  });

  const search = document.getElementById("note-search");
  search?.addEventListener("input", () => {
    const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    document.querySelectorAll("[data-note-title]").forEach((link) => {
      const haystack = globalThis.HTMLMOGGED_SEARCH?.[link.getAttribute("href")] ?? link.dataset.noteTitle;
      link.hidden = !terms.every((term) => haystack.includes(term));
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
      if (group.hasPointerCapture(event.pointerId)) group.releasePointerCapture(event.pointerId);
      start = null;
    });
    group.addEventListener("pointercancel", () => {
      start = null;
      dragged = true;
    });
    group.addEventListener("click", () => {
      if (!dragged) window.location.href = node.href;
    });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") window.location.href = node.href;
    });
  });
  updateEdges();
})();
`;
