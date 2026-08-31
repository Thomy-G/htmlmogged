import path from "node:path";

import { FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";

import { HtmlExporter, type ExportResult } from "./exporter";

interface HtmlmoggedSettings {
  outputDirectory: string;
}

const DEFAULT_SETTINGS: HtmlmoggedSettings = { outputDirectory: "" };

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
    return this.exportFiles(this.app.vault.getMarkdownFiles(), destination);
  }

  private async exportFiles(files: TFile[], destination?: string): Promise<ExportResult> {
    if (this.exporting) throw new Error("an htmlmogged export is already running");
    this.exporting = true;
    try {
      const target = destination?.trim() || this.settings.outputDirectory || this.defaultOutputDirectory();
      new Notice(`htmlmogged is exporting ${files.length} note${files.length === 1 ? "" : "s"}…`);
      const result = await new HtmlExporter(this.app).export(files, target);
      new Notice(`htmlmogged wrote ${result.pagesWritten} pages to ${result.destination}`);
      return result;
    } finally {
      this.exporting = false;
    }
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
  constructor(private readonly htmlmogged: HtmlmoggedPlugin) {
    super(htmlmogged.app, htmlmogged);
  }

  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName("Output folder")
      .setDesc("Absolute folder for generated HTML. Leave blank to use .htmlmogged in this vault.")
      .addText((text) => text
        .setPlaceholder("/absolute/path/to/export")
        .setValue(this.htmlmogged.settings.outputDirectory)
        .onChange(async (value) => {
          this.htmlmogged.settings.outputDirectory = value.trim();
          await this.htmlmogged.saveData(this.htmlmogged.settings);
        }));
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
    }];
  }
}
