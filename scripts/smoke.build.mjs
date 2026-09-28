/*
 * Bundles scripts/smoke.ts into a runnable Node script, aliasing the
 * `obsidian` module to a stub so the pure logic can be tested headlessly.
 */
import esbuild from "esbuild";

await esbuild.build({
	entryPoints: ["scripts/smoke.ts"],
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "es2018",
	outfile: "scripts/smoke.cjs",
	logLevel: "warning",
	alias: {
		obsidian: "./scripts/obsidian-stub.mjs",
	},
});
