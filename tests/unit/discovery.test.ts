import { interfaceChoices, pickInterface, prefixLength, type LocalInterface } from "../../src/device/discovery";

const ifaces: LocalInterface[] = [
  { name: "eth0", address: "192.168.1.10", netmask: "255.255.255.0", mac: "aa:bb:cc:dd:ee:01" },
  { name: "wlan0", address: "10.0.0.5", netmask: "255.255.0.0", mac: "aa:bb:cc:dd:ee:02" },
];

describe("pickInterface", () => {
  it("defaults to the first interface", () => {
    expect(pickInterface("", ifaces).name).toBe("eth0");
  });

  it("matches by name or address", () => {
    expect(pickInterface("wlan0", ifaces).address).toBe("10.0.0.5");
    expect(pickInterface(" 10.0.0.5 ", ifaces).name).toBe("wlan0");
  });

  it("lists available interfaces when not found", () => {
    expect(() => pickInterface("eth9", ifaces)).toThrow(/eth9.*eth0 \(192\.168\.1\.10\)/);
    expect(() => pickInterface("", [])).toThrow(/no IPv4/);
  });
});

describe("interfaceChoices", () => {
  it("offers Automatic first, then interfaces stored by name", () => {
    const c = interfaceChoices("", ifaces);
    expect(c.map((x) => x.value)).toEqual(["", "eth0", "wlan0"]);
    expect(c[0]).toMatchObject({ label: "Automatic", picked: true, description: "first interface: eth0 (192.168.1.10)" });
    expect(c[2]).toMatchObject({ label: "wlan0", description: "10.0.0.5/16", detail: "broadcast 10.0.255.255, MAC aa:bb:cc:dd:ee:02" });
  });

  it("marks the configured interface by name or address", () => {
    expect(interfaceChoices("wlan0", ifaces).filter((x) => x.picked).map((x) => x.value)).toEqual(["wlan0"]);
    expect(interfaceChoices("192.168.1.10", ifaces).filter((x) => x.picked).map((x) => x.value)).toEqual(["eth0"]);
  });

  it("stores the address when one interface has several IPv4 addresses", () => {
    const multi: LocalInterface[] = [...ifaces, { name: "eth0", address: "172.16.0.2", netmask: "255.255.0.0", mac: "aa:bb:cc:dd:ee:01" }];
    const c = interfaceChoices("eth0", multi);
    expect(c.map((x) => x.value)).toEqual(["", "192.168.1.10", "wlan0", "172.16.0.2"]);
    expect(c.some((x) => x.picked)).toBe(false);
  });

  it("handles no interfaces", () => {
    expect(interfaceChoices("", [])).toEqual([expect.objectContaining({ value: "", description: "no IPv4 interface found" })]);
  });
});

describe("prefixLength", () => {
  it("counts netmask bits", () => {
    expect(prefixLength("255.255.255.0")).toBe(24);
    expect(prefixLength("255.255.240.0")).toBe(20);
    expect(prefixLength("0.0.0.0")).toBe(0);
  });
});
