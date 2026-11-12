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
    // fw 5.15: string features (Date, Time) come unquoted
    expect(parseClientReport("clientReport:268581:{2115923,nil,1,2026-11-12,13:19:54,12}")).toEqual({
      id: 268581,
      values: ["2115923", "nil", "1", "2026-11-12", "13:19:54", "12"],
    });
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
    // one subscription per object: the CLU (Uptime = heartbeat), then DOU1001
    const regs = clu.scripts.filter((s) => s.startsWith("SYSTEM:clientRegister"));
    expect(regs).toEqual([expect.stringMatching(/,\{\{CLU5,0\}\}\)$/), expect.stringMatching(/,\{\{DOU1001,0\},\{DOU1001,2\}\}\)$/)]);
    const [hb, id] = regs.map((r) => Number(/,(\d+),\{/.exec(r)![1]));
    expect(p.value(5, { id: "DOU1001", index: 2 })).toBe("20");
    expect(p.mode(5)).toEqual({ mode: "push" });
    expect(clu.scripts.some((s) => s.includes(":get("))).toBe(false); // no polling

    const before = changes;
    expect(p.applyPush(`resp:0.0.0.0:00000000:clientReport:${id}:{1,7}`)).toBe(true);
    expect(p.value(5, { id: "DOU1001", index: 2 })).toBe("7");
    expect(changes).toBe(before + 1);
    expect(p.applyPush("resp:0.0.0.0:00000000:clientReport:999999999:{1}")).toBe(false); // not ours

    clu.scripts.length = 0;
    t = 10_000;
    p.applyPush(`clientReport:${hb}:{2}`); // heartbeat
    await p.tick(); // within the re-register period, heartbeat seen: nothing sent
    expect(clu.scripts).toEqual([]);
    t = 40_000;
    p.applyPush(`clientReport:${hb}:{3}`);
    await p.tick(); // re-register, same ids
    expect(clu.scripts).toEqual([expect.stringContaining(`,${hb},{{CLU5,0}}`), expect.stringContaining(`,${id},{{DOU1001,0}`)]);

    p.unwatch(5, "io");
    await Promise.resolve();
    expect(clu.scripts.slice(-2)).toEqual([`SYSTEM:clientDestroy("10.0.0.9",5555,${hb})`, `SYSTEM:clientDestroy("10.0.0.9",5555,${id})`]);
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

describe("LivePoller contact", () => {
  const target = { port: () => 5555, localFor: () => "10.0.0.9" };

  it("registers again when pushes stop; a CLU that does not answer is reported lost", async () => {
    let t = 0;
    let down = false;
    const clu = fakeClu();
    const exec = (serial: number, script: string) => (down ? Promise.reject(new Error("no answer")) : clu.exec(serial, script));
    const contacts: Array<[number, boolean]> = [];
    const logs: string[] = [];
    const p = new LivePoller(exec, () => {}, 60_000, target, (l) => logs.push(l), () => t);
    p.onContact = (serial, ok) => contacts.push([serial, ok]);
    p.watch(5, "module", [{ id: "DOU1001", index: 0 }]);
    await p.tick();
    p.stop();
    const id = Number(/,(\d+),\{/.exec(clu.scripts.find((s) => s.startsWith("SYSTEM:clientRegister"))!)![1]);
    t = 1_000;
    p.applyPush(`clientReport:${id}:{2}`); // heartbeat (first subscription: CLU5 Uptime)
    expect(contacts).toEqual([[5, true]]);

    // CLU restarted: forgot the subscription, answers the new register
    clu.scripts.length = 0;
    t = 7_000;
    await p.tick();
    expect(logs.at(-1)).toMatch(/no push for 6 s, registering again/);
    const again = clu.scripts.filter((s) => s.startsWith("SYSTEM:clientRegister"));
    expect(again).toEqual([expect.stringMatching(/\{\{CLU5,0\}\}\)$/), expect.stringMatching(/\{\{DOU1001,0\}\}\)$/)]);
    const id2 = Number(/,(\d+),\{/.exec(again[0])![1]);
    t = 8_000;
    p.applyPush(`clientReport:${id2}:{1}`);

    // CLU gone: re-register fails twice → lost
    down = true;
    t = 14_000;
    await p.tick();
    expect(contacts.at(-1)).toEqual([5, true]);
    t = 16_000;
    await p.tick();
    expect(contacts.at(-1)).toEqual([5, false]);
    expect(p.error(5)).toBe("no answer");
    p.dispose();
  });

  it("watch is idempotent (re-renders send nothing); collapsing a CLU unwatches its modules only", async () => {
    const clu = fakeClu();
    const p = new LivePoller(clu.exec, () => {}, 60_000, target, () => {}, () => 0);
    p.watch(1, "clu:1:mm:7", [{ id: "DOU1001", index: 0 }]);
    p.watch(12, "clu:12:mm:8", [{ id: "DOU2001", index: 0 }]);
    await p.tick();
    await p.tick(); // the second watch joined the running tick
    const sent = clu.scripts.length;
    p.watch(1, "clu:1:mm:7", [{ id: "DOU1001", index: 0 }]);
    await p.tick();
    expect(clu.scripts.length).toBe(sent);
    p.unwatchPrefix(1, "clu:1:");
    await Promise.resolve();
    expect(clu.scripts.at(-1)).toMatch(/^SYSTEM:clientDestroy/);
    expect(p.mode(1).mode).toBe("poll");
    expect(p.mode(12).mode).toBe("push"); // clu:12 does not start with clu:1:
    p.dispose();
  });

  it("logs a push it cannot apply once, and keeps the other objects' values", async () => {
    const clu = fakeClu();
    const logs: string[] = [];
    const p = new LivePoller(clu.exec, () => {}, 60_000, target, (l) => logs.push(l), () => 0);
    p.watch(5, "m", [{ id: "TIM1", index: 3 }, { id: "HTTP1", index: 0 }, { id: "HTTP1", index: 1 }]);
    await p.tick();
    p.stop();
    const ids = Object.fromEntries(clu.scripts.filter((s) => s.startsWith("SYSTEM:clientRegister")).map((r) => [/\{\{(\w+),/.exec(r)![1], Number(/,(\d+),\{/.exec(r)![1])]));
    p.applyPush(`clientReport:${ids.HTTP1}:{a,b,c}`); // unquoted string with a comma
    p.applyPush(`clientReport:${ids.HTTP1}:{a,b,c}`);
    p.applyPush(`clientReport:${ids.TIM1}:{1500}`);
    expect(p.value(5, { id: "TIM1", index: 3 })).toBe("1500");
    expect(logs.filter((l) => l.includes("3 values for 2 reads"))).toHaveLength(1);
    p.dispose();
  });

  it("subscriptions change incrementally: a second module does not touch the first one's", async () => {
    let t = 0;
    const clu = fakeClu();
    const p = new LivePoller(clu.exec, () => {}, 60_000, target, () => {}, () => t);
    p.watch(5, "virtual", [{ id: "TIM1", index: 3 }]);
    await p.tick();
    const timerReg = clu.scripts.find((s) => s.includes("{{TIM1,3}}"))!;
    const timerId = Number(/,(\d+),\{/.exec(timerReg)![1]);
    clu.scripts.length = 0;
    t = 1_000;
    p.watch(5, "panel", [{ id: "PAN1", index: 0 }, { id: "PAN1", index: 1 }]);
    await p.tick();
    expect(clu.scripts).toEqual([expect.stringMatching(/\{\{PAN1,0\},\{PAN1,1\}\}\)$/)]); // only the new object
    p.applyPush(`clientReport:${timerId}:{900}`);
    expect(p.value(5, { id: "TIM1", index: 3 })).toBe("900");

    clu.scripts.length = 0;
    p.unwatch(5, "panel");
    await p.tick();
    expect(clu.scripts).toEqual([expect.stringMatching(/^SYSTEM:clientDestroy\(.*,\d+\)$/)]);
    expect(clu.scripts[0]).not.toContain(`,${timerId})`);
    p.dispose();
  });
});
