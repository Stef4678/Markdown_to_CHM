import { App, TFile } from "obsidian";
import * as path from "path";
import { sanitizeName, writeFileDeep } from "../util/paths";
import { BuildLog } from "../util/log";

/**
 * Copies referenced attachments into the staging directory under hhc-safe
 * names and records where each one landed so the HTML can be rewritten.
 */

export interface AssetCopyResult {
	/** Vault path -> staging-relative path using forward slashes. */
	paths: Map<string, string>;
	/** Vault paths that could not be read or found. */
	missing: string[];
	/** Total bytes copied. */
	bytes: number;
}

/**
 * Build a collision-free, hhc-safe output path for an attachment.
 * Each segment is sanitized independently so folder grouping survives, but the
 * result never contains a space, a dot-prefixed segment, or a stray dot.
 */
function planOutputPath(
	vaultPath: string,
	used: Map<string, number>
): string {
	const segments = vaultPath.split("/").filter((s) => s.length > 0);
	const safeSegments = segments.map((segment, index) => {
		const isLast = index === segments.length - 1;
		if (!isLast) return sanitizeName(segment, "dir");

		const ext = path.extname(segment);
		const stem = segment.slice(0, segment.length - ext.length);
		// Extensions are safe to keep when they are plain alphanumerics; they
		// help the CHM viewer pick the right handler.
		const safeExt = /^\.[A-Za-z0-9]{1,8}$/.test(ext)
			? ext.toLowerCase()
			: "";
		return sanitizeName(stem, "file") + safeExt;
	});

	let candidate = `assets/${safeSegments.join("/")}`;
	const count = used.get(candidate);
	if (count !== undefined) {
		used.set(candidate, count + 1);
		const ext = path.extname(candidate);
		candidate = `${candidate.slice(0, candidate.length - ext.length)}_${count + 1}${ext}`;
	} else {
		used.set(candidate, 1);
	}

	return candidate;
}

export async function copyAssets(
	app: App,
	vaultPaths: string[],
	stagingRealPath: string,
	log: BuildLog
): Promise<AssetCopyResult> {
	const paths = new Map<string, string>();
	const missing: string[] = [];
	const used = new Map<string, number>();
	let bytes = 0;

	for (const vaultPath of vaultPaths) {
		if (paths.has(vaultPath)) continue;

		const abstract = app.vault.getAbstractFileByPath(vaultPath);
		if (!(abstract instanceof TFile)) {
			missing.push(vaultPath);
			log.warn(`Attachment not found in vault: ${vaultPath}`);
			continue;
		}

		try {
			const data = await app.vault.readBinary(abstract);
			const outputRel = planOutputPath(vaultPath, used);
			const outputAbs = path.join(
				stagingRealPath,
				...outputRel.split("/")
			);

			await writeFileDeep(outputAbs, Buffer.from(data));

			paths.set(vaultPath, outputRel);
			bytes += data.byteLength;
		} catch (err) {
			missing.push(vaultPath);
			log.warn(
				`Could not copy attachment ${vaultPath}: ${
					err instanceof Error ? err.message : String(err)
				}`
			);
		}
	}

	if (paths.size > 0) {
		log.info(`Copied ${paths.size} attachment(s).`);
	}

	return { paths, missing, bytes };
}

/**
 * The placeholder the renderer leaves in place of an attachment until it has
 * been copied.
 *
 * The vault path is percent-encoded because the token goes straight into an HTML
 * attribute. A raw path can contain characters that end the attribute, and a
 * space was enough to break this: an image in a folder called "Evernote Visuals"
 * was cleaned up as `__ASSET__Evernote`, leaving the rest of the path behind as
 * garbage and the image pointing nowhere.
 */
export function assetToken(vaultPath: string): string {
	// encodeURIComponent leaves apostrophes alone, and an apostrophe ends a
	// single-quoted attribute as surely as a quote ends a double-quoted one.
	return `__ASSET__${encodeURIComponent(vaultPath).replace(/'/g, "%27")}`;
}

/**
 * Swap the `__ASSET__…` placeholders left by the renderer for the real relative
 * paths. Uses split/join rather than a regex so that vault paths containing
 * regex metacharacters cannot corrupt the output.
 */
export function rewriteAssetPlaceholders(
	html: string,
	assetPaths: Map<string, string>
): string {
	let result = html;

	for (const [vaultPath, outputRel] of assetPaths) {
		const token = assetToken(vaultPath);
		if (result.indexOf(token) < 0) continue;
		result = result.split(token).join(outputRel);
	}

	// Any placeholder still present referenced an attachment we could not copy.
	// The whole attribute goes with it: an empty `src` makes the viewer load the
	// page itself, and a bare token resolves to nothing outside Obsidian.
	if (result.indexOf("__ASSET__") >= 0) {
		result = result.replace(
			/\s+[A-Za-z_:][-A-Za-z0-9_:.]*=(?:"__ASSET__[^"]*"|'__ASSET__[^']*')/g,
			""
		);
		// A token that was not a whole attribute value still must not survive.
		// Stopping at whitespace, a quote and `>` keeps this from eating markup.
		result = result.replace(/__ASSET__[^\s>"']*/g, "");
	}

	return result;
}
