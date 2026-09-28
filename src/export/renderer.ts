import { App, Component, MarkdownRenderer, TFile } from "obsidian";

/**
 * Renders notes through Obsidian's own MarkdownRenderer so wikilinks, embeds,
 * callouts, math and code highlighting all work, then cleans the result up for
 * the CHM viewer's ancient MSHTML engine.
 */

export interface HeadingInfo {
	level: number;
	text: string;
	anchor: string;
}

export interface RenderedBody {
	bodyHtml: string;
	headings: HeadingInfo[];
	/** Vault-relative paths referenced by this page (images, downloads, embeds). */
	assetRefs: string[];
	/** Links whose target was not part of the export and were flattened. */
	deadLinks: string[];
}

/** Attributes that mean something to Obsidian but nothing to MSHTML. */
const STRIPPED_ATTRIBUTES = [
	"srcset",
	"loading",
	"decoding",
	"draggable",
	"contenteditable",
	"spellcheck",
];

function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : "section";
}

/**
 * Convert an Obsidian `app://` URL into a vault-relative path.
 *
 * Two shapes exist across Obsidian versions:
 *   app://<opaque-id>/<url-encoded vault path>?<mtime>
 *   app://local/<absolute filesystem path>?<mtime>
 */
export function appUrlToVaultPath(
	url: string,
	vaultBasePath: string
): string | null {
	if (!url.startsWith("app://")) return null;

	let withoutScheme = url.slice("app://".length);
	// Drop the cache-busting query string.
	const queryIndex = withoutScheme.indexOf("?");
	if (queryIndex >= 0) withoutScheme = withoutScheme.slice(0, queryIndex);
	withoutScheme = withoutScheme.replace(/#.*$/, "");

	let decoded: string;
	try {
		decoded = decodeURIComponent(withoutScheme);
	} catch {
		decoded = withoutScheme;
	}

	// First form: app://<opaque-id>/<vault-relative path>
	const firstSlash = decoded.indexOf("/");
	if (firstSlash < 0) return null;
	const host = decoded.slice(0, firstSlash);
	const rest = decoded.slice(firstSlash + 1);

	if (host !== "local") {
		return rest.replace(/^\/+/, "");
	}

	// Second form: the remainder is an absolute path on disk. Base paths arrive
	// with either separator depending on platform and Obsidian version, so both
	// sides are normalised to backslashes before comparing.
	const normalised = rest.replace(/\//g, "\\");
	const base = vaultBasePath
		.replace(/\//g, "\\")
		.replace(/\\+$/, "");
	if (base.length === 0) return null;
	if (normalised.toLowerCase().startsWith(base.toLowerCase() + "\\")) {
		return normalised.slice(base.length + 1).replace(/\\/g, "/");
	}
	return null;
}

/** Strip Obsidian-specific markup that the CHM viewer cannot use. */
function stripObsidianMarkup(root: HTMLElement): void {
	// Scripts never run in a CHM and only add noise.
	root.querySelectorAll("script").forEach((node) => node.remove());

	root.querySelectorAll("*").forEach((el) => {
		for (const attr of Array.from(el.attributes)) {
			const name = attr.name.toLowerCase();
			if (name.startsWith("data-") && name !== "data-href") {
				el.removeAttribute(attr.name);
			} else if (STRIPPED_ATTRIBUTES.includes(name)) {
				el.removeAttribute(attr.name);
			} else if (name.startsWith("on")) {
				el.removeAttribute(attr.name);
			}
		}
		// Obsidian tags every rendered element with a per-session class that is
		// meaningless once exported and bloats the HTML.
		const classes = el.getAttribute("class");
		if (classes && /[0-9a-f]{6,}/i.test(classes)) {
			el.setAttribute(
				"class",
				classes
					.split(/\s+/)
					.filter((c) => !/[0-9a-f]{6,}/i.test(c))
					.join(" ")
			);
		}
	});

	// Anchor links Obsidian injects for its own internal navigation.
	root.querySelectorAll("a.anchor-link, a.header-anchor").forEach((n) => n.remove());
}

/** Give every heading a stable id so the TOC and index can link to it. */
function annotateHeadings(root: HTMLElement): HeadingInfo[] {
	const headings: HeadingInfo[] = [];
	const used = new Map<string, number>();

	root.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((node) => {
		const text = (node.textContent ?? "").trim();
		if (text.length === 0) return;

		const level = parseInt(node.tagName.substring(1), 10);
		let anchor = slugify(text);

		const seen = used.get(anchor);
		if (seen !== undefined) {
			used.set(anchor, seen + 1);
			anchor = `${anchor}-${seen + 1}`;
		} else {
			used.set(anchor, 1);
		}

		node.setAttribute("id", anchor);
		node.removeAttribute("data-heading");
		headings.push({ level, text, anchor });
	});

	return headings;
}

export interface RenderContext {
	app: App;
	component: Component;
	/** Output filename for each exported note, keyed by vault path. */
	fileMap: Map<string, string>;
	/** Resolved vault base path, used to decode app:// URLs. */
	vaultBasePath: string;
}

/**
 * Render one note to a cleaned HTML body fragment.
 */
export async function renderNote(
	ctx: RenderContext,
	file: TFile,
	markdown: string
): Promise<RenderedBody> {
	const host = document.createElement("div");
	// Kept detached from the document: no layout cost, and nothing the user sees.

	await MarkdownRenderer.render(
		ctx.app,
		markdown,
		host,
		file.path,
		ctx.component
	);

	// Math is rendered asynchronously after the promise resolves.
	await new Promise((resolve) => window.setTimeout(resolve, 0));

	stripObsidianMarkup(host);

	const assetRefs: string[] = [];
	const deadLinks: string[] = [];

	// Rewrite media first, so that links discovered inside embeds are handled
	// even when the embed wrapper is replaced.
	host.querySelectorAll("img, source, video, audio, object, embed").forEach((node) => {
		for (const attr of ["src", "data"]) {
			const value = node.getAttribute(attr);
			if (!value || !value.startsWith("app://")) continue;

			const vaultPath = appUrlToVaultPath(value, ctx.vaultBasePath);
			if (vaultPath) {
				assetRefs.push(vaultPath);
				// Replaced with a real relative path once assets are copied.
				node.setAttribute(attr, `__ASSET__${vaultPath}`);
			} else {
				node.removeAttribute(attr);
			}
		}
	});

	// Internal links: point them at the exported page, or flatten them.
	host.querySelectorAll("a").forEach((node) => {
		const href = node.getAttribute("data-href") ?? node.getAttribute("href") ?? "";

		if (href.startsWith("app://")) {
			const vaultPath = appUrlToVaultPath(href, ctx.vaultBasePath);
			if (vaultPath) {
				assetRefs.push(vaultPath);
				node.setAttribute("href", `__ASSET__${vaultPath}`);
				node.removeAttribute("data-href");
				return;
			}
		}

		if (href.startsWith("http://") || href.startsWith("https://")) {
			node.removeAttribute("data-href");
			return;
		}

		// Resolve the wikilink target the same way Obsidian would.
		const target = ctx.app.metadataCache.getFirstLinkpathDest(href, file.path);
		const outputName = target ? ctx.fileMap.get(target.path) : undefined;

		if (target && outputName) {
			const subpath = node.getAttribute("data-href")?.split("#")[1];
			node.setAttribute("href", subpath ? `${outputName}#${slugify(subpath)}` : outputName);
			node.removeAttribute("data-href");
			node.removeAttribute("target");
			node.removeAttribute("rel");
			return;
		}

		// Target is not in this export — flatten to text so the CHM has no dead ends.
		if (href.length > 0 && !href.startsWith("#")) {
			deadLinks.push(href);
			const span = document.createElement("span");
			span.className = "mdtoc-dead-link";
			span.textContent = node.textContent ?? href;
			node.replaceWith(span);
		}
	});

	const headings = annotateHeadings(host);

	return {
		bodyHtml: host.innerHTML,
		headings,
		assetRefs: Array.from(new Set(assetRefs)),
		deadLinks: Array.from(new Set(deadLinks)),
	};
}

/** Wrap a cleaned body fragment into a complete, legacy-friendly document. */
export function wrapDocument(title: string, bodyHtml: string, css: string): string {
	const safeTitle = title.replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<title>${safeTitle}</title>
<style type="text/css">
${css}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}
