import process from "node:process";
import esbuild from "esbuild";

const production = process.argv[2] === "production";

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: ["obsidian", "electron"],
	format: "cjs",
	target: "es2020",
	platform: "node",
	sourcemap: production ? false : "inline",
	minify: production,
	outfile: "main.js",
	logLevel: "info",
});

if (production) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
	console.log("watching for changes...");
}
