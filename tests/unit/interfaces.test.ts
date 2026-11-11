import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyInterfaces } from "../../scripts/copy-interfaces.mjs";
import { loadInterfaceRegistry } from "../../src/interfaces/registry";

const SOURCE = join(__dirname, "../../lib/opengr8on-node/docs/device-interfaces");

describe("interface XMLs", () => {
  let tmp: string;
  beforeEach(() => (tmp = mkdtempSync(join(tmpdir(), "og-ifaces-"))));
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("copies only clu/module/object XMLs and replaces stale files", () => {
    const dst = join(tmp, "out");
    copyInterfaces(SOURCE, dst);
    writeFileSync(join(dst, "stale.xml"), "x");
    const n = copyInterfaces(SOURCE, dst);
    const names = readdirSync(dst);
    expect(names).toHaveLength(n);
    expect(names.every((f) => /^(clu|module|object)_.*\.xml$/.test(f))).toBe(true);
    expect(names).not.toContain("sourceReceiver.xml");
  });

  it("fails on an empty source", () => {
    expect(() => copyInterfaces(tmp, join(tmp, "out"))).toThrow(/no interface XMLs/);
  });

  it("loads the copied set into InterfaceRegistry, cached per directory", () => {
    const dst = join(tmp, "out");
    copyInterfaces(SOURCE, dst);
    const reg = loadInterfaceRegistry(dst);
    expect(reg.cluCount).toBeGreaterThan(0);
    expect(reg.moduleCount).toBeGreaterThan(0);
    expect(reg.objectCount).toBeGreaterThan(0);
    expect(loadInterfaceRegistry(dst)).toBe(reg);
  });

  it("rejects a directory without interfaces", () => {
    expect(() => loadInterfaceRegistry(tmp)).toThrow(/no device interfaces/);
  });
});
