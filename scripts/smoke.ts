/*
 * Smoke test for the parts of the plugin that do not need hhc.exe or a running
 * Obsidian instance: path sanitising, app:// URL decoding, and the .hhp/.hhc/
 * .hhk generators. Compile with scripts/smoke.build.mjs and run under Node.
 */

import {
	sanitizeName,
	isCompilerSafePath,
	isDirectory,
	toShortPath,
	createStagingDir,
	removeDirRecursive,
} from "../src/util/paths";
import { appUrlToVaultPath, resolveRelative } from "../src/export/renderer";
import { assetToken, rewriteAssetPlaceholders } from "../src/export/assets";
import {
	generateHhc,
	generateHhk,
	generateHhp,
	IndexKeywords,
	PageEntry,
} from "../src/export/project-files";
import { navSafe, unsupportedCount, encodeAnsi } from "../src/export/ansi";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
	if (condition) {
		passed++;
		console.log(`  ok   ${label}`);
	} else {
		failed++;
		console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
	}
}

function section(name: string): void {
	console.log(`\n${name}`);
}

// ---------------------------------------------------------------------
section("sanitizeName");

check("strips spaces", sanitizeName("My Notes") === "My_Notes");
check("strips dashes and dots", sanitizeName("api-v1.2") === "api_v1_2");
check("never starts with a dot", !sanitizeName(".hidden").startsWith("."));
check(
	"falls back when nothing survives",
	sanitizeName("...", "item") === "item"
);
check(
	"keeps alphanumerics and underscores",
	sanitizeName("Page_01") === "Page_01"
);

// ---------------------------------------------------------------------
section("isCompilerSafePath");

check(
	"accepts a plain temp path",
	isCompilerSafePath("C:\\Users\\stef\\AppData\\Local\\Temp\\mdchm_abc")
);
check("rejects spaces", !isCompilerSafePath("C:\\Users\\John Smith\\Temp\\x"));
check("rejects dot-folders", !isCompilerSafePath("C:\\vault\\.obsidian\\x"));
check("rejects a dot segment anywhere", !isCompilerSafePath("C:\\a\\.b\\c"));

// ---------------------------------------------------------------------
section("appUrlToVaultPath");

check(
	"decodes the opaque-host form",
	appUrlToVaultPath("app://abc123/Guides/Setup.md?1700000000", "C:\\Vault") ===
		"Guides/Setup.md"
);
check(
	"decodes percent-encoded names",
	appUrlToVaultPath("app://abc123/My%20Notes/a.md?1", "C:\\Vault") ===
		"My Notes/a.md"
);
check(
	"decodes the local form against a backslash base",
	appUrlToVaultPath(
		"app://local/C:/Vault/attachments/img.png?123",
		"C:\\Vault"
	) === "attachments/img.png"
);
check(
	"decodes the local form against a forward-slash base",
	appUrlToVaultPath(
		"app://local/C:/Vault/attachments/img.png?123",
		"C:/Vault"
	) === "attachments/img.png"
);
check(
	"rejects files outside the vault",
	appUrlToVaultPath("app://local/C:/Elsewhere/x.png?1", "C:\\Vault") === null
);
check(
	"ignores non-app URLs",
	appUrlToVaultPath("https://example.com/a.png", "C:\\Vault") === null
);

// ---------------------------------------------------------------------
section("resolveRelative");

// Regression: `![](attachments/photo.png)` is relative to the note that wrote
// it, which is the shape Obsidian's own exports use. Without resolving it
// against the note's folder the image was never collected or copied at all.
const OCTO = "Evernote Visuals/Octopus---Encyclopedia/Octopus.md";
check(
	"resolves a path beside the note's own attachments",
	resolveRelative("attachments/1-b667e325.png", OCTO) ===
		"Evernote Visuals/Octopus---Encyclopedia/attachments/1-b667e325.png"
);
check(
	"resolves a path from a note at the vault root",
	resolveRelative("attachments/img.png", "Note.md") === "attachments/img.png"
);
check(
	"climbs out of the note's folder",
	resolveRelative("../shared/img.png", "Guides/Setup/Note.md") ===
		"Guides/shared/img.png"
);
check(
	"collapses a leading ./",
	resolveRelative("./img.png", "Guides/Note.md") === "Guides/img.png"
);
check(
	"refuses to climb past the vault root",
	resolveRelative("../../../escape.png", "Guides/Note.md") === null
);

// ---------------------------------------------------------------------
section("asset placeholders");

// Regression: the token used to embed the raw vault path, and the cleanup pass
// dropped anything that looked like a placeholder only up to the first space.
// An image under "Evernote Visuals" was rewritten as ` Visuals/…` — the leading
// segment eaten, the rest left as garbage — so no image ever rendered in the CHM.
const spacedAsset = "Evernote Visuals/attachments/1-b667e325.png";
const spacedToken = assetToken(spacedAsset);

check(
	"a spaced vault path yields a token with no whitespace",
	!/\s/.test(spacedToken),
	spacedToken
);
check(
	"a spaced vault path yields a token with no quote",
	!/["']/.test(spacedToken),
	spacedToken
);
check(
	"the token is recoverable for a path with spaces",
	rewriteAssetPlaceholders(
		`<img src="${spacedToken}">`,
		new Map([[spacedAsset, "assets/Evernote_Visuals/attachments/1-b667e325.png"]])
	) === '<img src="assets/Evernote_Visuals/attachments/1-b667e325.png">'
);
check(
	"the token is recoverable for a path with an apostrophe",
	rewriteAssetPlaceholders(
		`<img src="${assetToken("Notes/Bob's photo.png")}">`,
		new Map([["Notes/Bob's photo.png", "assets/Notes/Bobs_photo.png"]])
	) === '<img src="assets/Notes/Bobs_photo.png">'
);
check(
	"the token survives being read back out of the HTML",
	rewriteAssetPlaceholders(
		`<a href="${assetToken("Guides/My Notes.md")}">x</a>`,
		new Map([["Guides/My Notes.md", "page_0002.html"]])
	) === '<a href="page_0002.html">x</a>'
);
check(
	"an unresolvable placeholder takes its whole attribute with it",
	rewriteAssetPlaceholders(`<img src="${spacedToken}">`, new Map()) === "<img>"
);
check(
	"an unresolvable placeholder leaves no token behind",
	!rewriteAssetPlaceholders(
		`<img src="${spacedToken}">`,
		new Map()
	).includes("__ASSET__")
);
check(
	"an unresolvable placeholder leaves nothing of the vault path behind",
	!rewriteAssetPlaceholders(
		`<img src="${spacedToken}">`,
		new Map()
	).includes("Visuals")
);
check(
	"only the offending attribute is dropped",
	rewriteAssetPlaceholders(
		`<img alt="Octopus" src="${spacedToken}">`,
		new Map()
	) === '<img alt="Octopus">'
);
check(
	"text after a dropped placeholder is not eaten with it",
	rewriteAssetPlaceholders(
		`<img src="${spacedToken}"><p>Caption</p>`,
		new Map()
	) === "<img><p>Caption</p>"
);
check(
	"a placeholder that was resolved survives the cleanup pass",
	rewriteAssetPlaceholders(
		`<img src="${spacedToken}" alt="Octopus">`,
		new Map([[spacedAsset, "assets/Evernote_Visuals/attachments/1-b667e325.png"]])
	) === '<img src="assets/Evernote_Visuals/attachments/1-b667e325.png" alt="Octopus">'
);

// ---------------------------------------------------------------------
section("generateHhp");

const files = ["page_0001.html", "page_0002.html", "assets/img.png"];
const hhp = generateHhp({
	title: "My Docs",
	chmFileName: "My_Docs.chm",
	hhcFileName: "contents.hhc",
	hhkFileName: "keywords.hhk",
	defaultTopic: "page_0001.html",
	language: "0x409 English (United States)",
	files,
});

check("has an [OPTIONS] section", hhp.includes("[OPTIONS]"));
check("declares the compiled file", hhp.includes("Compiled file=My_Docs.chm"));
check("declares the contents file", hhp.includes("Contents file=contents.hhc"));
check("declares the index file", hhp.includes("Index file=keywords.hhk"));
check("declares the default topic", hhp.includes("Default topic=page_0001.html"));
check("sets the title", hhp.includes("Title=My Docs"));
check("enables full-text search", hhp.includes("Full-text search=Yes"));
// Regression: a hand-written [WINDOWS] definition with its optional fields left
// empty compiled cleanly but produced a viewer with no tab strip — only a bare
// index pane, so the table of contents was unreachable. hhc.exe builds a working
// tri-pane window on its own from the [OPTIONS] contents/index entries.
check("omits the [WINDOWS] section", !hhp.includes("[WINDOWS]"));
check("includes a [FILES] section", hhp.includes("[FILES]"));
check(
	"lists every file with forward slashes",
	files.every((f) => hhp.includes(f))
);
check("contains no backslashes in [FILES]", !/\[FILES\][\s\S]*\\/.test(hhp));

const hhpNoIndex = generateHhp({
	title: "T",
	chmFileName: "T.chm",
	hhcFileName: null,
	hhkFileName: null,
	defaultTopic: "page_0001.html",
	language: "0x409 English (United States)",
	files: ["page_0001.html"],
});
check(
	"omits the index line when there is no index",
	!hhpNoIndex.includes("Index file=")
);
check(
	"omits the contents line when there is no TOC",
	!hhpNoIndex.includes("Contents file=")
);

// ---------------------------------------------------------------------
const pages: PageEntry[] = [
	{
		outputName: "page_0001.html",
		title: "Installation",
		vaultPath: "Guides/Setup/Installation.md",
		headings: [
			{ level: 1, text: "Installation", anchor: "installation" },
			{ level: 2, text: "Requirements", anchor: "requirements" },
			{ level: 3, text: "Windows", anchor: "windows" },
			{ level: 2, text: "Steps", anchor: "steps" },
		],
	},
	{
		outputName: "page_0002.html",
		title: "Reference & Notes",
		vaultPath: "Reference/API.md",
		headings: [
			{ level: 1, text: "Reference", anchor: "reference" },
			{ level: 2, text: "Methods", anchor: "methods" },
		],
	},
];

/**
 * Count sitemap entries that point nowhere and lead nowhere. hhc.exe rejects
 * such an entry and silently drops the whole branch it belongs to — the bug
 * that made every note with sub-headings vanish from the Contents pane.
 */
function danglingSitemapEntries(hhc: string): number {
	let dangling = 0;
	for (const part of hhc.split('<LI><OBJECT type="text/sitemap">').slice(1)) {
		if (!part.includes('<param name="Local"') && !part.includes("<UL>")) dangling++;
	}
	return dangling;
}

section("generateHhc (headings)");

const hhcHeadings = generateHhc(pages, "headings");
check("is a sitemap document", hhcHeadings.includes("<!-- Sitemap 1.0 -->"));
// Regression: hhc.exe reads a sitemap as Windows-1252 and the viewer renders
// the Contents pane in that codepage, so a UTF-8 sitemap turned "→" into "â†’"
// and dropped emoji entirely. The declaration now matches the bytes written.
check(
	"declares the codepage the sitemap is written in",
	hhcHeadings.includes("charset=windows-1252")
);
check(
	"has balanced <UL> tags",
	(hhcHeadings.match(/<UL>/g) ?? []).length ===
		(hhcHeadings.match(/<\/UL>/g) ?? []).length
);
check("includes the page title", hhcHeadings.includes('value="Installation"'));
check("includes nested headings", hhcHeadings.includes('value="Requirements"'));
check("includes deep headings", hhcHeadings.includes('value="Windows"'));
check(
	"escapes ampersands in titles",
	hhcHeadings.includes("Reference &amp; Notes")
);
check(
	"does not duplicate h1 as a child",
	(hhcHeadings.match(/value="Installation"/g) ?? []).length === 1
);
check(
	"nests Windows one level deeper than Requirements",
	hhcHeadings.indexOf('value="Windows"') >
		hhcHeadings.indexOf('value="Requirements"')
);
// Regression: a heading entry with neither a Local nor children is rejected by
// hhc.exe, and the note it hung from disappeared from the Contents pane.
check(
	"links each nested heading to its own anchor",
	hhcHeadings.includes('value="page_0001.html#requirements"') &&
		hhcHeadings.includes('value="page_0001.html#windows"')
);
check(
	"leaves no heading entry pointing nowhere",
	danglingSitemapEntries(hhcHeadings) === 0
);

section("generateHhc (folders)");

const hhcFolders = generateHhc(pages, "folders");
check("creates a Guides node", hhcFolders.includes('value="Guides"'));
check("creates a Setup node", hhcFolders.includes('value="Setup"'));
check("creates a Reference node", hhcFolders.includes('value="Reference"'));
check(
	"has balanced <UL> tags",
	(hhcFolders.match(/<UL>/g) ?? []).length ===
		(hhcFolders.match(/<\/UL>/g) ?? []).length
);
check(
	"leaves no folder entry pointing nowhere",
	danglingSitemapEntries(hhcFolders) === 0
);

section("generateHhc (flat)");

const hhcFlat = generateHhc(pages, "flat");
check("is a single level", (hhcFlat.match(/<UL>/g) ?? []).length === 1);
check("lists both pages", hhcFlat.includes("Installation") && hhcFlat.includes("Notes"));
check("leaves no flat entry pointing nowhere", danglingSitemapEntries(hhcFlat) === 0);

// ---------------------------------------------------------------------
section("generateHhk");

const extras: IndexKeywords = {
	tags: new Map([
		["setup", ["page_0001.html"]],
		["api", ["page_0002.html", "page_0001.html"]],
	]),
	aliases: new Map([["Getting Started", ["page_0001.html"]]]),
};

const hhk = generateHhk(pages, extras);
check(
	"has balanced <UL> tags",
	(hhk.match(/<UL>/g) ?? []).length === (hhk.match(/<\/UL>/g) ?? []).length
);
// Regression: same failure as the contents pane — the index tab showed "â†’"
// instead of "→" and "ðŸ§" instead of an emoji.
check(
	"declares the codepage the index is written in",
	hhk.includes("charset=windows-1252")
);
check("includes heading keywords", hhk.includes('value="Requirements"'));
check(
	"links headings with anchors",
	hhk.includes('value="page_0001.html#requirements"')
);
check(
	"sorts headings alphabetically",
	hhk.indexOf('value="Installation"') < hhk.indexOf('value="Requirements"')
);
// Regression: tags and aliases used to sit in the same flat list as headings,
// indistinguishable from them. Each group now hangs off its own entry.
check("groups tags under a Tags entry", hhk.includes('value="# Tags"'));
check("groups aliases under an Aliases entry", hhk.includes('value="# Aliases"'));
// The index pane drops a parent entry that has no Local and promotes its
// children, which silently undid the grouping.
const tagPart = hhk
	.split('<LI><OBJECT type="text/sitemap">')
	.find((p) => p.includes('value="# Tags"'));
check(
	"the Tags entry carries a target of its own",
	!!tagPart && tagPart.includes('<param name="Local"')
);
check(
	"nests a tag beneath the Tags entry",
	hhk.indexOf('value="# Tags"') < hhk.indexOf('value="setup"')
);
check(
	"nests an alias beneath the Aliases entry",
	hhk.indexOf('value="# Aliases"') < hhk.indexOf('value="Getting Started"')
);
// The headings stay siblings of the group rather than members of it.
const tagsBlock = hhk.match(
	/value="# Tags">[\s\S]*?<\/OBJECT>\s*<UL>([\s\S]*?)<\/UL>/
);
check(
	"groups only tag keywords beneath Tags",
	!!tagsBlock &&
		tagsBlock[1].includes('value="setup"') &&
		!tagsBlock[1].includes('value="Requirements"')
);
// Regression: the pane sorts entries by name, so a group named plain "Tags"
// buried itself under T among the headings. The prefix is what lifts it out.
check(
	"prefixes the group so it sorts clear of the headings",
	(hhk.match(/value="# /g) ?? []).length === 2
);
check("leaves no index entry pointing nowhere", danglingSitemapEntries(hhk) === 0);
// A keyword reaching two pages is expressed as two sitemap entries sharing a
// Name, which is how the CHM viewer merges them into one index entry.
check(
	"a tag pointing at two pages yields two index entries",
	(hhk.match(/<param name="Name" value="api">/g) ?? []).length === 2
);

const headingsOnly = generateHhk(pages, { tags: new Map(), aliases: new Map() });
check(
	"omits the group entries when there are no tags",
	!headingsOnly.includes('value="# Tags"') &&
		!headingsOnly.includes('value="# Aliases"')
);

const emptyHhk = generateHhk([], { tags: new Map(), aliases: new Map() });
check(
	"handles an empty index without throwing",
	emptyHhk.includes("<UL>") && emptyHhk.includes("</UL>")
);

// ---------------------------------------------------------------------
section("navigation-pane text");

check(
	"folds an arrow to ASCII",
	navSafe("Growth → Habits") === "Growth -> Habits"
);
check(
	"drops an emoji and the space it leaves behind",
	navSafe("🧠 A simple framework") === "A simple framework"
);
check(
	"keeps characters Windows-1252 can hold",
	navSafe("café «résumé» – ok") === "café «résumé» – ok"
);
check("leaves ordinary text untouched", navSafe("Installation") === "Installation");
check("counts what it had to change", unsupportedCount("→ 🧠") === 2);
check("encodes an accent as one byte", encodeAnsi("é")[0] === 0xe9);
check("encodes an em dash as 0x97", encodeAnsi("—")[0] === 0x97);
check("flags an unrepresentable character", encodeAnsi("→")[0] === 0x3f);

const arrowPages: PageEntry[] = [
	{
		outputName: "page_0003.html",
		title: "Growth → Habits 🧠",
		vaultPath: "Guides/Health.md",
		headings: [
			{ level: 1, text: "Growth → Habits 🧠", anchor: "growth" },
		],
	},
];
const arrowHhc = generateHhc(arrowPages, "headings");
check(
	"a finished sitemap holds nothing the pane cannot draw",
	unsupportedCount(arrowHhc) === 0
);
check(
	"the folded arrow survives escaping",
	arrowHhc.includes("Growth -&gt; Habits")
);
check(
	"the emoji is gone from the sitemap",
	!arrowHhc.includes("🧠")
);

// ---------------------------------------------------------------------
section("staging directory");

(async () => {
	const staging = await createStagingDir();

	check("real path exists", isDirectory(staging.realPath));
	check("compiler path exists", isDirectory(staging.compilerPath));
	check(
		"compiler path is safe for hhc.exe",
		isCompilerSafePath(staging.compilerPath),
		staging.compilerPath
	);
	// Regression: a cmd quoting mistake made short-path resolution return
	// C:\"C:\Users\…\" while exiting 0. It contains no space and no dot segment,
	// so the safety check accepted it, and hhc.exe was then handed a working
	// directory that did not exist — surfacing as an opaque null exit code.
	check(
		"compiler path contains no quote characters",
		!/["']/.test(staging.compilerPath),
		staging.compilerPath
	);

	if (process.platform === "win32") {
		const short = await toShortPath(staging.realPath);
		check(
			"toShortPath resolves to a real directory",
			short !== null && isDirectory(short),
			String(short)
		);
	}

	await removeDirRecursive(staging.realPath);

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
})();
