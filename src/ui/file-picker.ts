import { App, Modal, TFile, setIcon } from "obsidian";

/**
 * Searchable multi-select picker for choosing which notes to export.
 */
export class FilePickerModal extends Modal {
	private readonly allFiles: TFile[];
	private readonly selected: Set<string>;
	private readonly onChoose: (files: TFile[]) => void;

	private listEl!: HTMLElement;
	private countEl!: HTMLElement;
	private query = "";

	constructor(
		app: App,
		allFiles: TFile[],
		initiallySelected: TFile[],
		onChoose: (files: TFile[]) => void
	) {
		super(app);
		this.allFiles = allFiles;
		this.selected = new Set(initiallySelected.map((f) => f.path));
		this.onChoose = onChoose;
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		modalEl.addClass("mdtoc-picker-modal");
		contentEl.addClass("mdtoc-picker");

		const searchWrap = contentEl.createDiv({ cls: "mdtoc-picker-searchwrap" });
		setIcon(searchWrap.createSpan({ cls: "mdtoc-picker-searchicon" }), "search");
		const searchInput = searchWrap.createEl("input", {
			cls: "mdtoc-picker-search",
			attr: { type: "text", placeholder: "Search notes…" },
		});
		searchInput.addEventListener("input", () => {
			this.query = searchInput.value.toLowerCase();
			this.renderList();
		});

		this.listEl = contentEl.createDiv({ cls: "mdtoc-picker-list" });

		const footer = contentEl.createDiv({ cls: "mdtoc-picker-footer" });
		this.countEl = footer.createSpan({ cls: "mdtoc-picker-count" });

		const actions = footer.createDiv({ cls: "mdtoc-picker-actions" });
		const cancelBtn = actions.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const addBtn = actions.createEl("button", {
			text: "Add to export",
			cls: "mod-cta",
		});
		addBtn.addEventListener("click", () => {
			this.onChoose(
				this.allFiles.filter((f) => this.selected.has(f.path))
			);
			this.close();
		});

		searchInput.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				addBtn.click();
			}
		});

		this.renderList();
		window.setTimeout(() => searchInput.focus(), 0);
	}

	private matches(file: TFile): boolean {
		if (this.query.length === 0) return true;
		return file.path.toLowerCase().includes(this.query);
	}

	private renderList(): void {
		this.listEl.empty();

		const visible = this.allFiles.filter((f) => this.matches(f));

		if (visible.length === 0) {
			this.listEl.createDiv({
				cls: "mdtoc-picker-empty",
				text: this.query
					? "No notes match that search."
					: "No markdown notes found in this vault.",
			});
			this.updateCount();
			return;
		}

		// Group by folder so long vaults stay navigable.
		const byFolder = new Map<string, TFile[]>();
		for (const file of visible) {
			const folder = file.parent?.path ?? "";
			const bucket = byFolder.get(folder) ?? [];
			bucket.push(file);
			byFolder.set(folder, bucket);
		}

		const folders = Array.from(byFolder.keys()).sort((a, b) =>
			a.localeCompare(b)
		);

		for (const folder of folders) {
			const files = byFolder.get(folder)!;
			files.sort((a, b) => a.basename.localeCompare(b.basename));

			if (folder.length > 0) {
				const header = this.listEl.createDiv({ cls: "mdtoc-picker-folder" });
				header.createSpan({ text: folder, cls: "mdtoc-picker-foldername" });
				const toggleAll = header.createEl("button", {
					cls: "mdtoc-picker-folderbtn",
					text: this.allSelected(files) ? "Clear" : "Select all",
				});
				toggleAll.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					const shouldSelect = !this.allSelected(files);
					for (const file of files) {
						if (shouldSelect) this.selected.add(file.path);
						else this.selected.delete(file.path);
					}
					this.renderList();
				});
			}

			for (const file of files) {
				this.renderRow(file);
			}
		}

		this.updateCount();
	}

	private allSelected(files: TFile[]): boolean {
		return files.every((f) => this.selected.has(f.path));
	}

	private renderRow(file: TFile): void {
		const row = this.listEl.createEl("label", { cls: "mdtoc-picker-row" });

		const checkbox = row.createEl("input", {
			cls: "mdtoc-picker-check",
			attr: { type: "checkbox" },
		});
		checkbox.checked = this.selected.has(file.path);

		const textWrap = row.createDiv({ cls: "mdtoc-picker-rowtext" });
		textWrap.createSpan({ text: file.basename, cls: "mdtoc-picker-basename" });
		if (file.parent && file.parent.path.length > 0) {
			textWrap.createSpan({
				text: file.parent.path,
				cls: "mdtoc-picker-rowpath",
			});
		}

		checkbox.addEventListener("change", () => {
			if (checkbox.checked) this.selected.add(file.path);
			else this.selected.delete(file.path);
			this.updateCount();
		});

		row.addEventListener("click", (event) => {
			// Let the native checkbox handle its own toggle.
			if (event.target === checkbox) return;
			event.preventDefault();
			checkbox.checked = !checkbox.checked;
			if (checkbox.checked) this.selected.add(file.path);
			else this.selected.delete(file.path);
			this.updateCount();
		});
	}

	private updateCount(): void {
		const n = this.selected.size;
		this.countEl.setText(n === 1 ? "1 note selected" : `${n} notes selected`);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
