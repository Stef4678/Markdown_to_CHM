import { App, Component, TFile, FileSystemAdapter } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import { BuildLog } from "../util/log";
import {
	createStagingDir,
	removeDirRecursive,
	sanitizeName,
	writeFileDeep,
	fileSize,
} from "../util/paths";
import { renderNote, wrapDocument } from "./renderer";
import type { RenderContext } from "./renderer";
import { copyAssets, rewriteAssetPlaceholders } from "./assets";
import { generateHhc, generateHhk, generateHhp } from "./project-files";
import type { IndexKeywords, PageEntry, TocMode } from "./project-files";
import { encodeAnsi, unsupportedCount } from "./ansi";
import { compileProject } from "./compiler";
import { CHM_CSS } from "./chm-css";

export interface ExportOptions {
	files: TFile[];
	title: string;
	/** Absolute path to hhc.exe. */
	hhcPath: string;
	/** Absolute destination folder for the finished .chm. */
	outputDir: string;
	tocMode: TocMode;
	includeAttachments: boolean;
	generateIndex: boolean;
	keepStagingDir: boolean;
	language: string;
}

/** A page plus the HTML held back until attachments have been resolved. */
interface PendingPage extends PageEntry {
	html: string;
}

export interface ExportStats {
	pages: number;
	assets: number;
	assetBytes: number;
	deadLinks: number;
	missingAssets: number;
	chmBytes: number;
}

export interface ExportResult {
	success: boolean;
	chmPath: string | null;
	message: string;
	stats: ExportStats;
	/** Everything the build reported, including raw hhc.exe output. */
	log: BuildLog;
}

export type ProgressReporter = (
	step: string,
	current: number,
	total: number
) => void;

const YIELD_EVERY = 4;

/** Let the UI repaint between chunks of work. */
function yieldToUi(): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function vaultBasePath(app: App): string {
	const adapter = app.vault.adapter;
	if (adapter instanceof FileSystemAdapter) {
		return adapter.getBasePath();
	}
	return "";
}

/** frontmatter title, else the first h1, else the file's basename. */
function resolveTitle(
	app: App,
	file: TFile,
	headings: Array<{ level: number; text: string }>
): string {
	const cache = app.metadataCache.getFileCache(file);
	// FrontMatterCache is an `any` index signature, so the read is taken as
	// `unknown` and narrowed below rather than trusted.
	const fmTitle: unknown = cache?.frontmatter?.title;
	if (typeof fmTitle === "string" && fmTitle.trim().length > 0) {
		return fmTitle.trim();
	}

	const h1 = headings.find((h) => h.level === 1);
	if (h1 && h1.text.trim().length > 0) return h1.text.trim();

	return file.basename;
}

/**
 * Collect index keywords for a note.
 *
 * Tags are the primary source: inline `#tag` occurrences come from `cache.tags`,
 * and frontmatter `tags:` is read directly because `cache.tags` does not
 * reliably include it. Aliases are a secondary source so notes stay findable by
 * their alternate names.
 */
function collectKeywords(
	app: App,
	file: TFile,
	outputName: string,
	into: IndexKeywords
): void {
	const cache = app.metadataCache.getFileCache(file);
	if (!cache) return;

	const add = (target: Map<string, string[]>, keyword: unknown) => {
		if (typeof keyword !== "string") return;
		// Obsidian hands back tags with a leading '#', and nested tags keep
		// their full 'parent/child' form.
		const trimmed = keyword.trim().replace(/^#+/, "");
		if (trimmed.length === 0) return;
		const existing = target.get(trimmed) ?? [];
		if (!existing.includes(outputName)) existing.push(outputName);
		target.set(trimmed, existing);
	};

	for (const tag of cache.tags ?? []) {
		add(into.tags, tag.tag);
	}

	const frontmatter = cache.frontmatter;
	if (frontmatter) {
		// Both spellings appear in the wild, and either may be a single string
		// rather than a list.
		const fmTags: unknown = frontmatter.tags ?? frontmatter.tag;
		if (Array.isArray(fmTags)) fmTags.forEach((t) => add(into.tags, t));
		else add(into.tags, fmTags);

		const aliases: unknown = frontmatter.aliases ?? frontmatter.alias;
		if (Array.isArray(aliases)) aliases.forEach((a) => add(into.aliases, a));
		else add(into.aliases, aliases);
	}
}

export async function runExport(
	app: App,
	component: Component,
	opts: ExportOptions,
	onProgress: ProgressReporter,
	isCancelled: () => boolean
): Promise<ExportResult> {
	const log = new BuildLog();
	const stats: ExportStats = {
		pages: 0,
		assets: 0,
		assetBytes: 0,
		deadLinks: 0,
		missingAssets: 0,
		chmBytes: 0,
	};

	if (opts.files.length === 0) {
		return {
			success: false,
			chmPath: null,
			message: "No notes selected.",
			stats,
			log,
		};
	}

	// Stable ordering keeps output filenames reproducible across runs.
	const files = [...opts.files].sort((a, b) => a.path.localeCompare(b.path));

	// ---- 1. Staging -------------------------------------------------------
	onProgress("Preparing build", 0, files.length);
	let staging: { realPath: string; compilerPath: string };
	try {
		staging = await createStagingDir();
	} catch (err) {
		return {
			success: false,
			chmPath: null,
			message: err instanceof Error ? err.message : String(err),
			stats,
			log,
		};
	}

	log.info(`Staging directory: ${staging.realPath}`);

	const chmBaseName = sanitizeName(opts.title, "documentation");
	const chmFileName = `${chmBaseName}.chm`;
	const hhcFileName = "contents.hhc";
	const hhkFileName = "keywords.hhk";
	const projectFileName = "project.hhp";

	let compiledChm: string | null = null;
	let finalMessage = "";

	try {
		// ---- 2. Render ------------------------------------------------------
		const fileMap = new Map<string, string>();
		files.forEach((file, index) => {
			fileMap.set(
				file.path,
				`page_${String(index + 1).padStart(4, "0")}.html`
			);
		});

		const ctx: RenderContext = {
			app,
			component,
			fileMap,
			vaultBasePath: vaultBasePath(app),
		};

		const pages: PendingPage[] = [];
		const allAssetRefs = new Set<string>();
		const extraKeywords: IndexKeywords = { tags: new Map(), aliases: new Map() };

		for (let i = 0; i < files.length; i++) {
			if (isCancelled()) throw new Error("__CANCELLED__");

			const file = files[i];
			onProgress(`Rendering ${file.basename}`, i, files.length);

			const markdown = await app.vault.cachedRead(file);
			const rendered = await renderNote(ctx, file, markdown);

			const outputName = fileMap.get(file.path)!;
			const title = resolveTitle(app, file, rendered.headings);

			rendered.assetRefs.forEach((ref) => allAssetRefs.add(ref));
			stats.deadLinks += rendered.deadLinks.length;

			if (rendered.deadLinks.length > 0) {
				log.warn(
					`${file.path}: ${rendered.deadLinks.length} link(s) pointed outside the export and were flattened.`
				);
			}

			if (rendered.unresolvedMedia.length > 0) {
				log.warn(
					`${file.path}: ${rendered.unresolvedMedia.length} image or media source(s) could not be found in the vault and were left out: ` +
						rendered.unresolvedMedia.slice(0, 5).join(", ")
				);
			}

			pages.push({
				outputName,
				title,
				vaultPath: file.path,
				headings: rendered.headings,
				// Held until assets are resolved so placeholders replace once.
				html: rendered.bodyHtml,
			});

			if (opts.generateIndex) {
				collectKeywords(app, file, outputName, extraKeywords);
			}

			if (i % YIELD_EVERY === 0) await yieldToUi();
		}

		stats.pages = pages.length;

		// ---- 3. Attachments -------------------------------------------------
		const assetPaths = new Map<string, string>();
		if (opts.includeAttachments && allAssetRefs.size > 0) {
			if (isCancelled()) throw new Error("__CANCELLED__");

			onProgress("Copying attachments", 0, allAssetRefs.size);
			const copied = await copyAssets(
				app,
				Array.from(allAssetRefs),
				staging.realPath,
				log
			);
			copied.paths.forEach((v, k) => assetPaths.set(k, v));
			stats.assets = copied.paths.size;
			stats.assetBytes = copied.bytes;
			stats.missingAssets = copied.missing.length;

			// Every reference failing is the shape of a whole export's images
			// going missing, so it is called out rather than left among the
			// per-file warnings.
			if (copied.paths.size === 0) {
				log.error(
					`None of the ${allAssetRefs.size} referenced attachment(s) could be read from the vault, so the CHM will have no images.`
				);
			}
		} else if (!opts.includeAttachments && allAssetRefs.size > 0) {
			log.error(
				`${allAssetRefs.size} attachment(s) were referenced but "Include attachments" is off, so the CHM will have no images. Turn it on and export again.`
			);
			stats.missingAssets = allAssetRefs.size;
		}

		// ---- 4. Write pages -------------------------------------------------
		const writtenFiles: string[] = [];

		for (let i = 0; i < pages.length; i++) {
			if (isCancelled()) throw new Error("__CANCELLED__");

			const page = pages[i];
			onProgress(`Writing ${page.title}`, i, pages.length);

			const html = rewriteAssetPlaceholders(page.html, assetPaths);
			const document = wrapDocument(page.title, html, CHM_CSS);

			await writeFileDeep(
				path.join(staging.realPath, page.outputName),
				document
			);
			writtenFiles.push(page.outputName);

			if (i % YIELD_EVERY === 0) await yieldToUi();
		}

		// No point embedding files we never managed to copy.
		const embeddableAssets = Array.from(assetPaths.values()).filter((rel) =>
			fs.existsSync(path.join(staging.realPath, ...rel.split("/")))
		);
		writtenFiles.push(...embeddableAssets);

		// ---- 5. Project files -----------------------------------------------
		onProgress("Writing project files", pages.length, pages.length);

		const defaultTopic = pages[0].outputName;

		// The navigation pane is a Windows-1252 surface, so headings that use
		// characters outside that codepage (arrows, emoji, CJK) are folded or
		// dropped on the way in. Say so rather than letting the user wonder why a
		// heading reads differently in the TOC than in the page.
		const simplified = pages.reduce(
			(sum, page) =>
				sum +
				unsupportedCount(page.title) +
				page.headings.reduce((n, h) => n + unsupportedCount(h.text), 0),
			unsupportedCount(opts.title)
		);
		if (simplified > 0) {
			log.warn(
				`${simplified} character(s) in headings or the title cannot be shown in the ` +
					`CHM's table of contents or index and were simplified (arrows become "->", ` +
					`emoji are dropped). The note pages themselves are unaffected.`
			);
		}

		// These three files are read as Windows-1252, not UTF-8.
		await writeFileDeep(
			path.join(staging.realPath, hhcFileName),
			encodeAnsi(generateHhc(pages, opts.tocMode))
		);

		if (opts.generateIndex) {
			await writeFileDeep(
				path.join(staging.realPath, hhkFileName),
				encodeAnsi(generateHhk(pages, extraKeywords))
			);
		}

		await writeFileDeep(
			path.join(staging.realPath, projectFileName),
			encodeAnsi(
				generateHhp({
					title: opts.title,
					chmFileName,
					hhcFileName,
					hhkFileName: opts.generateIndex ? hhkFileName : null,
					defaultTopic,
					language: opts.language,
					files: writtenFiles,
				})
			)
		);

		// ---- 6. Compile -----------------------------------------------------
		if (isCancelled()) throw new Error("__CANCELLED__");
		onProgress("Compiling CHM", 0, 1);

		const outcome = await compileProject(
			{
				hhcPath: opts.hhcPath,
				stagingRealPath: staging.realPath,
				stagingCompilerPath: staging.compilerPath,
				projectFileName,
				chmFileName,
			},
			log
		);

		if (!outcome.success) {
			finalMessage = outcome.message;
			return {
				success: false,
				chmPath: null,
				message: outcome.message,
				stats,
				log,
			};
		}

		// ---- 7. Deliver -----------------------------------------------------
		onProgress("Finishing up", 0, 1);

		await fs.promises.mkdir(opts.outputDir, { recursive: true });
		const destination = path.join(opts.outputDir, chmFileName);
		try {
			await fs.promises.copyFile(outcome.chmPath, destination);
		} catch (err) {
			// Windows reports a file that is open elsewhere as EBUSY, and the CHM
			// viewer is exactly that: it holds the file it is displaying open. The
			// raw error names the temp directory and says nothing about what to do.
			const code = (err as { code?: string })?.code;
			if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
				const message =
					`${chmFileName} could not be replaced because it is open in another program. ` +
					`Close the CHM viewer, then export again.`;
				log.error(message);
				return { success: false, chmPath: null, message, stats, log };
			}
			throw err;
		}

		compiledChm = destination;
		stats.chmBytes = fileSize(destination);

		log.success(`Created ${destination}`);
		finalMessage = "Export complete.";
	} catch (err) {
		if (err instanceof Error && err.message === "__CANCELLED__") {
			return {
				success: false,
				chmPath: null,
				message: "Export cancelled.",
				stats,
				log,
			};
		}
		const message = err instanceof Error ? err.message : String(err);
		log.error(message);
		return { success: false, chmPath: null, message, stats, log };
	} finally {
		if (!opts.keepStagingDir) {
			await removeDirRecursive(staging.realPath);
		} else {
			log.info(`Build files kept at ${staging.realPath}`);
		}
	}

	return {
		success: compiledChm !== null,
		chmPath: compiledChm,
		message: finalMessage,
		stats,
		log,
	};
}
