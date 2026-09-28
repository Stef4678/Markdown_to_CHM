import * as path from "path";
import { execFile } from "child_process";
import { fileExists, fileSize } from "../util/paths";
import { BuildLog } from "../util/log";

/**
 * Wrapper around Microsoft's hhc.exe (HTML Help Workshop).
 *
 * Two behaviours of hhc.exe shape everything here:
 *  - it can exit 0 after a failed compilation, so success is decided by the
 *    presence of the output artifact plus the absence of HHC error codes;
 *  - it cannot cope with spaces or dot-prefixed folders in paths, so it is
 *    always invoked with a bare project filename and a short working directory.
 */

const DEFAULT_INSTALL_DIRS = [
	"C:\\Program Files (x86)\\HTML Help Workshop\\hhc.exe",
	"C:\\Program Files\\HTML Help Workshop\\hhc.exe",
];

export interface CompileOutcome {
	success: boolean;
	chmPath: string;
	message: string;
}

interface RunResult {
	/** Process exit code, or null when it never exited (timeout, spawn error). */
	code: number | null;
	stdout: string;
	stderr: string;
	/** True when the process was killed because it exceeded the timeout. */
	timedOut: boolean;
	/** Spawn-level failure detail, e.g. "spawn hhc.exe ENOENT". */
	error: string | null;
}

function run(
	exe: string,
	args: string[],
	cwd?: string,
	timeout = 120000
): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(
			exe,
			args,
			{ cwd, windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 },
			(err, stdout, stderr) => {
				const failure = err as
					| (NodeJS.ErrnoException & { killed?: boolean; signal?: string })
					| null;

				const timedOut = Boolean(
					failure && failure.killed && failure.signal
				);

				// Exit codes arrive as numbers; spawn failures arrive as string
				// errno values such as "ENOENT", and only the latter carry a
				// message explaining what went wrong.
				const spawned = Boolean(
					failure && typeof failure.code !== "number"
				);

				resolve({
					code:
						failure && typeof failure.code === "number"
							? failure.code
							: failure
							? null
							: 0,
					stdout: stdout ?? "",
					stderr: stderr ?? "",
					timedOut,
					error: spawned
						? failure!.message ?? String(failure!.code ?? "")
						: null,
				});
			}
		);
	});
}

/**
 * Check the fixed install locations only. Synchronous, so dialog validation can
 * give an accurate answer before the PATH probe has finished.
 */
export function detectHhcSync(): string | null {
	if (process.platform !== "win32") return null;
	for (const candidate of DEFAULT_INSTALL_DIRS) {
		if (fileExists(candidate)) return candidate;
	}
	return null;
}

/** Locate hhc.exe on PATH or in the default install locations. */
export async function detectHhc(): Promise<string | null> {
	if (process.platform !== "win32") return null;

	// `where` is missing on some systems and finds nothing when hhc.exe is not
	// on PATH; either way we fall through to the fixed install locations.
	const res = await run("where", ["hhc.exe"], undefined, 10000);
	const first = res.stdout
		.split(/\r?\n/)
		.map((l) => l.trim())
		.find((l) => l.length > 0);

	if (first && fileExists(first)) return first;

	return detectHhcSync();
}

/**
 * Confirm the configured compiler actually runs. hhc.exe prints its usage text
 * when invoked without arguments, which is a side-effect-free way to check it.
 */
export async function testCompiler(
	hhcPath: string
): Promise<{ ok: boolean; message: string }> {
	if (!hhcPath) {
		return { ok: false, message: "No compiler path configured." };
	}
	if (!fileExists(hhcPath)) {
		return { ok: false, message: `Not found: ${hhcPath}` };
	}

	const res = await run(hhcPath, [], undefined, 10000);
	const combined = `${res.stdout}\n${res.stderr}`.trim();

	// A timeout means the binary launched but blocked (hhc.exe can open a window
	// instead of printing usage). The binary executing is what this asserts.
	if (res.timedOut) {
		return { ok: true, message: "Compiler launched but did not return." };
	}

	if (combined.length === 0 && res.code !== 0) {
		return {
			ok: false,
			message: `Compiler exited with code ${res.code} and produced no output.`,
		};
	}

	if (/hhc/i.test(combined) || /html help/i.test(combined)) {
		return { ok: true, message: "Compiler responded correctly." };
	}

	return { ok: true, message: "Compiler is runnable." };
}

export interface CompileRequest {
	hhcPath: string;
	/** Real staging path — used for our own filesystem checks. */
	stagingRealPath: string;
	/** Short, space-free staging path — used as the compiler's working directory. */
	stagingCompilerPath: string;
	/** Bare project filename, e.g. `project.hhp`. Never an absolute path. */
	projectFileName: string;
	/** Bare output filename expected inside the staging directory. */
	chmFileName: string;
}

/**
 * Compile a previously written .hhp. The caller is responsible for having
 * written the project and all of its referenced files into the staging dir.
 */
export async function compileProject(
	req: CompileRequest,
	log: BuildLog
): Promise<CompileOutcome> {
	const expectedChm = path.join(req.stagingRealPath, req.chmFileName);

	if (!fileExists(req.hhcPath)) {
		return {
			success: false,
			chmPath: expectedChm,
			message: `Compiler not found at ${req.hhcPath}`,
		};
	}

	log.info(`Running hhc.exe in ${req.stagingCompilerPath}`);

	const res = await run(
		req.hhcPath,
		[req.projectFileName],
		req.stagingCompilerPath
	);

	if (res.timedOut) {
		return {
			success: false,
			chmPath: expectedChm,
			message:
				"The compiler did not finish within two minutes and was stopped. " +
				"This usually means a dialog box opened and is waiting for input.",
		};
	}

	const combined = `${res.stdout}\n${res.stderr}`.trim();
	if (combined.length > 0) log.raw(combined);

	// hhc reports problems as HHC#### codes on stdout.
	const hhcErrors = combined
		.split(/\r?\n/)
		.filter((line) => /HHC\d+\s*:\s*Error/i.test(line));
	const hhcWarnings = combined
		.split(/\r?\n/)
		.filter((line) => /HHC\d+\s*:\s*Warning/i.test(line));

	for (const warning of hhcWarnings) log.warn(warning.trim());

	// Exit code alone is not trustworthy, so the artifact is the real signal.
	const produced = fileExists(expectedChm) && fileSize(expectedChm) > 0;

	if (!produced) {
		// A null exit code means the process never ran, so reporting one would
		// send the user looking for a build error that does not exist.
		if (res.code === null && !res.timedOut) {
			return {
				success: false,
				chmPath: expectedChm,
				message: `hhc.exe could not be started: ${
					res.error ?? "no further detail"
				}`,
			};
		}

		const detail =
			hhcErrors.length > 0
				? hhcErrors.map((l) => l.trim()).join("\n")
				: combined.length > 0
				? combined
				: `hhc.exe exited with code ${res.code} and produced no .chm file.`;
		return {
			success: false,
			chmPath: expectedChm,
			message: detail,
		};
	}

	if (hhcErrors.length > 0 && res.code !== 0) {
		return {
			success: false,
			chmPath: expectedChm,
			message: hhcErrors.map((l) => l.trim()).join("\n"),
		};
	}

	for (const err of hhcErrors) log.warn(err.trim());

	return {
		success: true,
		chmPath: expectedChm,
		message: "Compiled successfully.",
	};
}

/** Resolve a path for display, keeping it short enough for a settings row. */
export function shortenForDisplay(p: string, max = 60): string {
	if (p.length <= max) return p;
	return `…${p.slice(p.length - max + 1)}`;
}
