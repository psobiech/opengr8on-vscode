import { luaLiteral } from "../generator/omLua";

/** One feature read: `<id>:get(<index>)`. */
export interface FeatureRead {
  id: string;
  index: number;
}

/** Field separator inside a batch answer (ASCII unit separator; not expected in feature values). */
const SEP = "\x1f";
/** Reads per `req:` (keeps request and answer well inside one UDP datagram). */
export const BATCH_SIZE = 24;

const ID = /^[A-Za-z_]\w*$/;
const checkId = (id: string) => {
  if (!ID.test(id)) throw new Error(`invalid object id: ${id}`);
  return id;
};

/** Lua expression reading all `reads` at once: tostring(A:get(0)).."\31"..tostring(B:get(3)). */
export function batchExpression(reads: FeatureRead[]): string {
  if (reads.length === 0) throw new Error("nothing to read");
  return reads.map((r) => `tostring(${checkId(r.id)}:get(${Math.trunc(r.index)}))`).join('.."\\31"..');
}

/** Splits a batch answer; throws if the CLU answered with something else (e.g. a Lua error). */
export function parseBatch(answer: string, count: number): string[] {
  const values = answer.split(SEP);
  if (values.length !== count) throw new Error(`unexpected answer (${values.length} values for ${count} reads): ${answer.slice(0, 80)}`);
  return values;
}

export function chunks<T>(items: T[], size = BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Converts user input to a Lua argument for an interface param/feature type. */
export function luaArg(type: string, input: string): string {
  const v = input.trim();
  if (type === "str") return luaLiteral(input);
  if (v === "true" || v === "false") return v;
  if (v === "" || !Number.isFinite(Number(v))) throw new Error(`"${input}" is not a number`);
  if (type === "int" && !Number.isInteger(Number(v))) throw new Error(`"${input}" is not an integer`);
  return String(Number(v));
}

export interface MethodLike {
  call: string;
  index: number;
  params: { type: string }[];
}

/** `<id>:set(<index>, <arg>)` or `<id>:execute(<index>, <args...>)`, as OM compiles actions. */
export function methodCall(id: string, method: MethodLike, inputs: string[]): string {
  if (method.call !== "set" && method.call !== "execute") throw new Error(`unsupported method call type: ${method.call}`);
  if (inputs.length !== method.params.length) throw new Error(`expected ${method.params.length} argument(s), got ${inputs.length}`);
  const args = method.params.map((p, i) => luaArg(p.type, inputs[i]));
  return `${checkId(id)}:${method.call}(${[String(method.index), ...args].join(", ")})`;
}

export type Execute = (serial: number, script: string) => Promise<string>;

/**
 * Polls watched features. Each tick reads, per CLU, every watched feature in batches through
 * `execute` (the CluRunner queue keeps one request in flight per CLU). Values and the last error
 * per CLU are kept for display; `onChange` fires after every tick that changed something.
 */
export class LivePoller {
  private readonly watched = new Map<number, Map<string, FeatureRead>>();
  private readonly values = new Map<string, string>();
  private readonly errors = new Map<number, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly execute: Execute,
    private readonly onChange: () => void,
    private readonly intervalMs = 2000,
  ) {}

  static key(serial: number, r: FeatureRead): string {
    return `${serial}/${r.id}/${r.index}`;
  }

  value(serial: number, r: FeatureRead): string | undefined {
    return this.values.get(LivePoller.key(serial, r));
  }

  error(serial: number): string | undefined {
    return this.errors.get(serial);
  }

  /** Watches features under `owner` (e.g. an IO node id); polling starts with the first watch. */
  watch(serial: number, owner: string, reads: FeatureRead[]): void {
    let m = this.watched.get(serial);
    if (!m) this.watched.set(serial, (m = new Map()));
    for (const r of reads) m.set(`${owner}#${r.id}/${r.index}`, r);
    this.ensureTimer();
    void this.tick();
  }

  unwatch(serial: number, owner: string): void {
    const m = this.watched.get(serial);
    if (!m) return;
    for (const k of [...m.keys()]) if (k.startsWith(`${owner}#`)) m.delete(k);
    if (m.size === 0) this.watched.delete(serial);
    if (this.watched.size === 0) this.stop();
  }

  /** Reads everything watched once (also used right after a set/execute); joins a running tick. */
  tick(): Promise<void> {
    this.inFlight ??= this.readAll().finally(() => (this.inFlight = undefined));
    return this.inFlight;
  }

  private async readAll(): Promise<void> {
    let changed = false;
    await Promise.all(
      [...this.watched].map(async ([serial, m]) => {
        const unique = new Map<string, FeatureRead>();
        for (const r of m.values()) unique.set(`${r.id}/${r.index}`, r);
        try {
          for (const batch of chunks([...unique.values()])) {
            const vals = parseBatch(await this.execute(serial, batchExpression(batch)), batch.length);
            batch.forEach((r, i) => {
              const k = LivePoller.key(serial, r);
              if (this.values.get(k) !== vals[i]) {
                this.values.set(k, vals[i]);
                changed = true;
              }
            });
          }
          if (this.errors.delete(serial)) changed = true;
        } catch (e) {
          if (this.errors.get(serial) !== (e as Error).message) changed = true;
          this.errors.set(serial, (e as Error).message);
        }
      }),
    );
    if (changed) this.onChange();
  }

  private ensureTimer(): void {
    this.timer ??= setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Pauses polling (view hidden); watches are kept. */
  pause(): void {
    this.stop();
  }

  /** Resumes polling if anything is watched. */
  resume(): void {
    if (this.watched.size > 0) {
      this.ensureTimer();
      void this.tick();
    }
  }

  dispose(): void {
    this.stop();
    this.watched.clear();
  }
}
