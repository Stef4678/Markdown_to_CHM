/**
 * Text handling for the CHM navigation pane.
 *
 * hhc.exe reads the .hhp/.hhc/.hhk project files using the system ANSI codepage,
 * and the compiled CHM viewer then renders the Contents and Index panes in that
 * same codepage. A `<meta charset>` in a sitemap is ignored, and a UTF-8 or
 * UTF-16 byte-order mark does not help either — all verified by compiling probe
 * CHMs and looking at the panes.
 *
 * So on a Windows-1252 system a heading such as "Growth & Learning → Continuous
 * Health Habits" reaches the pane as "Growth & Learning â†’ Continuous Health
 * Habits": the UTF-8 bytes for "→" read as three Windows-1252 characters. The
 * topic pane is unaffected because it is HTML, decoded by MSHTML, which does
 * honour a charset declaration.
 *
 * The upshot is that the navigation pane is a Windows-1252 surface. Text that
 * goes into it has to fit that codepage: fold what can reasonably be folded to
 * ASCII, drop the rest, and write the files as Windows-1252 bytes rather than
 * UTF-8 — otherwise even the characters Windows-1252 *can* hold ("é", "«»")
 * arrive double-encoded.
 */

/** Code points Windows-1252 stores in 0x80-0x9F, where ISO-8859-1 has none. */
const CP1252_BYTE = new Map<number, number>([
	[0x20ac, 0x80], // euro
	[0x201a, 0x82],
	[0x0192, 0x83],
	[0x201e, 0x84],
	[0x2026, 0x85], // ellipsis
	[0x2020, 0x86],
	[0x2021, 0x87],
	[0x02c6, 0x88],
	[0x2030, 0x89],
	[0x0160, 0x8a],
	[0x2039, 0x8b],
	[0x0152, 0x8c],
	[0x017d, 0x8e],
	[0x2018, 0x91], // left single quote
	[0x2019, 0x92], // right single quote
	[0x201c, 0x93], // left double quote
	[0x201d, 0x94], // right double quote
	[0x2022, 0x95], // bullet
	[0x2013, 0x96], // en dash
	[0x2014, 0x97], // em dash
	[0x02dc, 0x98],
	[0x2122, 0x99], // trademark
	[0x0161, 0x9a],
	[0x203a, 0x9b],
	[0x0153, 0x9c],
	[0x017e, 0x9e],
	[0x0178, 0x9f],
]);

/**
 * Readable ASCII for symbols Windows-1252 cannot hold. Only shapes with an
 * obvious plain-text equivalent are listed; anything else (emoji, pictographs,
 * CJK) is dropped, because a navigation entry reading "?" is worse than one
 * that simply omits the decoration.
 */
const FOLD = new Map<string, string>([
	// Arrows are the common case: "Step 1 → Step 2" should not lose its step
	// separator just because the pane cannot draw an arrow.
	["→", "->"],
	["←", "<-"],
	["↑", "^"],
	["↓", "v"],
	["↔", "<->"],
	["⇒", "=>"],
	["⇐", "<="],
	["⇔", "<=>"],
	["⟶", "->"],
	["➔", "->"],
	// Maths
	["≠", "!="],
	["≤", "<="],
	["≥", ">="],
	["≈", "~"],
	["∼", "~"],
	["−", "-"],
	["‐", "-"],
	["‑", "-"],
	// Exotic spaces: a heading that used one should still read as two words.
	[" ", " "],
	[" ", " "],
	[" ", " "],
	["​", ""],
	["﻿", ""],
	// Stars
	["★", "*"],
	["☆", "*"],
	["⭐", "*"],
]);

/** True when the codepage used by the navigation pane can hold this character. */
function isRepresentable(ch: string): boolean {
	const cp = ch.codePointAt(0);
	if (cp === undefined) return true;
	// ASCII, plus 0xA0-0xFF which Windows-1252 carries at the same code point.
	if (cp <= 0x7f) return true;
	if (cp >= 0xa0 && cp <= 0xff) return true;
	return CP1252_BYTE.has(cp);
}

/**
 * Rewrite text so every character survives the navigation pane. Returns the
 * input unchanged when it is already representable, so ordinary headings are
 * never reflowed.
 */
export function navSafe(text: string): string {
	let out = "";
	let dropped = false;

	for (const ch of text) {
		if (isRepresentable(ch)) {
			out += ch;
			continue;
		}
		dropped = true;
		const fold = FOLD.get(ch);
		if (fold !== undefined) out += fold;
	}

	if (!dropped) return text;
	// Removing a pictograph usually leaves a double space or a stray leading one.
	return out.replace(/[ \t]{2,}/g, " ").trim();
}

/** How many characters in this text the navigation pane cannot display. */
export function unsupportedCount(text: string): number {
	let count = 0;
	for (const ch of text) {
		if (!isRepresentable(ch)) count++;
	}
	return count;
}

/**
 * Encode text as Windows-1252 for an .hhp/.hhc/.hhk file. Characters outside
 * the codepage become "?", which should never happen for text that has been
 * through `navSafe`.
 */
export function encodeAnsi(text: string): Buffer {
	const bytes: number[] = [];

	for (const ch of text) {
		const cp = ch.codePointAt(0);
		if (cp === undefined) continue;
		if (cp <= 0x7f) {
			bytes.push(cp);
		} else if (cp >= 0xa0 && cp <= 0xff) {
			bytes.push(cp);
		} else {
			bytes.push(CP1252_BYTE.get(cp) ?? 0x3f);
		}
	}

	return Buffer.from(bytes);
}
