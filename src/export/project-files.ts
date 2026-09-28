import type { HeadingInfo } from "./renderer";
import { navSafe } from "./ansi";

/**
 * Generates the three files hhc.exe consumes: the project (.hhp), the table of
 * contents (.hhc) and the keyword index (.hhk).
 *
 * Every string that reaches one of these files goes through `navSafe` first.
 * These files are read as Windows-1252 (see ansi.ts) and the navigation pane is
 * rendered in that codepage, so a heading containing anything outside it — an
 * arrow, an emoji, CJK — would otherwise arrive as mojibake.
 */

export type TocMode = "headings" | "folders" | "flat";

export interface PageEntry {
	/** Staging-relative output filename, e.g. `page_001.html`. */
	outputName: string;
	/** Human-readable title used in the TOC. */
	title: string;
	/** Original vault path, used for folder-mode grouping. */
	vaultPath: string;
	headings: HeadingInfo[];
}

/**
 * Prepare text for use inside an HTML attribute or element body: fold anything
 * the navigation pane cannot display, then escape the markup characters.
 */
function esc(value: string): string {
	return navSafe(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

interface TocNode {
	name: string;
	local?: string;
	children: TocNode[];
}

function node(name: string, local?: string): TocNode {
	return { name, local, children: [] };
}

/**
 * Nest a page's headings beneath its title node. Heading levels are relative,
 * so a jump from h2 to h4 nests under the h2 rather than creating an empty h3.
 *
 * Every node gets a `Local`, including the deepest heading. A node with neither
 * a `Local` nor children is rejected by hhc.exe, and it takes the whole branch
 * down with it: the note vanishes from the Contents pane and the headings that
 * should have appeared under it go too. That is why heading children point at
 * their own anchor rather than being left anonymous.
 */
function attachHeadings(root: TocNode, headings: HeadingInfo[], outputName: string): void {
	const stack: Array<{ level: number; node: TocNode }> = [];

	for (const heading of headings) {
		// The page title already represents h1 in the TOC.
		if (heading.level <= 1) continue;

		while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
			stack.pop();
		}

		const child = node(heading.text, `${outputName}#${heading.anchor}`);
		const parent = stack.length > 0 ? stack[stack.length - 1].node : root;
		parent.children.push(child);

		stack.push({ level: heading.level, node: child });
	}
}

function buildHeadingTree(pages: PageEntry[]): TocNode[] {
	const roots: TocNode[] = [];
	for (const page of pages) {
		const pageNode = node(page.title, page.outputName);
		attachHeadings(pageNode, page.headings, page.outputName);
		roots.push(pageNode);
	}
	return roots;
}

function buildFolderTree(pages: PageEntry[]): TocNode[] {
	const roots: TocNode[] = [];

	for (const page of pages) {
		const segments = page.vaultPath.split("/").filter((s) => s.length > 0);
		// The last segment is the filename; the rest are folders.
		const folders = segments.slice(0, -1);

		let level = roots;
		for (const folder of folders) {
			let existing = level.find((n) => n.name === folder && !n.local);
			if (!existing) {
				existing = node(folder);
				level.push(existing);
			}
			level = existing.children;
		}

		level.push(node(page.title, page.outputName));
	}

	return roots;
}

function buildFlatTree(pages: PageEntry[]): TocNode[] {
	return [...pages]
		.sort((a, b) => a.title.localeCompare(b.title))
		.map((page) => node(page.title, page.outputName));
}

function renderNodes(nodes: TocNode[], indent: string): string {
	const lines: string[] = [`${indent}<UL>`];
	for (const n of nodes) {
		lines.push(`${indent}\t<LI><OBJECT type="text/sitemap">`);
		lines.push(`${indent}\t\t<param name="Name" value="${esc(n.name)}">`);
		if (n.local) {
			lines.push(`${indent}\t\t<param name="Local" value="${esc(n.local)}">`);
		}
		lines.push(`${indent}\t\t</OBJECT>`);
		if (n.children.length > 0) {
			lines.push(renderNodes(n.children, `${indent}\t`));
		}
	}
	lines.push(`${indent}</UL>`);
	return lines.join("\n");
}

// The charset declaration describes the bytes we actually write (see ansi.ts:
// these files are encoded as Windows-1252 because that is what hhc.exe reads
// them as). hhc.exe ignores the declaration either way, but tools that open the
// sitemaps directly should not have to guess.
const SITEMAP_HEADER = `<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML//EN">
<HTML>
<HEAD>
<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">
<meta name="GENERATOR" content="md-to-chm">
<!-- Sitemap 1.0 -->
</HEAD><BODY>
<OBJECT type="text/site properties">
\t<param name="ImageType" value="Folder">
</OBJECT>`;

/** Build the `.hhc` contents file for the chosen strategy. */
export function generateHhc(pages: PageEntry[], mode: TocMode): string {
	let roots: TocNode[];
	switch (mode) {
		case "folders":
			roots = buildFolderTree(pages);
			break;
		case "flat":
			roots = buildFlatTree(pages);
			break;
		case "headings":
		default:
			roots = buildHeadingTree(pages);
			break;
	}

	return `${SITEMAP_HEADER}
${renderNodes(roots, "")}
</BODY></HTML>
`;
}

/**
 * Keywords that are not headings, split by where they came from. Both are
 * finding aids rather than navigation targets, and a flat index renders them
 * indistinguishably from headings, so each group gets its own parent entry.
 */
export interface IndexKeywords {
	tags: Map<string, string[]>;
	aliases: Map<string, string[]>;
}

function sortNodes(nodes: TocNode[]): void {
	nodes.sort((a, b) =>
		a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
	);
}

/**
 * Build the `.hhk` keyword index: every heading, plus the note's tags and
 * aliases grouped beneath a `Tags` and an `Aliases` entry.
 */
export function generateHhk(pages: PageEntry[], keywords: IndexKeywords): string {
	const seen = new Set<string>();

	// A keyword can reach several pages, which is expressed as one entry per
	// page sharing a Name; the viewer merges those into a single index entry.
	const entry = (name: string, local: string): TocNode | null => {
		const key = `${name}\u0000${local}`;
		if (seen.has(key)) return null;
		seen.add(key);
		return node(name, local);
	};

	const roots: TocNode[] = [];

	for (const page of pages) {
		for (const heading of page.headings) {
			const n = entry(heading.text, `${page.outputName}#${heading.anchor}`);
			if (n) roots.push(n);
		}
	}

	const group = (label: string, source: Map<string, string[]>): void => {
		const children: TocNode[] = [];
		for (const [keyword, outputs] of source) {
			for (const outputName of outputs) {
				const n = entry(keyword, outputName);
				if (n) children.push(n);
			}
		}
		if (children.length === 0) return;
		const anchor = pages[0];
		if (!anchor) return;

		sortNodes(children);
		// Unlike the Contents pane, which accepts a parent with no target as
		// long as it has children, the index pane discards such a parent and
		// promotes its children to the top level — undoing the grouping. There
		// is no page a "Tags" heading belongs to, so it opens the same topic the
		// CHM opens on startup.
		const parent = node(label, anchor.outputName);
		parent.children = children;
		roots.push(parent);
	};

	// The hash is not decoration. The index pane sorts its own entries by name
	// and ignores the order they appear in this file, so a group named plain
	// "Tags" lands under T, in the middle of the headings, with a heading that
	// sorts after it stranded just below the group's children. Punctuation sorts
	// before letters, so the prefix lifts both groups clear of the A-Z run.
	group("# Tags", keywords.tags);
	group("# Aliases", keywords.aliases);
	// Sorted for a deterministic, readable file only; the pane re-sorts it.
	sortNodes(roots);

	return `${SITEMAP_HEADER}
${renderNodes(roots, "")}
</BODY></HTML>
`;
}

export interface HhpOptions {
	title: string;
	/** Bare filename of the output .chm inside the staging directory. */
	chmFileName: string;
	/** Bare filename of the .hhc, or null to omit contents. */
	hhcFileName: string | null;
	/** Bare filename of the .hhk, or null to omit the index. */
	hhkFileName: string | null;
	defaultTopic: string;
	language: string;
	/** Every file to embed, as staging-relative forward-slash paths. */
	files: string[];
}

/** Build the `.hhp` project file. */
export function generateHhp(opts: HhpOptions): string {
	const options: string[] = [
		"[OPTIONS]",
		"Compatibility=1.1 or later",
		`Compiled file=${opts.chmFileName}`,
		`Default topic=${opts.defaultTopic}`,
		"Display compile progress=No",
		"Full-text search=Yes",
		`Language=${opts.language}`,
		// The window title is read from this file as Windows-1252 too, so it gets
		// the same treatment as sitemap text.
		`Title=${navSafe(opts.title)}`,
	];

	if (opts.hhcFileName) {
		options.push(`Contents file=${opts.hhcFileName}`);
	}
	if (opts.hhkFileName) {
		options.push(`Index file=${opts.hhkFileName}`);
	}

	// No [WINDOWS] section is emitted deliberately. A window definition is a
	// positional string of two dozen fields, and a hand-written one that leaves
	// the optional fields empty compiles without complaint but yields a broken
	// viewer: a single pane showing only the index, no Contents/Index/Search tab
	// strip, and no way to reach the table of contents. Left to itself, hhc.exe
	// derives the standard tri-pane window from the Contents file, Index file and
	// Full-text search entries above — which is what we want anyway.

	// hhc.exe resolves [FILES] entries with forward slashes reliably; backslashes
	// fail on some builds.
	const files = opts.files
		.map((f) => f.replace(/\\/g, "/"))
		.filter((f, i, arr) => arr.indexOf(f) === i);

	return `${options.join("\n")}

[FILES]
${files.join("\n")}
`;
}
