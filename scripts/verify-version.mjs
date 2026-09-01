import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readJson = async (file) => JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
const [manifest, packageJson, versions] = await Promise.all([
  readJson("manifest.json"),
  readJson("package.json"),
  readJson("versions.json"),
]);
const tag = process.argv[2]?.replace(/^v/u, "");

assert.equal(packageJson.version, manifest.version, "package.json and manifest.json versions differ");
assert.equal(versions[manifest.version], manifest.minAppVersion, "versions.json does not match manifest.json");
if (tag) assert.equal(tag, manifest.version, `release tag must be ${manifest.version} or v${manifest.version}`);
