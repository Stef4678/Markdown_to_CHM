import { Plugin, TFile } from "obsidian";
import {
	MdToChmSettings,
	DEFAULT_SETTINGS,
	MdToChmSettingTab,
} from "./settings";
import {
	detectHhc,
	detectHhcSync,
} from "./export/compiler";
import { fileExists } from "./util/paths";
import { ExportModal } from "./ui/export-modal";

export default class MdToChmPlugin extends Plugin {
	settings: MdToChmSettings;

	/** Result of the asynchronous PATH probe, once it completes. */
	private detectedHhc: string | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addSettingTab(new MdToChmSettingTab(this.app, this));

		this.addRibbonIcon("file-archive", "Export to CHM", () => {
			this.openExportModal();
		});

		this.addCommand({
			id: "export-to-chm",
			name: "Export to CHM…",
			callback: () => this.openExportModal(),
		});

		this.addCommand({
			id: "export-current-note-to-chm",
			name: "Export current note to CHM",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) this.openExportModal([file]);
				return true;
			},
		});

		// Probe PATH in the background; the dialog falls back to a synchronous
		// check of the default install locations until this resolves.
		void detectHhc().then((found) => {
			this.detectedHhc = found;
		});
	}

	/**
	 * The compiler to use: an explicitly configured path wins, then the PATH
	 * probe, then the default install locations.
	 */
	resolvedHhcPath(): string | null {
		const explicit = this.settings.hhcPath.trim();
		if (explicit.length > 0) {
			return fileExists(explicit) ? explicit : null;
		}
		return this.detectedHhc ?? detectHhcSync();
	}

	openExportModal(initialFiles: TFile[] = []): void {
		new ExportModal(this.app, this, initialFiles).open();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
