import { describe, expect, it } from "vitest";
import { AlivePoller, type AliveTarget } from "../../src/device/alivePoller";

describe("AlivePoller (background check alive)", () => {
  it("checks CLUs not heard from within the interval; failures are swallowed; rounds do not overlap", async () => {
    let t = 100_000;
    const targets: AliveTarget[] = [{ serial: 1 }, { serial: 2, lastSeen: new Date(90_000) }, { serial: 3, lastSeen: new Date(50_000) }];
    const asked: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = new AlivePoller(
      () => targets,
      async (serial) => {
        asked.push(serial);
        await gate;
        if (serial === 3) throw new Error("no answer");
      },
      30_000,
      () => t,
    );
    const a = p.tick();
    const b = p.tick(); // joins the running round
    expect(b).toBe(a);
    release();
    await a;
    expect(asked).toEqual([1, 3]); // 2 answered something 10 s ago
    t = 125_000;
    await p.tick();
    expect(asked).toEqual([1, 3, 1, 2, 3]);
  });
});
