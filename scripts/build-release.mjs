import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { parseArgs } from "node:util";

// Builds the plugin for a release and verifies the release tag matches the manifest. Tags are never
// prefixed with `v` (Obsidian matches the manifest version exactly). The tag may carry an optional
// -beta.N suffix, which lives only on the git tag and never in the manifest, so 0.1.0 and
// 0.1.0-beta.1 both validate against a manifest version of 0.1.0. Artifacts land in dist/<tag>/.
const { values } = parseArgs({ options: { tag: { type: "string" } } });
const tag = values.tag;

if (!tag) {
  console.error("usage: npm run build:release -- --tag <X.Y.Z[-beta.N]>");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const version = manifest.version;
const wanted = new RegExp(`^${version.replace(/\./g, "\\.")}(-beta\\.\\d+)?$`);

if (!wanted.test(tag)) {
  console.error(
    `tag ${tag} does not match manifest.json version ${version} ` +
      `(expected ${version} or ${version}-beta.N, no "v" prefix)`,
  );
  process.exit(1);
}

rmSync("dist", { recursive: true, force: true });
execFileSync("npm", ["run", "build"], { stdio: "inherit" });

const outDir = `dist/${tag}`;
mkdirSync(outDir, { recursive: true });
for (const file of ["manifest.json", "main.js", "styles.css"]) {
  copyFileSync(file, `${outDir}/${file}`);
}

// Scan the exact files being shipped for leaked secrets. The glob is passed literally so secretlint
// (not the shell) expands it. --no-gitignore is required because dist/ is gitignored, and secretlint
// silently skips gitignored paths otherwise. A non-zero exit throws here, aborting before any upload.
try {
  execFileSync("npx", ["--no-install", "secretlint", "--no-gitignore", `${outDir}/**/*`], {
    stdio: "inherit",
  });
} catch {
  console.error(`secretlint found a potential secret in ${outDir}; release aborted`);
  process.exit(1);
}

console.log(`built release ${tag} -> ${outDir}/{manifest.json,main.js,styles.css}`);
