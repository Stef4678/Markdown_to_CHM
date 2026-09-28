import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { exec } from "child_process";

/**
 * hhc.exe routes everything through HHA.dll, which mishandles paths containing
 * spaces and fails outright on any path segment beginning with a dot. Since an
 * Obsidian vault always contains `.obsidian`, a build can never be compiled in
 * place — it is staged in a short, space-free temp path instead.
 */

/** Reduce an arbitrary title to characters hhc.exe tolerates in a filename. */
export function sanitizeName(name: string, fallback = "item"): string {
	const cleaned = name
		.normalize("NFKD")
		.replace(/[^A-Za-z0-9_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (cleaned.length === 0) return fallback;
	return cleaned.slice(0, 100);
}

/** True when a path is safe to hand directly to hhc.exe. */
export function isCompilerSafePath(p: string): boolean {
	const segments = p.split(/[\\/]+/).filter((s) => s.length > 0);
	if (segments.some((s) => s.startsWith("."))) return false;
	// A drive prefix such as `C:` is fine; only inspect named segments.
	return !p.includes(" ");
}

/**
 * Resolve a path to its 8.3 short form, or null when it cannot be resolved
 * (short name generation disabled on the volume, or the call failed).
 *
 * This deliberately goes through `exec` rather than `execFile`. `exec` builds
 * `cmd.exe /d /s /c "<command>"`, and `/s` makes cmd strip only the outermost
 * quotes and run the rest verbatim. Passing the same string to `execFile` as an
 * argument instead makes Node escape the inner quotes as `\"`, which cmd does
 * not treat as an escape — so it echoes a mangled path back and exits 0, which
 * is worse than failing.
 */
export function toShortPath(p: string): Promise<string | null> {
	if (process.platform !== "win32") return Promise.resolve(null);

	return new Promise((resolve) => {
		exec(
			`for %I in ("${p}") do @echo %~sI`,
			{ windowsHide: true, timeout: 15000 },
			(err, stdout) => {
				if (err) {
					resolve(null);
					return;
				}
				const resolved = (stdout ?? "").split(/\r?\n/)[0].trim();
				resolve(resolved.length > 0 ? resolved : null);
			}
		);
	});
}

async function tryCreateDir(dir: string): Promise<boolean> {
	try {
		await fs.promises.mkdir(dir, { recursive: true });
		// Confirm we can actually write, not just that mkdir succeeded.
		const probe = path.join(dir, ".write-probe");
		await fs.promises.writeFile(probe, "");
		await fs.promises.unlink(probe);
		return true;
	} catch {
		return false;
	}
}

/**
 * Create a staging directory that hhc.exe can compile in, preferring the
 * system temp dir and falling back to a drive-root folder when short names are
 * unavailable or the username itself contains a space.
 *
 * Returns both the real path (for our own fs operations) and the path to be
 * used as the compiler's working directory.
 */
export async function createStagingDir(): Promise<{
	realPath: string;
	compilerPath: string;
}> {
	const unique = `mdchm_${Date.now().toString(36)}_${Math.floor(
		Math.random() * 1e6
	).toString(36)}`;

	const candidates: string[] = [
		path.join(os.tmpdir(), unique),
		path.join("C:\\Windows\\Temp", unique),
		path.join("C:\\", unique),
	];

	for (const candidate of candidates) {
		if (!(await tryCreateDir(candidate))) continue;

		// The 8.3 form is tried first: a shorter path is friendlier to hhc.exe,
		// and it is the only way through when the real path contains a space.
		// Every candidate must be validated by hand — a failed short-name lookup
		// yields nothing usable, and a mangled result must never be mistaken for
		// a real path (which is how a bad working directory once reached hhc.exe
		// and surfaced as an unhelpful null exit code).
		const attempts = [await toShortPath(candidate), candidate];
		const usable = attempts.find(
			(a) => a !== null && isCompilerSafePath(a) && isDirectory(a)
		);
		if (!usable) continue;

		return { realPath: candidate, compilerPath: usable };
	}

	throw new Error(
		"Could not create a compiler-safe staging directory. hhc.exe cannot handle paths " +
			"containing spaces or folders beginning with a dot, and no fallback location " +
			"(system temp, C:\\Windows\\Temp, or C:\\) was usable."
	);
}

export async function removeDirRecursive(dir: string): Promise<void> {
	try {
		await fs.promises.rm(dir, { recursive: true, force: true });
	} catch {
		// Staging cleanup is best-effort; a locked file should not fail a build
		// that already produced a valid .chm.
	}
}

/** Write a file, creating parent directories as needed. */
export async function writeFileDeep(
	filePath: string,
	contents: string | Buffer
): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	await fs.promises.writeFile(filePath, contents);
}

export async function copyFileDeep(
	src: string,
	dest: string
): Promise<void> {
	await fs.promises.mkdir(path.dirname(dest), { recursive: true });
	await fs.promises.copyFile(src, dest);
}

export function fileExists(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

export function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export function fileSize(p: string): number {
	try {
		return fs.statSync(p).size;
	} catch {
		return 0;
	}
}

/** Render a byte count for display in the export dialog. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
