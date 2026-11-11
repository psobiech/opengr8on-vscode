import * as path from "node:path";
import { attachOmObjects, parseCluConfig } from "../../src/device/cluConfig";
import { parseOmObjects } from "../../src/project/omLuaObjects";
import { loadInterfaceRegistry } from "../../src/interfaces/registry";
import { copyInterfaces } from "../../scripts/copy-interfaces.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Synthetic CONFIG.JSON with the value shapes of a real CLU_ZWAVE_2 (serials made up).
const config = {
  sn: 100000013,
  mac: "aa:bb:cc:00:11:22",
  hwType: 19,
  hwVer: 1,
  fwType: 3,
  fwApiVer: 515,
  fwVer: "5.12.1-0000",
  status: "OK",
  tfbusDevices: [
    { sn: 330000009, hwType: 25, hwVer: 2, fwType: 2, fwApiVer: 1, fwVer: "1.2.13", status: "OK" },
    { sn: 330000010, hwType: 26, hwVer: 3, fwType: 2, fwApiVer: 2, fwVer: "2.2.4", status: "OK" },
    { sn: 330000011, hwType: 0x7f, hwVer: 1, fwType: 2, fwApiVer: 99, fwVer: "9.9.9", status: "ERR" },
  ],
  zwaveDevices: [{ sn: 3489660929, hwType: 0x8500030011, fwApiVer: 1, status: "OK" }],
};

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "og-cfg-"));
  copyInterfaces(path.join(__dirname, "../../lib/opengr8on-node/docs/device-interfaces"), dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("parseCluConfig", () => {
  it("resolves CLU type, modules and IOs with OM default names", () => {
    const v = parseCluConfig(JSON.stringify(config), loadInterfaceRegistry(dir));
    expect(v).toMatchObject({ serial: 100000013, typeName: "CLU_ZWAVE_2", fwVer: "5.12.1-0000", status: "OK" });
    expect(v.cluFeatures.find((f) => f.name === "TelnetLogLevel")?.enums.map((e) => e.name)).toEqual(["OFF", "ERROR", "WARNING", "INFO", "DEBUG"]);
    expect(v.modules.map((m) => [m.name, m.known, m.ios.length])).toEqual([
      ["ANALOG_DIN", true, 11],
      ["DIMMER_MOSFET_DIN", true, 1],
      [expect.stringMatching(/^unknown module \(hw 0x7f, fw 0x2 api 99\)$/), false, 0],
      ["ZWAVE_FAKRO_ARZ_ZWR", true, 2],
    ]);
    // Z-Wave device: objects from its interface XML (fwType 0), like a TF-Bus module
    const zw = v.modules.find((m) => m.bus === "zwave")!;
    expect(zw.ios.map((io) => [io.objectName, io.objectClass, io.channel, io.defaultName])).toEqual([
      ["ZWAVE_FAKRO", 65, 0, "x3489660929_ZWAVE_FAKRO_01"],
      ["ZWAVE_CONFIG", 64, 0, "x3489660929_ZWAVE_CONFIG_01"],
    ]);
    expect(zw.ios[0].features.find((f) => f.name === "State")?.get).toBe(true);
    expect(attachOmObjects(v, parseOmObjects('ZWA0001 = OBJECT:new(65, mm_3489660929, 0, "ZWA0001")\n-- NAME_IO OKNO=ZWA0001\n'))).toBe(1);
    expect(zw.ios[0]).toMatchObject({ objectId: "ZWA0001", name: "OKNO" });
    const analog = v.modules[0].ios;
    expect(analog[0]).toMatchObject({ label: "AnalogOUT_01", defaultName: "x330000009_AnalogOUT_01", objectName: "AnalogOUT", objectClass: 13, channel: 0 });
    expect(analog[0].features.some((f) => f.get)).toBe(true);
    expect(analog[0].methods.some((m) => m.call === "set" || m.call === "execute")).toBe(true);
    expect(analog[3]).toMatchObject({ label: "AnalogOUT_04", channel: 3 });
    expect(analog[4]).toMatchObject({ label: "AnalogIN_01", objectClass: 12, channel: 0 }); // per object type
    expect(v.modules[1].ios[0]).toMatchObject({ defaultName: "x330000010_DIMM_01", objectClass: 5, channel: 0 });
  });

  it("attaches OM.LUA object ids by module serial + class + channel", () => {
    const v = parseCluConfig(JSON.stringify(config), loadInterfaceRegistry(dir));
    const om = parseOmObjects(
      ' ANA0001 = OBJECT:new(13, mm_330000009, 3, "ANA0001")\r\n-- NAME_IO OUT4=ANA0001\r\n' +
        '--INACTIVE  DIM0001 = OBJECT:new(5, mm_330000010, 0, "DIM0001")\r\n',
    );
    expect(attachOmObjects(v, om)).toBe(2);
    expect(v.modules[0].ios[3]).toMatchObject({ label: "AnalogOUT_04", objectId: "ANA0001", name: "OUT4", inactive: false });
    expect(v.modules[1].ios[0]).toMatchObject({ objectId: "DIM0001", inactive: true });
    expect(v.modules[0].ios[0].objectId).toBeUndefined();
  });

  it("rejects malformed input by field name", () => {
    const r = loadInterfaceRegistry(dir);
    expect(() => parseCluConfig("{", r)).toThrow(/not valid JSON/);
    expect(() => parseCluConfig(JSON.stringify({ ...config, hwType: "x" }), r)).toThrow(/hwType is not a number/);
  });
});
