import { InterfaceRegistry } from "opengr8on-node/client";

/** Path of the shipped interface XMLs, relative to the extension root (see esbuild.config.mjs). */
export const INTERFACES_DIR = "dist/interfaces";

const cache = new Map<string, InterfaceRegistry>();

/**
 * Loads (once per directory) the device interface XMLs: CLU / module / object class definitions
 * with feature, method and event indexes. Throws if the directory holds no CLU or module XMLs, so
 * a broken package fails loudly instead of resolving every name as unknown.
 */
export function loadInterfaceRegistry(dir: string): InterfaceRegistry {
  let registry = cache.get(dir);
  if (!registry) {
    registry = InterfaceRegistry.fromDirectory(dir);
    if (registry.cluCount === 0 || registry.moduleCount === 0) {
      throw new Error(`no device interfaces in ${dir} (clus=${registry.cluCount}, modules=${registry.moduleCount})`);
    }
    cache.set(dir, registry);
  }
  return registry;
}
