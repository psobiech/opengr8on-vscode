#!/usr/bin/env node
// Sanitizes real Object Manager output (OM.LUA / USER.LUA) into committable test fixtures.
//
//   node scripts/sanitize-om.mjs [--secrets keys.json] \
//     --om  <out>=<in> ...      OM.LUA files: full rewrite (also the source of the mapping)
//     --text <out>=<in> ...     any other file (USER.LUA, docs): token rewrite only
//     --check <file> ...        verify only (no rewrite), e.g. hand-written test fixtures
//
// One mapping is built from all --om inputs and applied everywhere, so cross references between
// CLUs (remote actions name other CLUs by serial) stay consistent:
//   CLU serials             -> 9000000NN
//   module serials          -> 0x1F0000NN (Z-Wave ids >= 2^31 -> 0xD00000NN); dec + hex8 forms
//   CLU IPs (0xC0A8xxxx)    -> 192.168.1.(100+N), hex and dotted forms
//   NAME_IO user names      -> IO_<objectId> (OM default names x<module>_<TYPE>_<nn> are kept,
//                              with the module serial mapped)
//   panel labels, CLU string features (NTP host, DNS IPs) -> placeholders
// Object ids (DIM1186, ...) are random per project and kept. Bytes are processed as latin1, so line
// endings and everything not mapped stay byte for byte.
//
// The mapping is never written anywhere. After writing, every output is checked: no original token
// may survive, no 16+ hex / 20+ base64 run may appear, and no value from --secrets (cipher keys,
// IVs, PIN) may appear in any form. Any hit deletes nothing but exits 1 with the file and kind
// (never the value).
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const om = [];
const text = [];
const check = [];
let secretsPath;
for (let i = 0, list = null; i < args.length; i++) {
  const a = args[i];
  if (a === "--om") list = om;
  else if (a === "--text") list = text;
  else if (a === "--check") list = check;
  else if (a === "--secrets") secretsPath = args[++i];
  else if (list === check) check.push(a);
  else if (list && a.includes("=")) {
    const [out, input] = a.split("=");
    list.push({ out, input });
  } else {
    console.error(`unexpected argument: ${a}`);
    process.exit(2);
  }
}
if (om.length === 0) {
  console.error("usage: sanitize-om.mjs [--secrets keys.json] --om out=in ... [--text out=in ...]");
  process.exit(2);
}

const read = (p) => readFileSync(p, "latin1");
const sources = new Map([...om, ...text].map((f) => [f, read(f.input)]));

// ---- collect -------------------------------------------------------------------------------------
const cluSerials = new Map(); // dec string -> new dec string
const moduleSerials = new Map(); // dec string -> new dec string
const moduleHex = new Map(); // hex8 -> new hex8
const ipHex = new Map(); // "C0A80191" -> "C0A80165"
const ipDotted = new Map(); // "192.168.1.145" -> "192.168.1.101"
const userNames = new Map(); // NAME_IO user name -> IO_<id>
const sensitiveStrings = new Set(); // label / feature values (checked after rewrite)

const hexToDotted = (h) => [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16)).join(".");
const hex8 = (n) => n.toString(16).padStart(8, "0");

for (const f of om) {
  const src = sources.get(f);
  const mapIp = (hex) => {
    if (ipHex.has(hex)) return;
    const n = 101 + ipHex.size;
    const h = `C0A801${n.toString(16).toUpperCase().padStart(2, "0")}`;
    ipHex.set(hex, h);
    ipDotted.set(hexToDotted(hex), hexToDotted(h));
  };
  // own CLU (class 0), remote CLUs (class 1), and a GATE's own line GATE:new(5000, ip, netmask, gateway, ...)
  const cluLines = [
    ...[...src.matchAll(/^CLU(\d+) = OBJECT:new\([01], 0x([0-9A-F]{8}), "CLU\1"\)/gm)].map((m) => [m[1], [m[2]]]),
    ...[...src.matchAll(/^CLU(\d+) = GATE:new\(\d+, 0x([0-9A-F]{8}), 0x[0-9A-F]{8}, 0x([0-9A-F]{8}),/gm)].map((m) => [m[1], [m[2], m[3]]]),
  ];
  for (const [serial, ips] of cluLines) {
    if (serial.length >= 5 && !cluSerials.has(serial)) cluSerials.set(serial, String(900000001 + cluSerials.size));
    for (const ip of ips) mapIp(ip);
  }
  for (const m of src.matchAll(/^mm_(\d+) = OBJECT:new\(2, 0x([0-9a-f]+), [^,]+, "([0-9a-f]{8})"\)/gm)) {
    const serial = Number(m[1]);
    if (hex8(serial) !== m[3] || serial.toString(16) !== m[2].replace(/^0+/, "")) {
      throw new Error(`${f.input}: module line serial/hex mismatch (format changed?)`);
    }
    if (moduleSerials.has(m[1])) continue;
    const n = moduleSerials.size + 1;
    const fake = serial >= 2 ** 31 ? 0xd0000000 + n : 0x1f000000 + n;
    moduleSerials.set(m[1], String(fake));
    moduleHex.set(m[3], hex8(fake));
  }
}
for (const f of om) {
  for (const m of sources.get(f).matchAll(/^-- NAME_IO (.+)=([A-Z]{3}\d+)\r?$/gm)) {
    const def = /^x(\d+)_[A-Za-z0-9]+_\d+$/.exec(m[1]);
    if (def && moduleSerials.has(def[1])) continue;
    if (!userNames.has(m[1])) userNames.set(m[1], `IO_${m[2]}`);
  }
}

// ---- rewrite -------------------------------------------------------------------------------------
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const serials = new Map([...cluSerials, ...moduleSerials]);

function rewriteTokens(s) {
  s = s.replace(/(?<![0-9])\d{9,10}(?![0-9])/g, (d) => serials.get(d) ?? d);
  s = s.replace(/(?<![0-9a-fA-F])[0-9a-f]{8}(?![0-9a-fA-F])/g, (h) => moduleHex.get(h) ?? h);
  s = s.replace(/0x(C0A8[0-9A-F]{4})(?![0-9A-Fa-f])/g, (all, h) => (ipHex.has(h) ? `0x${ipHex.get(h)}` : all));
  s = s.replace(/(?<![0-9.])\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![0-9.])/g, (ip) => ipDotted.get(ip) ?? ip);
  // longest first, so a name never matches inside a longer one
  for (const name of [...userNames.keys()].sort((a, b) => b.length - a.length)) {
    s = s.replace(new RegExp(`(?<![A-Za-z0-9_])${reEscape(name)}(?![A-Za-z0-9_])`, "g"), userNames.get(name));
  }
  return s;
}

function rewriteOm(src) {
  let label = 0;
  let feature = 0;
  src = src.replace(/^(-- NAME_IO )(.+)(=[A-Z]{3}\d+\r?)$/gm, (all, p, name, rest) =>
    userNames.has(name) ? `${p}${userNames.get(name)}${rest}` : all,
  );
  src = src.replace(/^(PAN\d+:set\(\d+, ")([^"]+)("\))/gm, (_all, p, v, e) => {
    sensitiveStrings.add(v);
    return `${p}L${++label}${e}`;
  });
  src = src.replace(/^(CLU\w+:set\(\d+, ")([^"]+)("\))/gm, (_all, p, v, e) => {
    sensitiveStrings.add(v);
    feature++;
    return `${p}${/^\d+\.\d+\.\d+\.\d+$/.test(v) ? `192.0.2.${feature}` : `host${feature}.example`}${e}`;
  });
  return rewriteTokens(src);
}

const outputs = new Map();
for (const f of om) outputs.set(f.out, rewriteOm(sources.get(f)));
for (const f of text) outputs.set(f.out, rewriteTokens(sources.get(f)));

// ---- verify --------------------------------------------------------------------------------------
const secrets = [];
if (secretsPath) {
  const walk = (o) => {
    for (const v of Object.values(o)) {
      if (v && typeof v === "object") walk(v);
      else if (typeof v === "string" && v.length >= 6) {
        secrets.push(v);
        const buf = Buffer.from(v, "base64");
        if (buf.length >= 8 && buf.toString("base64") === v) secrets.push(buf.toString("hex"), buf.toString("hex").toUpperCase());
      }
    }
  };
  walk(JSON.parse(readFileSync(secretsPath, "utf8")));
}
const checks = [
  ...[...serials.keys()].map((v) => ["serial", new RegExp(`(?<![0-9])${v}(?![0-9])`)]),
  ...[...moduleHex.keys()].map((v) => ["module hex", new RegExp(`(?<![0-9a-fA-F])${v}(?![0-9a-fA-F])`, "i")]),
  ...[...ipHex.keys()].map((v) => ["ip hex", new RegExp(`0x${v}(?![0-9A-Fa-f])`, "i")]),
  ...[...ipDotted.keys()].map((v) => ["ip", new RegExp(`(?<![0-9.])${reEscape(v)}(?![0-9.])`)]),
  ...[...userNames.keys()].map((v) => ["NAME_IO name", new RegExp(`(?<![A-Za-z0-9_])${reEscape(v)}(?![A-Za-z0-9_])`)]),
  ...[...sensitiveStrings].filter((v) => v.length >= 5).map((v) => ["string value", new RegExp(`"${reEscape(v)}"`)]),
  ...secrets.map((v) => ["secret", new RegExp(reEscape(v), "i")]),
];
// 16+ hex run that looks like key material (random: at least 4 distinct digits; a schedule bitmap
// like 000000... is not)
const hexLike = (content) => [...content.matchAll(/[0-9A-Fa-f]{16,}/g)].find((m) => new Set(m[0].toLowerCase()).size >= 4);
// 20+ base64 run that looks like key material (digit + upper + lower, not a path)
const base64Like = (content) =>
  [...content.matchAll(/[A-Za-z0-9+/]{20,}={0,2}/g)].find(
    (m) => (m[0].match(/\d/g) ?? []).length >= 2 && /[A-Z]/.test(m[0]) && /[a-z]/.test(m[0]) && (m[0].match(/\//g) ?? []).length <= 2,
  );
let failed = false;
const verify = (name, content) => {
  const hits = checks.map(([kind, re]) => [kind, re.exec(content)]);
  hits.push(["16+ hex run", hexLike(content)]);
  hits.push(["20+ base64 run", base64Like(content)]);
  for (const [kind, m] of hits) {
    if (!m) continue;
    console.error(`LEAK ${name}:${content.slice(0, m.index).split("\n").length}: ${kind}`);
    failed = true;
  }
};
for (const [out, content] of outputs) verify(out, content);
for (const f of check) verify(f, read(f));
if (failed) process.exit(1);

for (const [out, content] of outputs) writeFileSync(out, content, "latin1");
console.log(
  `sanitized ${outputs.size} files: ${cluSerials.size} CLU serials, ${moduleSerials.size} modules, ` +
    `${ipHex.size} IPs, ${userNames.size} IO names, ${sensitiveStrings.size} string values; ` +
    `checked against ${secrets.length} secret forms`,
);
