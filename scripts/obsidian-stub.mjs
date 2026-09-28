/*
 * Minimal stand-in for the `obsidian` module so the pure string/project-file
 * logic can be exercised under plain Node, without an Obsidian runtime.
 * Only the names the modules under test import need to exist.
 */

export class App {}
export class Component {}
export class TFile {}
export class TFolder {}
export class Modal {}
export class Notice {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class FileSystemAdapter {}
export function setIcon() {}
export function normalizePath(p) {
	return p;
}

export const MarkdownRenderer = {
	render: async () => undefined,
	renderMarkdown: async () => undefined,
};
