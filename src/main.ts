import path from "node:path";

import { FileSystemAdapter, getAllTags, Notice, Plugin, PluginSettingTab, TFile } from "obsidian";

import { HtmlExporter, type ExportResult } from "./exporter";
import { matchesExportFilters, parseList } from "./pure";

interface HtmlmoggedSettings {
  outputDirectory: string;
  landingNote: string;
  includeFolders: string;
  excludeFolders: string;
  includeTags: string;
  excludeTags: string;
}

const DEFAULT_SETTINGS: HtmlmoggedSettings = {
  outputDirectory: "",
  landingNote: "",
  includeFolders: "",
  excludeFolders: "",
  includeTags: "",
  excludeTags: "",
};

export default class HtmlmoggedPlugin extends Plugin {
  settings: HtmlmoggedSettings = DEFAULT_SETTINGS;
  private exporting = false;

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<HtmlmoggedSettings> | null);
    this.addSettingTab(new HtmlmoggedSettingTab(this));

    this.addRibbonIcon("folder-up", "Export vault with htmlmogged", () => {
      void this.exportVault().catch((error: unknown) => this.showError(error));
    });

    this.addCommand({
      id: "export-vault",
      name: "Export vault",
      callback: () => void this.exportVault().catch((error: unknown) => this.showError(error)),
    });
  }

  async exportVault(destination?: string): Promise<ExportResult> {
    const filters = {
      includeFolders: parseList(this.settings.includeFolders),
      excludeFolders: parseList(this.settings.excludeFolders),
      includeTags: parseList(this.settings.includeTags),
      excludeTags: parseList(this.settings.excludeTags),
    };
    const files = this.app.vault.getMarkdownFiles().filter((file) => {
      const cache = this.app.metadataCache.getFileCache(file);
      return matchesExportFilters(file.path, cache ? getAllTags(cache) ?? [] : [], filters);
    });
    return this.exportFiles(files, destination);
  }

  private async exportFiles(files: TFile[], destination?: string): Promise<ExportResult> {
    if (this.exporting) throw new Error("an htmlmogged export is already running");
    this.exporting = true;
    try {
      const target = destination?.trim() || this.settings.outputDirectory.trim() || this.defaultOutputDirectory();
      const landingPath = this.resolveLandingNote(files);
      new Notice(`htmlmogged is exporting ${files.length} note${files.length === 1 ? "" : "s"}…`);
      const result = await new HtmlExporter(this.app).export(files, target, landingPath);
      new Notice(`htmlmogged wrote ${result.pagesWritten} pages to ${result.destination}`);
      return result;
    } finally {
      this.exporting = false;
    }
  }

  private resolveLandingNote(files: readonly TFile[]): string | undefined {
    const link = this.settings.landingNote.trim();
    if (!link) return undefined;
    const file = this.app.metadataCache.getFirstLinkpathDest(link, "");
    if (!file || !files.some((candidate) => candidate.path === file.path)) {
      throw new Error(`landing note is missing or excluded: ${link}`);
    }
    return file.path;
  }

  private defaultOutputDirectory(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error("htmlmogged requires a local desktop vault");
    return path.join(adapter.getBasePath(), ".htmlmogged");
  }

  private showError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error("htmlmogged export failed", error);
    new Notice(`htmlmogged export failed: ${message}`, 8000);
  }
}

class HtmlmoggedSettingTab extends PluginSettingTab {
  constructor(htmlmogged: HtmlmoggedPlugin) {
    super(htmlmogged.app, htmlmogged);
  }

  getSettingDefinitions() {
    return [{
      name: "Output folder",
      desc: "Absolute folder for generated HTML. Leave blank to use .htmlmogged in this vault.",
      control: {
        type: "text" as const,
        key: "outputDirectory",
        placeholder: "/absolute/path/to/export",
      },
    }, {
      name: "Landing note",
      desc: "Note to open from index.html. Leave blank to prefer showcase, then the first note.",
      control: { type: "text" as const, key: "landingNote", placeholder: "Home" },
    }, {
      name: "Included folders",
      desc: "Comma-separated vault folders. Leave blank to include every folder.",
      control: { type: "text" as const, key: "includeFolders", placeholder: "Public, projects/site" },
    }, {
      name: "Excluded folders",
      desc: "Comma-separated vault folders to leave out of the export.",
      control: { type: "text" as const, key: "excludeFolders", placeholder: "Private, templates" },
    }, {
      name: "Included tags",
      desc: "Comma-separated tags. Leave blank to include notes with any tag.",
      control: { type: "text" as const, key: "includeTags", placeholder: "Publish, docs" },
    }, {
      name: "Excluded tags",
      desc: "Comma-separated tags to leave out of the export.",
      control: { type: "text" as const, key: "excludeTags", placeholder: "Private, draft" },
    }];
  }
}
