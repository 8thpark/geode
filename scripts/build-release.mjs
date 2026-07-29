import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

// Builds the plugin for a release and verifies the release tag matches the manifest. The tag may
// carry an optional -beta.N suffix (that suffix lives only on the git tag, never in the manifest),
// so v0.1.0 and v0.1.0-beta.1 both validate against a manifest version of 0.1.0.
const { values } = parseArgs({ options: { tag: { type: "string" } } });
const tag = values.tag;

if (!tag) {
  console.error("usage: npm run build:release -- --tag <vX.Y.Z[-beta.N]>");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const version = manifest.version;
const wanted = new RegExp(`^v?${version.replace(/\./g, "\\.")}(-beta\\.\\d+)?$`);

if (!wanted.test(tag)) {
  console.error(
    `tag ${tag} does not match manifest.json version ${version} ` +
      `(expected ${version} or ${version}-beta.N)`,
  );
  process.exit(1);
}

execFileSync("npm", ["run", "build"], { stdio: "inherit" });

console.log(`built release ${tag}: manifest.json, main.js, styles.css`);
