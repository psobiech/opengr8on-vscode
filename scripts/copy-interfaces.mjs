import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Interface XML files InterfaceRegistry loads (other files in the source dir are ignored). */
export const INTERFACE_FILE = /^(clu|module|object)_.*\.xml$/;

/**
 * Replaces `dst` with the interface XMLs from `src` (flat copy). Returns the number of files copied.
 * Used by esbuild.config.mjs to ship lib/opengr8on-node/docs/device-interfaces as dist/interfaces.
 */
export function copyInterfaces(src, dst) {
  const files = readdirSync(src, { withFileTypes: true }).filter((e) => e.isFile() && INTERFACE_FILE.test(e.name));
  if (files.length === 0) throw new Error(`no interface XMLs in ${src} (git submodule update --init?)`);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  for (const f of files) copyFileSync(join(src, f.name), join(dst, f.name));
  return files.length;
}
