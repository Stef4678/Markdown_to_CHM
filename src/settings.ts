import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type MdToChmPlugin from "./main";
import { detectHhc, testCompiler, shortenForDisplay } from "./export/compiler";
import type { TocMode } from "./export/project-files";

export interface MdToChmSettings {
	/** Explicit path to hhc.exe. Empty means auto-detect. */
	hhcPath: string;
	/** Empty means "<vault>/chm-export". */
	defaultOutputDir: string;
	defaultTitle: string;
	defaultTocMode: TocMode;
	includeAttachments: boolean;
	generateIndex: boolean;
	openAfterBuild: boolean;
	keepStagingDir: boolean;
	language: string;
}

export const DEFAULT_SETTINGS: MdToChmSettings = {
	hhcPath: "",
	defaultOutputDir: "",
	defaultTitle: "Documentation",
	defaultTocMode: "headings",
	includeAttachments: true,
	generateIndex: true,
	openAfterBuild: true,
	keepStagingDir: false,
	language: "0x409 English (United States)",
};

// Microsoft retired the download page and pulled the installer from its servers
// — the old link has 404'd since 2021, with no replacement published. This is the
// Internet Archive's copy of Microsoft's own installer, which the plugin cannot
// ship itself because the licence forbids redistribution. The README lists the
// checksum to verify it against.
const HHW_DOWNLOAD_URL =
	"https://web.archive.org/web/20200918004813id_/https://download.microsoft.com/download/0/A/9/0A939EF6-E31C-430F-A3DF-DFAE7960D564/htmlhelp.exe";

export class MdToChmSettingTab extends PluginSettingTab {
	plugin: MdToChmPlugin;

	/** Result of the last auto-detection, shown in the status row. */
	private detected: string | null = null;
	private detectionDone = false;

	constructor(app: App, plugin: MdToChmPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("mdtoc-settings");

		// ---- Compiler ------------------------------------------------------
		new Setting(containerEl).setName("CHM compiler").setHeading();

		const statusEl = containerEl.createDiv({ cls: "mdtoc-compiler-status" });
		this.renderCompilerStatus(statusEl);

		if (!this.detectionDone) {
			detectHhc().then((found) => {
				this.detected = found;
				this.detectionDone = true;
				this.renderCompilerStatus(statusEl);
			});
		}

		new Setting(containerEl)
			.setName("Compiler path")
			.setDesc(
				"Leave empty to detect hhc.exe automatically. Set it explicitly if HTML Help Workshop is installed somewhere unusual."
			)
			.addText((text) => {
				text.setPlaceholder("Auto-detect")
					.setValue(this.plugin.settings.hhcPath)
					.onChange(async (value) => {
						this.plugin.settings.hhcPath = value.trim();
						await this.plugin.saveSettings();
						this.renderCompilerStatus(statusEl);
					});
				text.inputEl.addClass("mdtoc-wide-input");
			});

		new Setting(containerEl)
			.setName("Test compiler")
			.setDesc("Run hhc.exe to confirm it responds.")
			.addButton((button) => {
				button.setButtonText("Test").onClick(async () => {
					button.setDisabled(true);
					button.setButtonText("Testing…");

					const target =
						this.plugin.settings.hhcPath || this.detected || "";
					const result = await testCompiler(target);

					button.setDisabled(false);
					button.setButtonText("Test");

					new Notice(
						result.ok
							? `Compiler OK — ${result.message}`
							: `Compiler problem — ${result.message}`
					);
				});
			});

		if (this.detected === null && this.detectionDone) {
			const help = containerEl.createDiv({ cls: "mdtoc-help" });
			help.createEl("p", {
				text: "HTML Help Workshop is required and was not found on this system. Microsoft no longer distributes it, so the link below opens the Internet Archive's copy of Microsoft's own installer; the README lists the checksum to check it against.",
			});
			const link = help.createEl("a", { text: "Download the installer" });
			link.href = HHW_DOWNLOAD_URL;
			help.createEl("p", {
				text: "After installing, set the path above to the hhc.exe inside the install folder (typically C:\\Program Files (x86)\\HTML Help Workshop\\hhc.exe).",
				cls: "mdtoc-help-note",
			});
		}

		// ---- Defaults ------------------------------------------------------
		new Setting(containerEl).setName("Defaults").setHeading();

		new Setting(containerEl)
			.setName("Default title")
			.setDesc("Used as the CHM title and the output filename.")
			.addText((text) => {
				text.setValue(this.plugin.settings.defaultTitle).onChange(
					async (value) => {
						this.plugin.settings.defaultTitle = value;
						await this.plugin.saveSettings();
					}
				);
				text.inputEl.addClass("mdtoc-wide-input");
			});

		new Setting(containerEl)
			.setName("Default output folder")
			.setDesc(
				"Absolute path. Leave empty to use a chm-export folder at the root of the vault."
			)
			.addText((text) => {
				text.setPlaceholder("<vault>/chm-export")
					.setValue(this.plugin.settings.defaultOutputDir)
					.onChange(async (value) => {
						this.plugin.settings.defaultOutputDir = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.addClass("mdtoc-wide-input");
			});

		new Setting(containerEl)
			.setName("Default table of contents")
			.setDesc("How the CHM contents pane is built.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("headings", "Heading hierarchy")
					.addOption("folders", "Folder structure")
					.addOption("flat", "Single flat list")
					.setValue(this.plugin.settings.defaultTocMode)
					.onChange(async (value) => {
						this.plugin.settings.defaultTocMode = value as TocMode;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Language")
			.setDesc("CHM language identifier passed to the compiler's project file.")
			.addText((text) => {
				text.setValue(this.plugin.settings.language).onChange(
					async (value) => {
						this.plugin.settings.language =
							value.trim() || DEFAULT_SETTINGS.language;
						await this.plugin.saveSettings();
					}
				);
				text.inputEl.addClass("mdtoc-wide-input");
			});

		// ---- Behaviour -----------------------------------------------------
		new Setting(containerEl).setName("Behaviour").setHeading();

		new Setting(containerEl)
			.setName("Include attachments by default")
			.setDesc("Copy images and other referenced files into the CHM.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeAttachments)
					.onChange(async (value) => {
						this.plugin.settings.includeAttachments = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Generate keyword index by default")
			.setDesc("Build the CHM index tab from headings, tags and aliases.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.generateIndex)
					.onChange(async (value) => {
						this.plugin.settings.generateIndex = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Open CHM after building")
			.setDesc("Launch the finished file when the export succeeds.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.openAfterBuild)
					.onChange(async (value) => {
						this.plugin.settings.openAfterBuild = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Keep intermediate build files")
			.setDesc(
				"Leave the generated HTML and project files on disk after compiling. Useful for debugging, but the folder is not cleaned up automatically."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.keepStagingDir)
					.onChange(async (value) => {
						this.plugin.settings.keepStagingDir = value;
						await this.plugin.saveSettings();
					})
			);
	}

	private renderCompilerStatus(statusEl: HTMLElement): void {
		statusEl.empty();

		const explicit = this.plugin.settings.hhcPath;
		const resolved = explicit || this.detected;

		if (!explicit && !this.detectionDone) {
			statusEl.createSpan({
				text: "Searching for hhc.exe…",
				cls: "mdtoc-status-neutral",
			});
			return;
		}

		if (resolved) {
			const dot = statusEl.createSpan({ cls: "mdtoc-status-dot is-ok" });
			dot.setAttribute("aria-hidden", "true");
			statusEl.createSpan({ text: "Found", cls: "mdtoc-status-label" });
			statusEl.createSpan({
				text: shortenForDisplay(resolved, 72),
				cls: "mdtoc-status-path",
			});
			return;
		}

		const dot = statusEl.createSpan({ cls: "mdtoc-status-dot is-missing" });
		dot.setAttribute("aria-hidden", "true");
		statusEl.createSpan({ text: "Not found", cls: "mdtoc-status-label" });
		statusEl.createSpan({
			text: "hhc.exe could not be located automatically.",
			cls: "mdtoc-status-path",
		});
	}
}
