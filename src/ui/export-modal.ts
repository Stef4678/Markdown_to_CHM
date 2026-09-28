import { App, Modal, Notice, TFile, setIcon } from "obsidian";
import type MdToChmPlugin from "../main";
import { FilePickerModal } from "./file-picker";
import type { TocMode } from "../export/project-files";
import { runExport } from "../export/pipeline";
import type { ExportStats } from "../export/pipeline";
import { BuildLog } from "../util/log";
import { formatBytes } from "../util/paths";

type SourceMode = "current" | "folder" | "custom";

interface Preflight {
	notes: number;
	attachments: number;
	bytes: number;
}

interface ElectronShell {
	openPath: (p: string) => Promise<string>;
	showItemInFolder: (p: string) => void;
}

/** Open a file or reveal it in the OS file manager via Electron's shell. */
function shell(): ElectronShell | null {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- Obsidian's API cannot open a file or reveal one in the file manager, so Electron's shell is the only route to either, and Obsidian publishes no typings for it.
		const electron = require("electron") as { shell?: ElectronShell };
		if (electron?.shell) return electron.shell;
	} catch {
		/* not running under Electron */
	}
	return null;
}

export class ExportModal extends Modal {
	private readonly plugin: MdToChmPlugin;

	private sourceMode: SourceMode;
	private files: TFile[];
	private title: string;
	private outputDir: string;
	private tocMode: TocMode;
	private includeAttachments: boolean;
	private generateIndex: boolean;
	private openAfterBuild: boolean;
	private keepStagingDir: boolean;

	private running = false;
	private cancelled = false;

	private sourceListEl!: HTMLElement;
	private sourceSummaryEl!: HTMLElement;
	private folderHintEl!: HTMLElement;
	private validationEl!: HTMLElement;
	private exportBtn!: HTMLButtonElement;
	private progressEl!: HTMLElement;
	private progressBarEl!: HTMLElement;
	private progressTextEl!: HTMLElement;
	private logEl!: HTMLElement;
	private logPreEl!: HTMLElement;
	private resultEl!: HTMLElement;

	constructor(app: App, plugin: MdToChmPlugin, initialFiles: TFile[] = []) {
		super(app);
		this.plugin = plugin;

		const active = app.workspace.getActiveFile();
		this.files = initialFiles.length > 0
			? initialFiles
			: active && active.extension === "md"
			? [active]
			: [];
		this.sourceMode =
			initialFiles.length > 0 ? "custom" : active ? "current" : "custom";

		this.title = plugin.settings.defaultTitle;
		this.outputDir = plugin.settings.defaultOutputDir;
		this.tocMode = plugin.settings.defaultTocMode;
		this.includeAttachments = plugin.settings.includeAttachments;
		this.generateIndex = plugin.settings.generateIndex;
		this.openAfterBuild = plugin.settings.openAfterBuild;
		this.keepStagingDir = plugin.settings.keepStagingDir;
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		modalEl.addClass("mdtoc-modal");
		contentEl.addClass("mdtoc-root");

		this.buildHeader(contentEl);
		const body = contentEl.createDiv({ cls: "mdtoc-body" });

		this.buildSourceSection(body);
		this.buildDetailsSection(body);
		this.buildOptionsSection(body);
		this.buildProgressSection(body);
		this.buildResultSection(body);
		this.buildFooter(contentEl);

		this.refreshSource();
		this.refreshValidation();
	}

	// ------------------------------------------------------------------
	// Sections
	// ------------------------------------------------------------------

	private buildHeader(parent: HTMLElement): void {
		const header = parent.createDiv({ cls: "mdtoc-header" });
		header.createEl("h2", { text: "Export to CHM", cls: "mdtoc-title" });
		header.createEl("p", {
			text: "Compile your notes into a single offline HTML Help file.",
			cls: "mdtoc-subtitle",
		});
	}

	private buildSourceSection(parent: HTMLElement): void {
		const section = parent.createDiv({ cls: "mdtoc-section" });
		section.createDiv({ cls: "mdtoc-section-title", text: "Source" });

		const segmented = section.createDiv({ cls: "mdtoc-segmented" });
		const modes: Array<{ id: SourceMode; label: string }> = [
			{ id: "current", label: "Current file" },
			{ id: "folder", label: "Active folder" },
			{ id: "custom", label: "Choose notes" },
		];

		for (const mode of modes) {
			const button = segmented.createEl("button", {
				text: mode.label,
				cls: "mdtoc-seg-btn",
			});
			button.dataset.mode = mode.id;
			button.addEventListener("click", () => this.setSourceMode(mode.id));
		}

		this.sourceSummaryEl = section.createDiv({ cls: "mdtoc-source-summary" });
		this.sourceListEl = section.createDiv({ cls: "mdtoc-filelist" });
		this.folderHintEl = section.createDiv({ cls: "mdtoc-hint" });
	}

	private buildDetailsSection(parent: HTMLElement): void {
		const section = parent.createDiv({ cls: "mdtoc-section" });
		section.createDiv({ cls: "mdtoc-section-title", text: "Details" });

		// Title
		const titleField = section.createDiv({ cls: "mdtoc-field" });
		titleField.createEl("label", { text: "Title", cls: "mdtoc-label" });
		const titleInput = titleField.createEl("input", {
			cls: "mdtoc-input",
			attr: { type: "text", placeholder: "Documentation" },
		});
		titleInput.value = this.title;
		titleInput.addEventListener("input", () => {
			this.title = titleInput.value;
			this.refreshValidation();
		});

		// Output folder
		const outField = section.createDiv({ cls: "mdtoc-field" });
		outField.createEl("label", {
			text: "Output folder",
			cls: "mdtoc-label",
		});

		const outRow = outField.createDiv({ cls: "mdtoc-inputrow" });
		const outInput = outRow.createEl("input", {
			cls: "mdtoc-input",
			attr: { type: "text", placeholder: "Default: <vault>/chm-export" },
		});
		outInput.value = this.outputDir;
		outInput.addEventListener("input", () => {
			this.outputDir = outInput.value;
			this.refreshValidation();
		});

		const browseBtn = outRow.createEl("button", {
			cls: "mdtoc-browse-btn",
			attr: { type: "button", title: "Pick from folders in this vault" },
		});
		setIcon(browseBtn, "folder-open");

		const folderList = outField.createDiv({
			cls: "mdtoc-folderlist is-hidden",
		});
		browseBtn.addEventListener("click", () => {
			folderList.toggleClass("is-hidden", !folderList.hasClass("is-hidden"));
		});
		this.populateFolderList(folderList, outInput);

		outField.createDiv({
			cls: "mdtoc-hint",
			text: "The finished .chm is written here. The build itself happens in a temporary folder.",
		});
	}

	private populateFolderList(
		listEl: HTMLElement,
		outInput: HTMLInputElement
	): void {
		const base = this.vaultBasePath();
		const options: Array<{ label: string; value: string }> = [];

		if (base) {
			options.push({
				label: "chm-export (default)",
				value: `${base}\\chm-export`,
			});
			options.push({ label: "Vault root", value: base });
		}

		for (const folder of this.app.vault.getAllLoadedFiles()) {
			if (folder instanceof TFile) continue;
			if (folder.path.length === 0) continue;
			if (folder.path.startsWith(".")) continue;
			options.push({
				label: folder.path,
				value: base ? `${base}\\${folder.path.replace(/\//g, "\\")}` : folder.path,
			});
			if (options.length > 120) break;
		}

		for (const option of options) {
			const item = listEl.createDiv({ cls: "mdtoc-folderitem" });
			item.createSpan({ text: option.label, cls: "mdtoc-folderitem-label" });
			item.addEventListener("click", () => {
				this.outputDir = option.value;
				outInput.value = option.value;
				listEl.addClass("is-hidden");
				this.refreshValidation();
			});
		}
	}

	private buildOptionsSection(parent: HTMLElement): void {
		const section = parent.createDiv({ cls: "mdtoc-section" });
		section.createDiv({ cls: "mdtoc-section-title", text: "Options" });

		const tocField = section.createDiv({ cls: "mdtoc-field" });
		tocField.createEl("label", {
			text: "Table of contents",
			cls: "mdtoc-label",
		});
		const select = tocField.createEl("select", { cls: "mdtoc-select" });
		const tocOptions: Array<{ value: TocMode; label: string }> = [
			{ value: "headings", label: "Heading hierarchy" },
			{ value: "folders", label: "Folder structure" },
			{ value: "flat", label: "Single flat list" },
		];
		for (const option of tocOptions) {
			const el = select.createEl("option", { text: option.label });
			el.value = option.value;
		}
		select.value = this.tocMode;
		select.addEventListener("change", () => {
			this.tocMode = select.value as TocMode;
		});

		const toggles: Array<{
			label: string;
			desc: string;
			get: () => boolean;
			set: (v: boolean) => void;
		}> = [
			{
				label: "Include attachments",
				desc: "Copy images and referenced files into the CHM.",
				get: () => this.includeAttachments,
				set: (v) => (this.includeAttachments = v),
			},
			{
				label: "Generate keyword index",
				desc: "Build the index tab from headings, tags and aliases.",
				get: () => this.generateIndex,
				set: (v) => (this.generateIndex = v),
			},
			{
				label: "Open after building",
				desc: "Launch the CHM when the export succeeds.",
				get: () => this.openAfterBuild,
				set: (v) => (this.openAfterBuild = v),
			},
			{
				label: "Keep build files",
				desc: "Leave generated HTML on disk for troubleshooting.",
				get: () => this.keepStagingDir,
				set: (v) => (this.keepStagingDir = v),
			},
		];

		const grid = section.createDiv({ cls: "mdtoc-toggle-grid" });
		for (const toggle of toggles) {
			const row = grid.createEl("label", { cls: "mdtoc-toggle-row" });
			const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
			checkbox.checked = toggle.get();
			checkbox.addEventListener("change", () => toggle.set(checkbox.checked));

			const textWrap = row.createDiv({ cls: "mdtoc-toggle-text" });
			textWrap.createSpan({ text: toggle.label, cls: "mdtoc-toggle-label" });
			textWrap.createSpan({ text: toggle.desc, cls: "mdtoc-toggle-desc" });
		}
	}

	private buildProgressSection(parent: HTMLElement): void {
		this.progressEl = parent.createDiv({
			cls: "mdtoc-section mdtoc-progress is-hidden",
		});
		this.progressEl.createDiv({
			cls: "mdtoc-section-title",
			text: "Build progress",
		});

		const barWrap = this.progressEl.createDiv({ cls: "mdtoc-bar" });
		this.progressBarEl = barWrap.createDiv({ cls: "mdtoc-bar-fill" });
		this.progressTextEl = this.progressEl.createDiv({
			cls: "mdtoc-progress-text",
		});

		const logWrap = this.progressEl.createEl("details", { cls: "mdtoc-logwrap" });
		const summaryEl = logWrap.createEl("summary", { cls: "mdtoc-logsummary" });
		summaryEl.createSpan({ text: "Build log" });
		const copyBtn = summaryEl.createEl("button", {
			text: "Copy",
			cls: "mdtoc-logcopy",
			attr: { type: "button" },
		});
		copyBtn.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void navigator.clipboard.writeText(this.logPreEl.textContent ?? "");
			new Notice("Build log copied to clipboard.");
		});

		this.logEl = logWrap.createDiv({ cls: "mdtoc-log" });
		this.logPreEl = this.logEl.createEl("pre", { cls: "mdtoc-logpre" });
	}

	private buildResultSection(parent: HTMLElement): void {
		this.resultEl = parent.createDiv({
			cls: "mdtoc-section mdtoc-result is-hidden",
		});
	}

	private buildFooter(parent: HTMLElement): void {
		const footer = parent.createDiv({ cls: "mdtoc-footer" });
		this.validationEl = footer.createDiv({ cls: "mdtoc-validation" });

		const actions = footer.createDiv({ cls: "mdtoc-actions" });
		const cancelBtn = actions.createEl("button", {
			text: "Cancel",
			cls: "mdtoc-btn",
		});
		cancelBtn.addEventListener("click", () => {
			if (this.running) {
				this.cancelled = true;
				cancelBtn.setText("Cancelling…");
			} else {
				this.close();
			}
		});

		this.exportBtn = actions.createEl("button", {
			text: "Export",
			cls: "mdtoc-btn mod-cta",
		});
		this.exportBtn.addEventListener("click", () => void this.startExport());
	}

	// ------------------------------------------------------------------
	// Source handling
	// ------------------------------------------------------------------

	private setSourceMode(mode: SourceMode): void {
		this.sourceMode = mode;
		if (mode === "custom") {
			this.openPicker();
			return;
		}
		if (mode === "current") {
			const active = this.app.workspace.getActiveFile();
			this.files = active && active.extension === "md" ? [active] : [];
		}
		if (mode === "folder") {
			const active = this.app.workspace.getActiveFile();
			const folderPath = active?.parent?.path ?? "";
			if (active) {
				this.files = this.app.vault
					.getMarkdownFiles()
					.filter((f) => {
						const parent = f.parent?.path ?? "";
						return (
							parent === folderPath ||
							(folderPath.length > 0 && parent.startsWith(`${folderPath}/`))
						);
					})
					.sort((a, b) => a.path.localeCompare(b.path));
			} else {
				this.files = [];
			}
		}
		this.refreshSource();
	}

	private openPicker(): void {
		new FilePickerModal(
			this.app,
			this.app.vault.getMarkdownFiles(),
			this.files,
			(chosen) => {
				this.files = chosen;
				this.sourceMode = "custom";
				// Rebuild rather than patch, so the segmented control stays honest.
				this.onOpen();
			}
		).open();
	}

	private refreshSource(): void {
		// Segmented control state
		this.contentEl.querySelectorAll(".mdtoc-seg-btn").forEach((el) => {
			const isActive = (el as HTMLElement).dataset.mode === this.sourceMode;
			el.toggleClass("is-active", isActive);
		});

		this.sourceListEl.empty();
		this.sourceSummaryEl.empty();
		this.folderHintEl.empty();

		if (this.files.length === 0) {
			this.sourceListEl.createDiv({
				cls: "mdtoc-empty",
				text:
					this.sourceMode === "folder"
						? "No notes found in the active file's folder."
						: "No notes selected yet.",
			});
			this.refreshValidation();
			return;
		}

		const preflight = this.computePreflight(this.files);

		const summary = this.sourceSummaryEl;
		summary.createSpan({
			text:
				`${preflight.notes} note${preflight.notes === 1 ? "" : "s"}` +
				(preflight.attachments > 0
					? ` · ${preflight.attachments} attachment${
							preflight.attachments === 1 ? "" : "s"
					  }`
					: "") +
				` · ${formatBytes(preflight.bytes)}`,
			cls: "mdtoc-stats",
		});

		if (this.sourceMode === "custom") {
			const clearBtn = summary.createEl("button", {
				text: "Clear",
				cls: "mdtoc-linkbtn",
				attr: { type: "button" },
			});
			clearBtn.addEventListener("click", () => {
				this.files = [];
				this.refreshSource();
			});
		} else if (this.sourceMode === "folder") {
			this.folderHintEl.setText(
				"Includes subfolders of the active note's folder."
			);
		}

		// Cap the visible list so a large folder cannot blow up the dialog.
		const shown = this.files.slice(0, 40);
		for (const file of shown) {
			const row = this.sourceListEl.createDiv({ cls: "mdtoc-filerow" });
			setIcon(row.createSpan({ cls: "mdtoc-filerow-icon" }), "file-text");
			row.createSpan({ text: file.basename, cls: "mdtoc-filerow-name" });

			if (this.sourceMode === "custom") {
				const remove = row.createEl("button", {
					cls: "mdtoc-filerow-remove",
					attr: { type: "button", "aria-label": "Remove" },
				});
				setIcon(remove, "x");
				remove.addEventListener("click", () => {
					this.files = this.files.filter((f) => f.path !== file.path);
					this.refreshSource();
				});
			}
		}

		if (this.files.length > shown.length) {
			this.sourceListEl.createDiv({
				cls: "mdtoc-more",
				text: `…and ${this.files.length - shown.length} more`,
			});
		}

		this.refreshValidation();
	}

	private computePreflight(files: TFile[]): Preflight {
		const attachments = new Set<string>();
		let bytes = 0;

		for (const file of files) {
			bytes += file.stat?.size ?? 0;

			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;

			const candidates = [
				...(cache.embeds ?? []),
				...(cache.links ?? []),
			];

			for (const link of candidates) {
				const target = this.app.metadataCache.getFirstLinkpathDest(
					link.link,
					file.path
				);
				if (target && target.extension !== "md") {
					attachments.add(target.path);
				}
			}
		}

		for (const path of attachments) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) bytes += file.stat?.size ?? 0;
		}

		return { notes: files.length, attachments: attachments.size, bytes };
	}

	// ------------------------------------------------------------------
	// Validation
	// ------------------------------------------------------------------

	private vaultBasePath(): string {
		const adapter = this.app.vault.adapter as { getBasePath?: () => string };
		return typeof adapter.getBasePath === "function"
			? adapter.getBasePath()
			: "";
	}

	private resolveOutputDir(): string {
		if (this.outputDir.trim().length > 0) return this.outputDir.trim();
		const base = this.vaultBasePath();
		return base ? `${base}\\chm-export` : "chm-export";
	}

	private validationReason(): string | null {
		if (this.files.length === 0) return "Select at least one note.";
		if (this.title.trim().length === 0) return "Give the document a title.";
		if (this.plugin.resolvedHhcPath() === null) {
			return "No CHM compiler configured — set it in this plugin's settings.";
		}
		if (!this.vaultBasePath()) {
			return "This vault is not stored on the local filesystem.";
		}
		return null;
	}

	private refreshValidation(): void {
		const reason = this.validationReason();
		this.validationEl.setText(reason ?? "");
		this.validationEl.toggleClass("is-error", reason !== null);
		this.exportBtn.disabled = reason !== null || this.running;
	}

	// ------------------------------------------------------------------
	// Export
	// ------------------------------------------------------------------

	private async startExport(): Promise<void> {
		const reason = this.validationReason();
		if (reason !== null) {
			new Notice(reason);
			return;
		}

		const hhcPath = this.plugin.resolvedHhcPath();
		if (!hhcPath) return;

		this.running = true;
		this.cancelled = false;
		this.refreshValidation();

		this.exportBtn.setText("Exporting…");
		this.exportBtn.disabled = true;
		this.resultEl.addClass("is-hidden");
		this.progressEl.removeClass("is-hidden");
		this.logPreEl.empty();
		this.setProgress("Preparing build", 0, 1);

		const result = await runExport(
			this.app,
			this.plugin,
			{
				files: this.files,
				title: this.title.trim(),
				hhcPath,
				outputDir: this.resolveOutputDir(),
				tocMode: this.tocMode,
				includeAttachments: this.includeAttachments,
				generateIndex: this.generateIndex,
				keepStagingDir: this.keepStagingDir,
				language: this.plugin.settings.language,
			},
			(step, current, total) => this.setProgress(step, current, total),
			() => this.cancelled
		);

		this.running = false;
		this.exportBtn.setText("Export");
		this.refreshValidation();

		this.renderLog(result.log);
		this.showResult(result.success, result.message, result.stats, result.chmPath);
	}

	/** Render the build log with level-based colouring. */
	private renderLog(log: BuildLog): void {
		this.logPreEl.empty();

		if (log.all.length === 0) {
			this.logPreEl.createSpan({ text: "No log output.", cls: "is-info" });
			return;
		}

		for (const entry of log.all) {
			this.logPreEl.createDiv({
				text: entry.message,
				cls: `mdtoc-logline is-${entry.level}`,
			});
		}
	}

	private setProgress(step: string, current: number, total: number): void {
		const pct = total > 0 ? Math.round((current / total) * 100) : 0;
		this.progressBarEl.setCssProps({ width: `${Math.max(3, pct)}%` });
		this.progressTextEl.setText(
			total > 1 ? `${step} — ${current}/${total}` : step
		);
	}

	private showResult(
		success: boolean,
		message: string,
		stats: ExportStats,
		chmPath: string | null
	): void {
		this.progressBarEl.setCssProps({ width: "100%" });
		this.resultEl.empty();
		this.resultEl.removeClass("is-hidden");
		this.resultEl.toggleClass("is-success", success);
		this.resultEl.toggleClass("is-failure", !success);

		const heading = this.resultEl.createDiv({ cls: "mdtoc-result-heading" });
		setIcon(
			heading.createSpan({ cls: "mdtoc-result-icon" }),
			success ? "check-circle" : "alert-circle"
		);
		heading.createSpan({ text: success ? "Export complete" : "Export failed" });

		if (!success) {
			this.resultEl.createDiv({ cls: "mdtoc-result-message", text: message });
			this.logEl.parentElement?.setAttribute("open", "open");
			return;
		}

		const details = this.resultEl.createDiv({ cls: "mdtoc-result-stats" });
		details.createSpan({
			text:
				`${stats.pages} page${stats.pages === 1 ? "" : "s"}` +
				(stats.assets > 0 ? ` · ${stats.assets} attachment(s)` : "") +
				(stats.deadLinks > 0 ? ` · ${stats.deadLinks} link(s) flattened` : "") +
				` · ${formatBytes(stats.chmBytes)}`,
		});

		if (stats.missingAssets > 0) {
			this.resultEl.createDiv({
				cls: "mdtoc-result-warn",
				text: `${stats.missingAssets} attachment(s) could not be included. See the build log.`,
			});
		}

		if (chmPath) {
			this.resultEl.createDiv({ cls: "mdtoc-result-path", text: chmPath });

			const buttons = this.resultEl.createDiv({ cls: "mdtoc-result-actions" });

			const openBtn = buttons.createEl("button", {
				text: "Open CHM",
				cls: "mdtoc-btn mod-cta",
			});
			openBtn.addEventListener("click", () => {
				const sh = shell();
				if (!sh) {
					new Notice("Opening files is only available in the desktop app.");
					return;
				}
				void sh.openPath(chmPath).then((err) => {
					if (err) new Notice(`Could not open the CHM: ${err}`);
				});
			});

			const revealBtn = buttons.createEl("button", {
				text: "Show in folder",
				cls: "mdtoc-btn",
			});
			revealBtn.addEventListener("click", () => {
				const sh = shell();
				if (!sh) {
					new Notice("Revealing files is only available in the desktop app.");
					return;
				}
				sh.showItemInFolder(chmPath);
			});

			if (this.openAfterBuild) {
				const sh = shell();
				if (sh) void sh.openPath(chmPath);
			}
		}
	}

	onClose(): void {
		if (this.running) this.cancelled = true;
		this.contentEl.empty();
	}
}
