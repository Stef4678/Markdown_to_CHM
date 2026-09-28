export type LogLevel = "info" | "warn" | "error" | "success";

export interface LogEntry {
	level: LogLevel;
	message: string;
}

/**
 * Collects build output so the export dialog can show it after a run.
 * hhc.exe error text is cryptic, so we keep the raw lines verbatim.
 */
export class BuildLog {
	private entries: LogEntry[] = [];

	info(message: string): void {
		this.entries.push({ level: "info", message });
	}

	warn(message: string): void {
		this.entries.push({ level: "warn", message });
	}

	error(message: string): void {
		this.entries.push({ level: "error", message });
	}

	success(message: string): void {
		this.entries.push({ level: "success", message });
	}

	/** Append raw compiler output, preserving it exactly. */
	raw(text: string): void {
		for (const line of text.split(/\r?\n/)) {
			if (line.trim().length > 0) {
				this.entries.push({ level: "info", message: line });
			}
		}
	}

	get all(): LogEntry[] {
		return this.entries;
	}

	get hasErrors(): boolean {
		return this.entries.some((e) => e.level === "error");
	}

	get warnings(): string[] {
		return this.entries.filter((e) => e.level === "warn").map((e) => e.message);
	}

	toString(): string {
		return this.entries.map((e) => `[${e.level}] ${e.message}`).join("\n");
	}

	clear(): void {
		this.entries = [];
	}
}
