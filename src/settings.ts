import {
	App,
	PluginSettingTab,
	Setting,
	Notice,
	requireApiVersion,
} from "obsidian";
import type { ButtonComponent, SettingDefinitionItem } from "obsidian";
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

/** Class that scopes the settings stylesheet; see `display()` and `GROUPS`. */
const TAB_CLASS = "mdtoc-settings";

export class MdToChmSettingTab extends PluginSettingTab {
	plugin: MdToChmPlugin;

	/** Result of the last auto-detection, shown in the status row. */
	private detected: string | null = null;
	private detectionDone = false;
	private detectionStarted = false;

	/** The status element rendered by the `display()` fallback, if that ran. */
	private statusEl: HTMLElement | null = null;

	constructor(app: App, plugin: MdToChmPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Declarative settings, used by Obsidian 1.13 and later. These are what
	 * makes the settings appear in the settings search, and the framework
	 * persists each control through `getControlValue`/`setControlValue`, which
	 * `PluginSettingTab` already implements against `this.plugin.settings`.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		this.ensureDetection();

		return [
			{
				type: "group",
				heading: "CHM compiler",
				cls: TAB_CLASS,
				items: [
					{
						name: "Compiler path",
						desc: this.buildCompilerDesc(),
						aliases: ["hhc", "html help workshop", "compiler"],
						control: {
							type: "text",
							key: "hhcPath",
							placeholder: "Auto-detect",
							defaultValue: "",
						},
					},
					{
						name: "Test compiler",
						desc: "Run hhc.exe to confirm it responds.",
						aliases: ["hhc", "verify"],
						render: (setting) => {
							setting.addButton((button) => this.wireTestButton(button));
						},
					},
				],
			},
			{
				type: "group",
				heading: "Defaults",
				cls: TAB_CLASS,
				items: [
					{
						name: "Default title",
						desc: "Used as the CHM title and the output filename.",
						control: {
							type: "text",
							key: "defaultTitle",
							defaultValue: DEFAULT_SETTINGS.defaultTitle,
						},
					},
					{
						name: "Default output folder",
						desc: "Absolute path. Leave empty to use a chm-export folder at the root of the vault.",
						control: {
							type: "text",
							key: "defaultOutputDir",
							placeholder: "<vault>/chm-export",
							defaultValue: "",
						},
					},
					{
						name: "Default table of contents",
						desc: "How the CHM contents pane is built.",
						control: {
							type: "dropdown",
							key: "defaultTocMode",
							options: {
								headings: "Heading hierarchy",
								folders: "Folder structure",
								flat: "Single flat list",
							},
							defaultValue: DEFAULT_SETTINGS.defaultTocMode,
						},
					},
					{
						name: "Language",
						desc: "CHM language identifier passed to the compiler's project file.",
						control: {
							type: "text",
							key: "language",
							defaultValue: DEFAULT_SETTINGS.language,
						},
					},
				],
			},
			{
				type: "group",
				heading: "Behaviour",
				cls: TAB_CLASS,
				items: [
					{
						name: "Include attachments by default",
						desc: "Copy images and other referenced files into the CHM.",
						control: {
							type: "toggle",
							key: "includeAttachments",
							defaultValue: DEFAULT_SETTINGS.includeAttachments,
						},
					},
					{
						name: "Generate keyword index by default",
						desc: "Build the CHM index tab from headings, tags and aliases.",
						control: {
							type: "toggle",
							key: "generateIndex",
							defaultValue: DEFAULT_SETTINGS.generateIndex,
						},
					},
					{
						name: "Open CHM after building",
						desc: "Launch the finished file when the export succeeds.",
						control: {
							type: "toggle",
							key: "openAfterBuild",
							defaultValue: DEFAULT_SETTINGS.openAfterBuild,
						},
					},
					{
						name: "Keep intermediate build files",
						desc: "Leave the generated HTML and project files on disk after compiling. Useful for debugging, but the folder is not cleaned up automatically.",
						control: {
							type: "toggle",
							key: "keepStagingDir",
							defaultValue: DEFAULT_SETTINGS.keepStagingDir,
						},
					},
				],
			},
		];
	}

	/**
	 * Fallback rendering for Obsidian versions before 1.13, which predate the
	 * declarative settings API. On 1.13 and later `getSettingDefinitions()`
	 * renders the tab and this is never called.
	 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass(TAB_CLASS);

		// ---- Compiler ------------------------------------------------------
		new Setting(containerEl).setName("CHM compiler").setHeading();

		this.statusEl = this.buildCompilerStatus();
		containerEl.appendChild(this.statusEl);

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
						this.refreshStatus();
					});
			});

		new Setting(containerEl)
			.setName("Test compiler")
			.setDesc("Run hhc.exe to confirm it responds.")
			.addButton((button) => this.wireTestButton(button));

		if (this.resolvedCompiler() === null && this.detectionDone) {
			containerEl.appendChild(this.buildInstallHelp());
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

		this.ensureDetection();
	}

	/** Wire the "Test compiler" button, shared by both renderings. */
	private wireTestButton(button: ButtonComponent): void {
		button.setButtonText("Test").onClick(async () => {
			button.setDisabled(true);
			button.setButtonText("Testing…");

			const target = this.plugin.settings.hhcPath || this.detected || "";
			const result = await testCompiler(target);

			button.setDisabled(false);
			button.setButtonText("Test");

			new Notice(
				result.ok
					? `Compiler OK — ${result.message}`
					: `Compiler problem — ${result.message}`
			);
		});
	}

	/**
	 * Probe for hhc.exe once. Starts at most one probe; later callers — including
	 * the repeated calls Obsidian makes for search indexing — return at once
	 * rather than queueing another.
	 */
	private ensureDetection(): void {
		if (this.detectionStarted) return;
		this.detectionStarted = true;

		void detectHhc().then((found) => {
			this.detected = found;
			this.detectionDone = true;
			this.refreshAfterDetection();
		});
	}

	/** Send the probe's result to whichever rendering is on screen. */
	private refreshAfterDetection(): void {
		if (this.statusEl) {
			// The fallback painted a live element, so repaint it in place.
			this.refreshStatus();
			return;
		}
		// Nothing was painted imperatively, so the tab came from setting
		// definitions, which update() rebuilds from the new state. update() is
		// 1.13+ API, and getSettingDefinitions() is only ever called there —
		// the guard states that for the static checker.
		if (requireApiVersion("1.13.0")) this.update();
	}

	/** Repaint the status line in place, for the `display()` fallback. */
	private refreshStatus(): void {
		if (!this.statusEl) return;
		const next = this.buildCompilerStatus();
		this.statusEl.replaceWith(next);
		this.statusEl = next;
	}

	/**
	 * The compiler row's description: the auto-detect hint, the live status
	 * line, and — when nothing was found — the installer link. Rebuilt from
	 * current state on every render, which is how the asynchronous probe's
	 * result reaches the screen.
	 */
	private buildCompilerDesc(): DocumentFragment {
		const wrap = document.createDiv();
		wrap.createEl("p", {
			text: "Leave empty to detect hhc.exe automatically. Set it explicitly if HTML Help Workshop is installed somewhere unusual.",
		});
		wrap.appendChild(this.buildCompilerStatus());

		if (this.resolvedCompiler() === null && this.detectionDone) {
			wrap.appendChild(this.buildInstallHelp());
		}

		return createFragment((fragment) => fragment.appendChild(wrap));
	}

	/** The compiler path in force: an explicit setting, else the probe's result. */
	private resolvedCompiler(): string | null {
		return this.plugin.settings.hhcPath || this.detected;
	}

	private buildCompilerStatus(): HTMLElement {
		const statusEl = document.createDiv({ cls: "mdtoc-compiler-status" });

		const explicit = this.plugin.settings.hhcPath;

		if (!explicit && !this.detectionDone) {
			statusEl.createSpan({
				text: "Searching for hhc.exe…",
				cls: "mdtoc-status-neutral",
			});
			return statusEl;
		}

		const resolved = this.resolvedCompiler();

		if (resolved) {
			const dot = statusEl.createSpan({ cls: "mdtoc-status-dot is-ok" });
			dot.setAttribute("aria-hidden", "true");
			statusEl.createSpan({ text: "Found", cls: "mdtoc-status-label" });
			statusEl.createSpan({
				text: shortenForDisplay(resolved, 72),
				cls: "mdtoc-status-path",
			});
			return statusEl;
		}

		const dot = statusEl.createSpan({ cls: "mdtoc-status-dot is-missing" });
		dot.setAttribute("aria-hidden", "true");
		statusEl.createSpan({ text: "Not found", cls: "mdtoc-status-label" });
		statusEl.createSpan({
			text: "hhc.exe could not be located automatically.",
			cls: "mdtoc-status-path",
		});
		return statusEl;
	}

	/** Shown only when no compiler was found; the plugin cannot ship one. */
	private buildInstallHelp(): HTMLElement {
		const help = document.createDiv({ cls: "mdtoc-help" });
		help.createEl("p", {
			text: "HTML Help Workshop is required and was not found on this system. Microsoft no longer distributes it, so the link below opens the Internet Archive's copy of Microsoft's own installer; the README lists the checksum to check it against.",
		});
		const link = help.createEl("a", { text: "Download the installer" });
		link.href = HHW_DOWNLOAD_URL;
		help.createEl("p", {
			text: "After installing, point the compiler path setting at the hhc.exe inside the install folder (typically C:\\Program Files (x86)\\HTML Help Workshop\\hhc.exe).",
			cls: "mdtoc-help-note",
		});
		return help;
	}
}
