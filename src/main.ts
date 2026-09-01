import path from "node:path";

import { FileSystemAdapter, getAllTags, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";

import { HtmlExporter, type ExportResult } from "./exporter";
import { matchesExportFilters, parseList } from "./pure";

interface HtmlmoggedSettings {
  outputDirectory: string;
  landingNote: string;
  includeFolders: string;
  excludeFolders: string;
  includeTags: string;
  excludeTags: string;
  selectedNotes: string[];
}

const DEFAULT_SETTINGS: HtmlmoggedSettings = {
  outputDirectory: "",
  landingNote: "",
  includeFolders: "",
  excludeFolders: "",
  includeTags: "",
  excludeTags: "",
  selectedNotes: [],
};

export default class HtmlmoggedPlugin extends Plugin {
  settings: HtmlmoggedSettings = DEFAULT_SETTINGS;
  private exporting = false;

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<HtmlmoggedSettings> | null);
    this.addSettingTab(new HtmlmoggedSettingTab(this));

    this.addRibbonIcon("folder-up", "Choose notes to export", () => this.openNotePicker());

    this.addCommand({
      id: "export-current-note",
      name: "Export current note",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("Htmlmogged: open a note first");
          return;
        }
        void this.exportFiles([file]).catch((error: unknown) => this.showError(error));
      },
    });

    this.addCommand({
      id: "choose-notes-to-export",
      name: "Choose notes to export",
      callback: () => this.openNotePicker(),
    });

    this.addCommand({
      id: "export-vault",
      name: "Export vault",
      callback: () => void this.exportVault().catch((error: unknown) => this.showError(error)),
    });
  }

  async exportVault(destination?: string): Promise<ExportResult> {
    return this.exportFiles(this.exportableFiles(), destination);
  }

  async exportSelection(files: TFile[]): Promise<ExportResult> {
    this.settings.selectedNotes = files.map((file) => file.path);
    await this.saveData(this.settings);
    return this.exportFiles(files);
  }

  private exportableFiles(): TFile[] {
    const filters = {
      includeFolders: parseList(this.settings.includeFolders),
      excludeFolders: parseList(this.settings.excludeFolders),
      includeTags: parseList(this.settings.includeTags),
      excludeTags: parseList(this.settings.excludeTags),
    };
    return this.app.vault.getMarkdownFiles().filter((file) => {
      const cache = this.app.metadataCache.getFileCache(file);
      return matchesExportFilters(file.path, cache ? getAllTags(cache) ?? [] : [], filters);
    });
  }

  private openNotePicker(): void {
    new NotePickerModal(this, this.exportableFiles()).open();
  }

  private async exportFiles(files: TFile[], destination?: string): Promise<ExportResult> {
    if (this.exporting) throw new Error("an HTMLmogged export is already running");
    this.exporting = true;
    try {
      const target = destination?.trim() || this.settings.outputDirectory.trim() || this.defaultOutputDirectory();
      const landingPath = this.resolveLandingNote(files);
      new Notice(`HTMLmogged is exporting ${files.length} note${files.length === 1 ? "" : "s"}…`);
      const result = await new HtmlExporter(this.app).export(files, target, landingPath);
      new Notice(`HTMLmogged wrote ${result.pagesWritten} pages to ${result.destination}`);
      return result;
    } finally {
      this.exporting = false;
    }
  }

  private resolveLandingNote(files: readonly TFile[]): string | undefined {
    const link = this.settings.landingNote.trim();
    if (!link) return undefined;
    const file = this.app.metadataCache.getFirstLinkpathDest(link, "");
    if (!file) throw new Error(`landing note is missing: ${link}`);
    return files.some((candidate) => candidate.path === file.path) ? file.path : undefined;
  }

  private defaultOutputDirectory(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error("HTMLmogged requires a local desktop vault");
    return path.join(adapter.getBasePath(), ".htmlmogged");
  }

  private showError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error("HTMLmogged export failed", error);
    new Notice(`HTMLmogged export failed: ${message}`, 8000);
  }
}

class NotePickerModal extends Modal {
  constructor(private readonly htmlmogged: HtmlmoggedPlugin, private readonly files: TFile[]) {
    super(htmlmogged.app);
  }

  onOpen(): void {
    this.setTitle("Export notes");
    const selected = new Set(this.htmlmogged.settings.selectedNotes);
    if (selected.size === 0) {
      const active = this.app.workspace.getActiveFile();
      if (active) selected.add(active.path);
    }

    let rows: { file: TFile; setting: Setting }[] = [];
    let exportButton: { setDisabled(disabled: boolean): unknown };
    const controls = new Setting(this.contentEl)
      .setName("Choose notes")
      .setDesc(`${selected.size} selected`)
      .addSearch((search) => search
        .setPlaceholder("Filter notes")
        .onChange((value) => {
          const query = value.trim().toLowerCase();
          rows.forEach(({ file, setting }) => {
            setting.settingEl.hidden = !file.path.toLowerCase().includes(query);
          });
        }))
      .addButton((button) => {
        exportButton = button
          .setButtonText("Export")
          .setCta()
          .setDisabled(selected.size === 0)
          .onClick(async () => {
            const files = this.files.filter((file) => selected.has(file.path));
            this.close();
            await this.htmlmogged.exportSelection(files);
          });
      });

    const list = this.contentEl.createDiv({ cls: "htmlmogged-note-picker" });
    rows = this.files.map((file) => {
      const setting = new Setting(list)
        .setName(file.basename)
        .setDesc(file.path)
        .addToggle((toggle) => toggle
          .setValue(selected.has(file.path))
          .onChange((value) => {
            if (value) selected.add(file.path);
            else selected.delete(file.path);
            controls.setDesc(`${selected.size} selected`);
            exportButton.setDisabled(selected.size === 0);
          }));
      return { file, setting };
    });
  }

  onClose(): void {
    this.contentEl.empty();
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
