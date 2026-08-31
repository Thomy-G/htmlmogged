import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MARKER = ".htmlmogged.json";

interface OutputMarker {
  generator: "htmlmogged";
  version: 1;
  pages: string[];
}

export async function prepareOutputDirectory(destination: string): Promise<string> {
  if (!path.isAbsolute(destination)) throw new Error("export folder must be an absolute path");
  await mkdir(destination, { recursive: true });
  const resolved = await realpath(destination);
  if (resolved === path.parse(resolved).root) throw new Error("refusing to export into the filesystem root");

  const entries = await readdir(resolved);
  if (entries.length === 0) {
    await writeMarker(resolved, []);
    return resolved;
  }
  if (!entries.includes(MARKER)) {
    throw new Error("export folder is not empty and is not managed by htmlmogged");
  }

  await readMarker(resolved);
  return resolved;
}

export async function writeOutputMarker(destination: string, pages: string[]): Promise<void> {
  const previous = await readMarker(destination);
  const current = new Set(pages);
  await Promise.all(previous.pages.filter((page) => !current.has(page)).map((page) => rm(path.join(destination, page), { force: true })));
  await writeMarker(destination, [...pages].sort());
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
