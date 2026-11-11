import esbuild from "esbuild";
import { copyInterfaces } from "./scripts/copy-interfaces.mjs";

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  // opengr8on-node is a git submodule (lib/opengr8on-node); bundle its TypeScript source through the
  // client-only entry, which never reaches tfbus/vclu (serialport, wasmoon, mqtt).
  alias: { "opengr8on-node/client": "./lib/opengr8on-node/src/client-entry.ts" },
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  logLevel: "info",
  treeShaking: true,
};

// Device interface XMLs (CLU / module / object classes) ship next to the bundle; loaded at runtime
// by src/interfaces/registry.ts via InterfaceRegistry.fromDirectory.
const copied = copyInterfaces("lib/opengr8on-node/docs/device-interfaces", "dist/interfaces");
console.log(`interfaces: ${copied} XMLs -> dist/interfaces`);

if (watch) {
  const ctx = await esbuild.context(config);
  await ctx.watch();
} else {
  await esbuild.build(config);
}
