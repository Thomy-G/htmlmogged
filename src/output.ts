import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MARKER = ".htmlmogged.json";

interface OutputMarker {
  generator: "htmlmogged";
  version: 1;
  pages: string[];
}

export interface OutputTransaction {
  destination: string;
  staging: string;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

export async function beginOutputTransaction(destination: string): Promise<OutputTransaction> {
  if (!path.isAbsolute(destination)) throw new Error("export folder must be an absolute path");
  const requested = path.resolve(destination);
  if (requested === path.parse(requested).root) throw new Error("refusing to export into the filesystem root");

  await mkdir(path.dirname(requested), { recursive: true });
  const parent = await realpath(path.dirname(requested));
  const target = path.join(parent, path.basename(requested));
  const exists = await validateExistingTarget(target);
  const staging = await mkdtemp(path.join(parent, `.${path.basename(target)}.htmlmogged-`));
  let finished = false;

  return {
    destination: target,
    staging,
    async commit() {
      if (finished) throw new Error("export transaction is already finished");
      await readMarker(staging);
      const backup = `${staging}-previous`;
      if (exists) await rename(target, backup);
      try {
        await rename(staging, target);
      } catch (error) {
        if (exists) await rename(backup, target);
        throw error;
      }
      finished = true;
      if (exists) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    },
    async abort() {
      if (finished) return;
      finished = true;
      await rm(staging, { recursive: true, force: true });
    },
  };
}

export async function writeOutputMarker(destination: string, pages: string[]): Promise<void> {
  await writeMarker(destination, [...pages].sort());
}

async function validateExistingTarget(destination: string): Promise<boolean> {
  try {
    const stats = await lstat(destination);
    if (stats.isSymbolicLink()) throw new Error("export folder cannot be a symbolic link");
    if (!stats.isDirectory()) throw new Error("export folder must be a directory");
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }

  const entries = await readdir(destination);
  if (entries.length === 0) return true;
  if (!entries.includes(MARKER)) {
    throw new Error("export folder is not empty and is not managed by htmlmogged");
  }
  await readMarker(destination);
  return true;
}

async function readMarker(destination: string): Promise<OutputMarker> {
  try {
    const marker = JSON.parse(await readFile(path.join(destination, MARKER), "utf8")) as Partial<OutputMarker>;
    if (
      marker.generator !== "htmlmogged"
      || marker.version !== 1
      || !Array.isArray(marker.pages)
      || marker.pages.some((page) => typeof page !== "string" || path.basename(page) !== page || !page.endsWith(".html"))
    ) throw new Error("invalid marker");
    return marker as OutputMarker;
  } catch {
    throw new Error("export folder has an invalid htmlmogged marker");
  }
}

async function writeMarker(destination: string, pages: string[]): Promise<void> {
  const marker: OutputMarker = { generator: "htmlmogged", version: 1, pages };
  await writeFile(path.join(destination, MARKER), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
