import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));

if (pkg.version !== manifest.version) {
	console.error(
		`version mismatch: package.json is ${pkg.version}, manifest.json is ${manifest.version}`,
	);
	process.exit(1);
}

console.log(`versions match: ${pkg.version}`);
