import { Plugin, TFile } from "obsidian";

export default class GeodePlugin extends Plugin {
	async onload() {
		console.log("geode: onload");

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				console.log("geode: active-leaf-change");
			}),
		);

		this.registerEvent(
			this.app.workspace.on("file-open", (file: TFile | null) => {
				console.log("geode: file-open", file?.path ?? null);
			}),
		);

		this.app.workspace.onLayoutReady(() => {
			console.log("geode: layout-ready");
		});
	}

	onunload() {
		console.log("geode: onunload");
	}
}
