import { describe, expect, it } from "vitest";
import { LivePoller } from "../../src/device/liveValues";
import { destroyExpression, parseClientReport, registerExpression } from "../../src/device/push";

describe("push protocol (as a real CLU answered)", () => {
  it("builds clientRegister / clientDestroy", () => {
    expect(registerExpression("10.0.0.5", 4344, 7, [{ id: "CLU1", index: 0 }, { id: "DOU1001", index: 6 }])).toBe(
      'SYSTEM:clientRegister("10.0.0.5",4344,7,{{CLU1,0},{DOU1001,6}})',
    );
    expect(destroyExpression("10.0.0.5", 4344, 7)).toBe('SYSTEM:clientDestroy("10.0.0.5",4344,7)');
    expect(() => registerExpression("x", 1, 1, [{ id: "A", index: 0 }])).toThrow("invalid local address");
    expect(() => registerExpression("10.0.0.5", 1, 1, [{ id: "A)", index: 0 }])).toThrow("invalid object id");
  });

  it("parses snapshots and pushed reports like tostring would print them", () => {
    expect(parseClientReport('clientReport:4242:{34472,"08:19:12"}')).toEqual({ id: 4242, values: ["34472", "08:19:12"] });
    expect(parseClientReport('resp:0.0.0.0:00000000:clientReport:4242:{34473,"08:19:12"}')).toEqual({ id: 4242, values: ["34473", "08:19:12"] });
    expect(parseClientReport('clientReport:1:{true,nil,-0.5,"a\\"b,c"}')).toEqual({ id: 1, values: ["true", "nil", "-0.5", 'a"b,c'] });
    expect(parseClientReport("clientReport:1:{}")).toEqual({ id: 1, values: [] });
    expect(parseClientReport("resp:OK")).toBeUndefined();
    expect(parseClientReport("clientReport:1:{1,,2}")).toBeUndefined();
  });
});

/** Fake CLU 5: answers clientRegister with a snapshot (values = index * 10) and clientDestroy. */
function fakeClu(opts: { register?: (script: string) => string } = {}) {
  const scripts: string[] = [];
  const exec = async (_serial: number, script: string) => {
    scripts.push(script);
    const reg = /^SYSTEM:clientRegister\("[\d.]+",\d+,(\d+),\{(.*)\}\)$/.exec(script);
    if (reg) {
      if (opts.register) return opts.register(script);
      const idx = [...reg[2].matchAll(/\{\w+,(\d+)\}/g)].map((m) => String(Number(m[1]) * 10));
      return `clientReport:${reg[1]}:{${idx.join(",")}}`;
    }
    const d = /^SYSTEM:clientDestroy\("[\d.]+",\d+,(\d+)\)$/.exec(script);
    if (d) return d[1];
    // polling
    return script.split("tostring(").slice(1).map(() => "P").join("\x1f");
  };
  return { scripts, exec };
}

describe("LivePoller with push", () => {
  const target = { port: () => 5555, localFor: () => "10.0.0.9" };

  it("subscribes (snapshot = first values, CLU Uptime as heartbeat), applies pushes, re-registers, ends on unwatch", async () => {
    let t = 0;
    const clu = fakeClu();
    let changes = 0;
    const p = new LivePoller(clu.exec, () => changes++, 60_000, target, () => {}, () => t);
    p.watch(5, "io", [{ id: "DOU1001", index: 0 }, { id: "DOU1001", index: 2 }]);
    await p.tick();
    p.stop();
    const reg = clu.scripts.find((s) => s.startsWith("SYSTEM:clientRegister"))!;
    expect(reg).toMatch(/\{\{CLU5,0\},\{DOU1001,0\},\{DOU1001,2\}\}\)$/);
    const id = Number(/,(\d+),\{/.exec(reg)![1]);
    expect(p.value(5, { id: "DOU1001", index: 2 })).toBe("20");
    expect(p.mode(5)).toEqual({ mode: "push" });
    expect(clu.scripts.some((s) => s.includes(":get("))).toBe(false); // no polling

    const before = changes;
    expect(p.applyPush(`resp:0.0.0.0:00000000:clientReport:${id}:{1,1,7}`)).toBe(true);
    expect(p.value(5, { id: "DOU1001", index: 2 })).toBe("7");
    expect(changes).toBe(before + 1);
    expect(p.applyPush("resp:0.0.0.0:00000000:clientReport:999999999:{1}")).toBe(false); // not ours

    clu.scripts.length = 0;
    t = 10_000;
    await p.tick(); // within the re-register period, heartbeat seen: nothing sent
    expect(clu.scripts).toEqual([]);
    t = 40_000;
    await p.tick(); // re-register, same id
    expect(clu.scripts).toEqual([expect.stringContaining(`,${id},{{CLU5,0}`)]);

    p.unwatch(5, "io");
    await Promise.resolve();
    expect(clu.scripts.at(-1)).toBe(`SYSTEM:clientDestroy("10.0.0.9",5555,${id})`);
    expect(p.mode(5).mode).toBe("poll");
  });

  it("falls back to polling when no push arrives (blocked UDP) or clientRegister is not supported", async () => {
    let t = 0;
    const clu = fakeClu();
    const logs: string[] = [];
    const p = new LivePoller(clu.exec, () => {}, 60_000, target, (l) => logs.push(l), () => t);
    p.watch(5, "io", [{ id: "DOU1001", index: 0 }]);
    await p.tick();
    p.stop();
    t = 6_000; // no push since registering
    await p.tick();
    expect(p.mode(5)).toEqual({ mode: "poll", reason: expect.stringContaining("no push") });
    expect(clu.scripts.some((s) => s.startsWith("SYSTEM:clientDestroy"))).toBe(true);
    expect(p.value(5, { id: "DOU1001", index: 0 })).toBe("P"); // polled in the same tick
    expect(logs[0]).toMatch(/polling instead/);

    const old = fakeClu({ register: () => "nil" });
    const q = new LivePoller(old.exec, () => {}, 60_000, target, () => {}, () => 0);
    q.watch(7, "io", [{ id: "DOU1001", index: 0 }]);
    await q.tick();
    q.stop();
    expect(q.mode(7)).toEqual({ mode: "poll", reason: expect.stringContaining("not supported") });
    expect(q.value(7, { id: "DOU1001", index: 0 })).toBe("P");
  });

  it("without a push target it only polls", async () => {
    const clu = fakeClu();
    const p = new LivePoller(clu.exec, () => {}, 60_000);
    p.watch(5, "io", [{ id: "DOU1001", index: 0 }]);
    await p.tick();
    p.stop();
    expect(clu.scripts.every((s) => s.includes(":get("))).toBe(true);
  });
});
