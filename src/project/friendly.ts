/**
 * Compiled action line (OM.LUA) → OM action grammar with friendly names, for import. Only returns a
 * friendly form when compiling it back (same rules as resolve.ts) gives the identical line;
 * otherwise undefined (the caller keeps `{ lua: ... }`).
 */
import type { ProjectIndex } from "./assist";
import { splitArgs } from "./resolve";

const unescapeLua = (s: string) => s.replace(/\\(.)/g, "$1");
const escapeLua = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Friendly form of a line that runs on `cluName` (local), or undefined. */
function local(index: ProjectIndex, cluName: string, line: string, allowScript = true): string | undefined {
  const clu = index.get(cluName);
  if (!clu) return undefined;
  const script = /^([A-Za-z_]\w*)\(nil\)$/.exec(line);
  if (script) return allowScript && clu.clu.scripts.some((s) => s.name === script[1]) ? `${cluName}->${script[1]}()` : undefined;
  const m = /^([A-Za-z_]\w*):(execute|set)\((\d+)(?:, (.*))?\)$/.exec(line);
  if (!m) return undefined;
  const [, objId, call, indexText, argText] = m;
  const o = clu.byId.get(objId);
  const method = o?.iface?.methods.find((x) => x.call === call && x.index === Number(indexText));
  if (!o || !method || o.kind === "remote") return undefined;
  const args = argText === undefined ? [] : splitArgs(argText);
  if (args.length > method.params.length) return undefined;
  if (`${o.id}:${call}(${[indexText, ...args].join(", ")})` !== line) return undefined; // spacing etc. must round-trip
  if (o.kind === "clu") {
    if (clu.clu.scripts.some((s) => s.name === method.name)) return undefined; // a script would win in resolve
    return `${cluName}->${method.name}(${args.join(", ")})`;
  }
  // the name must resolve back to this object (resolve looks names up before ids)
  const ref = clu.byName.get(o.name) === o ? o.name : clu.byName.has(o.id) ? undefined : o.id;
  return ref ? `${cluName}->${ref}->${method.name}(${args.join(", ")})` : undefined;
}

export function friendlyAction(index: ProjectIndex, cluName: string, line: string): string | undefined {
  const remote = /^(CLU\d+):execute\(0, "((?:[^"\\]|\\.)*)"\)$/.exec(line);
  if (remote) {
    const self = index.get(cluName);
    const target = [...index.values()].find((c) => c.clu.id === remote[1]);
    if (!self || !target || target === self || !self.clu.remotes.some((r) => r.id === remote[1])) return undefined;
    const inner = unescapeLua(remote[2]);
    if (`${remote[1]}:execute(0, "${escapeLua(inner)}")` !== line) return undefined;
    return local(index, target.clu.name, inner, false); // remote script calls are not supported by resolve
  }
  return local(index, cluName, line);
}
