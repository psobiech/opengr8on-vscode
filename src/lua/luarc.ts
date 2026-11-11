/** Merges the stub library into a .luarc.json (LuaLS config), keeping everything else. Pure. */
export const STUB_DIR = ".opengr8on/luals";
export const PLUGIN_FILE = `${STUB_DIR}/plugin.lua`;

export function mergeLuarc(existing: string | undefined): { text: string; changed: boolean } {
  let cfg: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim()) {
    try {
      cfg = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      throw new Error(".luarc.json is not valid JSON (comments are not supported here); add \"workspace.library\": [\".opengr8on/luals\"] yourself");
    }
  }
  // LuaLS accepts both the flat ("workspace.library") and the nested ({ workspace: { library } }) form.
  const nested = cfg.workspace && typeof cfg.workspace === "object" ? (cfg.workspace as Record<string, unknown>) : undefined;
  const lib = (cfg["workspace.library"] ?? nested?.library ?? []) as unknown;
  const list = Array.isArray(lib) ? (lib as unknown[]) : [];
  const hasPlugin = cfg["runtime.plugin"] !== undefined || (cfg.runtime as Record<string, unknown> | undefined)?.plugin !== undefined;
  const diag = cfg.diagnostics && typeof cfg.diagnostics === "object" ? (cfg.diagnostics as Record<string, unknown>) : undefined;
  const hasIgnoredFiles = cfg["diagnostics.ignoredFiles"] !== undefined || diag?.ignoredFiles !== undefined;
  if (list.includes(STUB_DIR) && hasPlugin && cfg["workspace.ignoreDir"] !== undefined && hasIgnoredFiles) return { text: existing ?? "", changed: false };
  if (!list.includes(STUB_DIR)) {
    if (nested && "library" in nested) nested.library = [...list, STUB_DIR];
    else cfg["workspace.library"] = [...list, STUB_DIR];
  }
  // OM script notation (CLU->OBJECT->Member) is read by LuaLS through this plugin; an existing
  // plugin setting is left alone.
  if (!hasPlugin) cfg["runtime.plugin"] = PLUGIN_FILE;
  // generated OM.LUA / USER.LUA (build/) are not edited: keep them out of LuaLS diagnostics
  const ignore = cfg["workspace.ignoreDir"];
  if (ignore === undefined) cfg["workspace.ignoreDir"] = ["build"];
  // LuaLS still diagnoses an ignored file once it is opened (default "Opened"): OM's own code is
  // not ours to fix and must stay byte-exact, so no `---@diagnostic` line can go into it
  if (!hasIgnoredFiles) cfg["diagnostics.ignoredFiles"] = "Disable";
  if (!("$schema" in cfg)) cfg = { $schema: "https://raw.githubusercontent.com/LuaLS/vscode-lua/master/setting/schema.json", ...cfg };
  return { text: JSON.stringify(cfg, null, 2) + "\n", changed: true };
}
