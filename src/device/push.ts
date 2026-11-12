/**
 * Live values pushed by the CLU (`SYSTEM:clientRegister`), confirmed on a real CLU (fw 5.15):
 *
 *   req  SYSTEM:clientRegister("<our ip>",<port>,<id>,{{CLU900000001,0},{CLU900000001,6}})
 *   resp clientReport:<id>:{34472,"08:19:12"}                       snapshot (the req: answer)
 *   then on every change, from the CLU's port 1234, encrypted with the CLU's key:
 *        resp:0.0.0.0:00000000:clientReport:<id>:{34473,"08:19:12"}
 *   req  SYSTEM:clientDestroy("<our ip>",<port>,<id>)  ->  <id>
 *
 * Pure helpers; the UDP socket is in pushReceiver.ts.
 */
import type { FeatureRead } from "./liveValues";

const ID = /^[A-Za-z_]\w*$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function check(local: string, port: number, id: number): void {
  if (!IPV4.test(local)) throw new Error(`invalid local address: ${local}`);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid port: ${port}`);
  if (!Number.isInteger(id) || id < 0) throw new Error(`invalid subscription id: ${id}`);
}

export function registerExpression(local: string, port: number, id: number, reads: FeatureRead[]): string {
  check(local, port, id);
  if (reads.length === 0) throw new Error("nothing to subscribe");
  const list = reads.map((r) => {
    if (!ID.test(r.id)) throw new Error(`invalid object id: ${r.id}`);
    return `{${r.id},${Math.trunc(r.index)}}`;
  });
  return `SYSTEM:clientRegister("${local}",${port},${id},{${list.join(",")}})`;
}

export function destroyExpression(local: string, port: number, id: number): string {
  check(local, port, id);
  return `SYSTEM:clientDestroy("${local}",${port},${id})`;
}

/**
 * `clientReport:<id>:{v1,v2,...}` (with or without the `resp:<ip>:<session>:` header) → id and the
 * values as Lua's tostring would print them (strings unquoted, nil as "nil"). Undefined if it is not
 * a client report or the value list cannot be read. A bare string containing a comma splits into
 * several values; the value count check of the caller catches that (→ polling).
 */
export function parseClientReport(text: string): { id: number; values: string[] } | undefined {
  const m = /clientReport:(\d+):\{([\s\S]*)\}\s*$/.exec(text);
  if (!m) return undefined;
  const values = parseLuaList(m[2]);
  return values ? { id: Number(m[1]), values } : undefined;
}

/** Comma-separated values: numbers, "strings" (with escapes) or bare strings, true / false / nil. */
function parseLuaList(src: string): string[] | undefined {
  const out: string[] = [];
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  ws();
  if (i >= src.length) return out;
  for (;;) {
    ws();
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i++];
      let s = "";
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") {
          const c = src[i + 1];
          s += c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c;
          i += 2;
        } else s += src[i++];
      }
      if (src[i] !== q) return undefined;
      i++;
      out.push(s);
    } else {
      // numbers, true / false / nil, and strings: the CLU sends string features unquoted
      // (observed fw 5.15: {2115923,nil,1,2026-11-12,13:19:54,...}); such a value ends at the next comma
      const m = /^[^,]*/.exec(src.slice(i))!;
      const v = m[0].trim();
      if (!v) return undefined;
      out.push(v);
      i += m[0].length;
    }
    ws();
    if (i >= src.length) return out;
    if (src[i] !== ",") return undefined;
    i++;
  }
}
