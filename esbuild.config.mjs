import esbuild from "esbuild";
import process from "node:process";

const production = process.argv[2] === "production";

const context = await esbuild.context({
	entryPoints: ["main.ts"],
	bundle: true,
	external: ["obsidian", "electron"],
	format: "cjs",
	target: "es2020",
	platform: "node",
	sourcemap: production ? false : "inline",
	minify: production,
	outfile: "main.js",
});

if (production) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
