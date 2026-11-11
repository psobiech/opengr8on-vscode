import { readFileSync } from "node:fs";
import * as path from "node:path";

const fixture = (name: string) => readFileSync(path.join(__dirname, "..", "fixtures", name), "latin1");

// Sanitized real OM output (scripts/sanitize-om.mjs). Guards against accidental edits that would
// make them stop looking like what OM writes (editors normalising CRLF, trimming, re-encoding).
describe.each(["real-clu2.OM.LUA", "real-x.OM.LUA", "real-modbus.OM.LUA"])("%s", (name) => {
  const lua = fixture(name);

  it("is CRLF throughout and ends with one EOL", () => {
    expect(lua.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(lua.endsWith("\r\n")).toBe(true);
    expect(lua.endsWith("\r\n\r\n")).toBe(false);
  });

  it("keeps the OM section order", () => {
    const at = (s: string) => lua.indexOf(s);
    const order = ["-- FwType ", "--STORAGE\r\n", "-- setVar type support\r\n", "-- MODULES\r\n", "-- IO_MODULES\r\n", "function OnInit()\r\n"].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("has only sanitized CLU serials and no private LAN addresses", () => {
    for (const [, serial] of lua.matchAll(/\bCLU(\d{5,})\b/g)) expect(serial).toMatch(/^9000000\d\d$/);
    for (const [, ip] of lua.matchAll(/0x(C0A8[0-9A-F]{4})\b/g)) expect(ip).toMatch(/^C0A801[6-9A-F][0-9A-F]$/);
  });
});
