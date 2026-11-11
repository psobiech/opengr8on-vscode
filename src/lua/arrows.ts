/**
 * OM script notation in Lua sources: `CLU_1->NAME->Member`, `CLU_1->Member`. This scanner finds
 * the references outside strings and comments; the resolver compiles them (docs/OM_LUA_FORMAT.md
 * "Object references in scripts").
 *
 *   CLU->OBJ->Method(args)    call
 *   CLU->OBJ->Feature         read
 *   CLU->OBJ->Feature = expr  assign (form in OM.LUA unknown: reported by the resolver)
 *   CLU->member(args) / CLU->member      CLU method / script / CLU feature
 *
 * The same references with dots (CLU_1.NAME.State) are found too; the resolver compiles them only
 * when the first part is a CLU of the project and leaves any other dotted Lua untouched.
 */

export interface ArrowRef {
  /** "->" (OM notation) or "." (same references in plain Lua syntax; compiled only when the first
   * part is a project CLU) */
  sep: "->" | ".";
  /** offsets of the whole construct in the source (incl. "(args)" / "= expr") */
  start: number;
  end: number;
  clu: string;
  object?: string;
  member: string;
  kind: "read" | "assign" | "call";
  /** call: raw text between the parentheses */
  args?: string;
  /** assign: right-hand side, trimmed */
  expr?: string;
  /** 0-based line / col of `start` */
  line: number;
  col: number;
}

const ARROW = /([A-Za-z_]\w*)(->|\.)([A-Za-z_]\w*)(?:\2([A-Za-z_]\w*))?/y;

/** Index after a Lua string / long bracket / comment starting at i, or -1 if none starts there. */
export function skipStringOrComment(src: string, i: number): number {
  const c = src[i];
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  if (c === "[") {
    const long = /^\[(=*)\[/.exec(src.slice(i, i + 64));
    if (long) {
      const close = src.indexOf(`]${long[1]}]`, i + long[0].length);
      return close < 0 ? src.length : close + long[1].length + 2;
    }
  }
  if (c === "-" && src[i + 1] === "-") {
    const lc = /^--\[(=*)\[/.exec(src.slice(i, i + 64));
    if (lc) {
      const close = src.indexOf(`]${lc[1]}]`, i + lc[0].length);
      return close < 0 ? src.length : close + lc[1].length + 2;
    }
    const nl = src.indexOf("\n", i);
    return nl < 0 ? src.length : nl;
  }
  return -1;
}

/** Offset of the ")" matching the "(" at `open` (strings respected), or -1. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const s = skipStringOrComment(src, i);
    if (s >= 0) {
      i = s - 1;
      continue;
    }
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** End of an assignment's expression: end of line, before a trailing comment / ";". */
function exprEnd(src: string, from: number): number {
  let i = from;
  while (i < src.length && src[i] !== "\n") {
    if (src.startsWith("--", i) || src[i] === ";") break;
    const s = skipStringOrComment(src, i);
    i = s >= 0 ? s : i + 1;
  }
  let end = i;
  while (end > from && /\s/.test(src[end - 1])) end--;
  return end;
}

export function findArrows(src: string): ArrowRef[] {
  const out: ArrowRef[] = [];
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);
  const pos = (off: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, col: off - lineStarts[lo] };
  };

  for (let i = 0; i < src.length; i++) {
    const s = skipStringOrComment(src, i);
    if (s >= 0) {
      i = s - 1;
      continue;
    }
    if (!/[A-Za-z_]/.test(src[i]) || (i > 0 && /[\w.:]/.test(src[i - 1]))) continue;
    ARROW.lastIndex = i;
    const m = ARROW.exec(src);
    if (!m) {
      while (i + 1 < src.length && /\w/.test(src[i + 1])) i++;
      continue;
    }
    const [, clu, sep, a, b] = m;
    const object = b === undefined ? undefined : a;
    const member = b ?? a;
    const nameEnd = i + m[0].length;
    let j = nameEnd;
    while (src[j] === " " || src[j] === "\t") j++;
    let ref: ArrowRef;
    if (src[j] === "(") {
      const close = matchParen(src, j);
      const end = close < 0 ? src.length : close + 1;
      ref = { sep: sep as ArrowRef["sep"], start: i, end, clu, object, member, kind: "call", args: src.slice(j + 1, end - 1), ...pos(i) };
    } else if (src[j] === "=" && src[j + 1] !== "=") {
      let k = j + 1;
      while (src[k] === " " || src[k] === "\t") k++;
      const e = exprEnd(src, k);
      ref = { sep: sep as ArrowRef["sep"], start: i, end: e, clu, object, member, kind: "assign", expr: src.slice(k, e), ...pos(i) };
    } else {
      ref = { sep: sep as ArrowRef["sep"], start: i, end: nameEnd, clu, object, member, kind: "read", ...pos(i) };
    }
    out.push(ref);
    i = ref.end - 1;
  }
  return out;
}

/** Replaces each ref by its compiled text (refs from findArrows, in order). */
export function replaceArrows(src: string, refs: ArrowRef[], compiled: string[]): string {
  let out = "";
  let last = 0;
  refs.forEach((r, k) => {
    out += src.slice(last, r.start) + compiled[k];
    last = r.end;
  });
  return out + src.slice(last);
}
