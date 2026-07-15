import { lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();
const pluginsDir = resolve(repoRoot, "dev-vault", ".obsidian", "plugins");
const pluginLink = resolve(pluginsDir, "geode");

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

mkdirSync(pluginsDir, { recursive: true });

if (pathExists(pluginLink)) {
  rmSync(pluginLink, { recursive: true, force: true });
}

// A real symlink needs admin rights or Developer Mode enabled on Windows; a junction needs
// neither and behaves the same for a directory link, so use one there instead.
const linkType = process.platform === "win32" ? "junction" : "dir";
symlinkSync(repoRoot, pluginLink, linkType);

console.log(`dev vault ready: ${pluginLink} -> ${repoRoot}`);
