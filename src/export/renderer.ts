import { App, Component, MarkdownRenderer, TFile } from "obsidian";
import { assetToken } from "./assets";

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
	/**
	 * Media sources that named a file the vault could not place. Reported rather
	 * than dropped silently: a missing image is otherwise invisible until the
	 * finished CHM is opened.
	 */
	unresolvedMedia: string[];
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
 * Reduce a path that may be absolute to a vault-relative one.
 *
 * Separators arrive in either direction depending on platform and Obsidian
 * version, so both sides are normalised to backslashes before comparing.
 * Returns null for an absolute path that lies outside the vault.
 */
function toVaultRelative(
	candidate: string,
	vaultBasePath: string
): string | null {
	const normalised = candidate.replace(/\//g, "\\");
	const base = vaultBasePath.replace(/\//g, "\\").replace(/\\+$/, "");

	const isAbsolute =
		/^[A-Za-z]:\\/.test(normalised) || normalised.startsWith("\\\\");

	if (isAbsolute) {
		if (base.length === 0) return null;
		if (!normalised.toLowerCase().startsWith(base.toLowerCase() + "\\")) {
			return null;
		}
		const rest = normalised.slice(base.length + 1).replace(/\\/g, "/");
		return rest.length > 0 ? rest : null;
	}

	return normalised.replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * Convert an Obsidian `app://` URL into a vault-relative path.
 *
 * Three shapes reach this on the desktop:
 *   app://<opaque-token>/<absolute path>?<mtime>
 *   app://local/<absolute path>?<mtime>
 *   app://<vault-id>/<vault-relative path>?<mtime>
 *
 * The host is not a reliable signal for what follows it. Obsidian builds its
 * resource URLs as `resourcePathPrefix + <path with the file:/// prefix cut
 * off>`, and that prefix is `app://<random 36-character token>/` — so the host
 * is an opaque token and the remainder is still an absolute path. Reading the
 * host instead cost a whole export's images: `C:/Users/...` was returned as if
 * it were a vault path, and the lookup then searched for a folder called "C:"
 * inside the vault. Which shape this is, is decided by looking at the
 * remainder, not at the host.
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

	// Everything after the host is either an absolute path or a vault path.
	const firstSlash = decoded.indexOf("/");
	if (firstSlash < 0) return null;

	return toVaultRelative(decoded.slice(firstSlash + 1), vaultBasePath);
}

/** Sources the CHM viewer loads for itself, so they are left as they are. */
function isExternalSource(value: string): boolean {
	return /^(https?:|data:|mailto:|file:|#)/i.test(value);
}

/**
 * Join a vault-relative link path onto the folder of the note that wrote it,
 * collapsing `.` and `..` segments. Returns null if it climbs out of the vault.
 */
export function resolveRelative(
	linkpath: string,
	sourcePath: string
): string | null {
	const slash = sourcePath.lastIndexOf("/");
	const base = slash < 0 ? "" : sourcePath.slice(0, slash);

	const segments = base.length > 0 ? base.split("/") : [];
	for (const part of linkpath.split("/")) {
		if (part.length === 0 || part === ".") continue;
		if (part === "..") {
			if (segments.length === 0) return null;
			segments.pop();
			continue;
		}
		segments.push(part);
	}

	return segments.length > 0 ? segments.join("/") : null;
}

/**
 * Resolve a media source to a vault path, or null when it is not a vault file.
 *
 * Obsidian hands wikilink embeds back as `app://` URLs, but a plain markdown
 * image — `![](attachments/photo.png)` — keeps its path exactly as the note
 * wrote it, so it has to be resolved against that note the way Obsidian resolves
 * a link. Without this those images were never collected, never copied, and
 * never listed in the project, so they were missing from the CHM entirely.
 */
function resolveVaultPath(
	ctx: RenderContext,
	value: string,
	sourcePath: string
): string | null {
	const fromApp = appUrlToVaultPath(value, ctx.vaultBasePath);
	if (fromApp) return fromApp;

	let linkpath = value;
	const hash = linkpath.indexOf("#");
	if (hash >= 0) linkpath = linkpath.slice(0, hash);
	const query = linkpath.indexOf("?");
	if (query >= 0) linkpath = linkpath.slice(0, query);
	if (linkpath.length === 0) return null;

	try {
		linkpath = decodeURIComponent(linkpath);
	} catch {
		// A malformed escape is not worth abandoning the export over.
	}

	const target = ctx.app.metadataCache.getFirstLinkpathDest(
		linkpath,
		sourcePath
	);
	if (target) return target.path;

	// A markdown image path is relative to the note that wrote it, and the link
	// cache does not always place it. `![](attachments/photo.png)` beside the
	// note's own attachments folder is the shape Obsidian itself exports, so it
	// is resolved directly rather than left to the cache.
	const relative = resolveRelative(linkpath, sourcePath);
	if (relative) {
		const file = ctx.app.vault.getAbstractFileByPath(relative);
		if (file instanceof TFile) return file.path;
	}

	const atRoot = ctx.app.vault.getAbstractFileByPath(linkpath);
	return atRoot instanceof TFile ? atRoot.path : null;
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
	const unresolvedMedia: string[] = [];

	const MEDIA = "img, source, video, audio, object, embed";

	/** Point one attribute at its file, once assets are copied. */
	const assign = (node: Element, attr: string, value: string): boolean => {
		const vaultPath = resolveVaultPath(ctx, value, file.path);
		if (!vaultPath) return false;

		assetRefs.push(vaultPath);
		node.setAttribute(attr, assetToken(vaultPath));
		return true;
	};

	// Rewrite media first, so that links discovered inside embeds are handled
	// even when the embed wrapper is replaced.
	const resolved = new Set<Element>();
	host.querySelectorAll(MEDIA).forEach((node) => {
		for (const attr of ["src", "data"]) {
			const value = node.getAttribute(attr);
			if (!value || isExternalSource(value)) continue;

			if (assign(node, attr, value)) {
				resolved.add(node);
				continue;
			}

			// An app:// URL means nothing once it leaves Obsidian, and a path
			// the vault cannot place would only ship as a link to nowhere.
			node.removeAttribute(attr);
			if (!value.startsWith("app://")) unresolvedMedia.push(value);
		}
	});

	// Obsidian hangs the link the note actually wrote on the embed wrapper —
	// `![](attachments/photo.png)` puts it on the span, not on the `<img>`
	// inside. That plain path is worth more than the app:// URL when the URL
	// is one the vault cannot place, so it is used as the fallback.
	//
	// Restricted to media embeds: a note embed is the same span with a `.md`
	// path, and following that would copy the note into the asset folder.
	host.querySelectorAll(".internal-embed.media-embed[src]").forEach((wrapper) => {
		const inner = Array.from(wrapper.querySelectorAll(MEDIA));
		if (inner.length > 0 && inner.some((n) => resolved.has(n))) return;

		const value = wrapper.getAttribute("src");
		if (!value || isExternalSource(value)) return;

		if (!assign(wrapper, "src", value)) unresolvedMedia.push(value);
	});

	// Internal links: point them at the exported page, or flatten them.
	host.querySelectorAll("a").forEach((node) => {
		const href = node.getAttribute("data-href") ?? node.getAttribute("href") ?? "";

		if (href.startsWith("app://")) {
			const vaultPath = appUrlToVaultPath(href, ctx.vaultBasePath);
			if (vaultPath) {
				assetRefs.push(vaultPath);
				node.setAttribute("href", assetToken(vaultPath));
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
		unresolvedMedia: Array.from(new Set(unresolvedMedia)),
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
