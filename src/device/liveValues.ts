import { luaLiteral } from "../generator/omLua";
import { destroyExpression, parseClientReport, registerExpression } from "./push";

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

/** Where the CLU should push to (pushReceiver.ts); undefined port / address = poll instead. */
export interface PushTarget {
  port(): number | undefined;
  /** our address as the CLU reaches us (the interface used for that CLU) */
  localFor(serial: number): string | undefined;
}

/** A CLU's push subscriptions for the current set of watched reads. */
interface Subscription {
  sig: string;
  local: string;
  port: number;
  /** subscription id → its reads (the first one of the first id is the heartbeat) */
  ids: Map<number, FeatureRead[]>;
  registeredAt: number;
  lastPushAt?: number;
}

/** Reads per clientRegister (request stays well below one UDP datagram). */
const PUSH_BATCH = 40;
/** Re-register this often (recovers after a CLU restart, which forgets subscriptions). */
const REREGISTER_MS = 30_000;
/** No push within this time after registering: pushes do not reach us (firewall?) → poll. */
const HEARTBEAT_MS = 5_000;

/**
 * Polls watched features. Each tick reads, per CLU, every watched feature in batches through
 * `execute` (the CluRunner queue keeps one request in flight per CLU). Values and the last error
 * per CLU are kept for display; `onChange` fires after every tick that changed something.
 */
export class LivePoller {
  private readonly watched = new Map<number, Map<string, FeatureRead>>();
  private readonly subs = new Map<number, Subscription>();
  /** CLUs where push failed (old firmware, blocked UDP): polled */
  private readonly pollOnly = new Map<number, string>();
  private nextId = 1 + Math.floor(Math.random() * 100_000) * 10;
  private readonly values = new Map<string, string>();
  private readonly errors = new Map<number, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly execute: Execute,
    private readonly onChange: () => void,
    private readonly intervalMs = 2000,
    private readonly push?: PushTarget,
    private readonly log: (line: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /** "push" while the CLU pushes values, else "poll" (with the reason when push failed). */
  mode(serial: number): { mode: "push" | "poll"; reason?: string } {
    if (this.subs.has(serial)) return { mode: "push" };
    return { mode: "poll", reason: this.pollOnly.get(serial) };
  }

  /** A clientReport received from `address` (decrypted text). Returns true if it was ours. */
  applyPush(text: string): boolean {
    const rep = parseClientReport(text);
    if (!rep) return false;
    for (const [serial, sub] of this.subs) {
      const reads = sub.ids.get(rep.id);
      if (!reads) continue;
      sub.lastPushAt = this.now();
      if (rep.values.length !== reads.length) return true;
      if (this.store(serial, reads, rep.values)) this.onChange();
      return true;
    }
    return false;
  }

  private store(serial: number, reads: FeatureRead[], vals: string[]): boolean {
    let changed = false;
    reads.forEach((r, i) => {
      const k = LivePoller.key(serial, r);
      if (this.values.get(k) !== vals[i]) {
        this.values.set(k, vals[i]);
        changed = true;
      }
    });
    return changed;
  }

  /** Ends a CLU's subscriptions on the CLU (best effort). */
  private drop(serial: number): void {
    const sub = this.subs.get(serial);
    if (!sub) return;
    this.subs.delete(serial);
    for (const id of sub.ids.keys()) void this.execute(serial, destroyExpression(sub.local, sub.port, id)).catch(() => undefined);
  }

  /**
   * Subscribes (or keeps the subscription of) one CLU. Returns false when push is not used for it
   * (then the caller polls). Throws on communication errors (reported like poll errors).
   */
  private async subscribe(serial: number, reads: FeatureRead[]): Promise<boolean> {
    if (!this.push || this.pollOnly.has(serial)) return false;
    const port = this.push.port();
    const local = this.push.localFor(serial);
    if (!port || !local) return false;
    const sig = `${local}:${port}|${reads.map((r) => `${r.id}/${r.index}`).sort().join(";")}`;
    const now = this.now();
    let sub = this.subs.get(serial);
    if (sub && sub.sig === sig) {
      if (sub.lastPushAt === undefined && now - sub.registeredAt > HEARTBEAT_MS) {
        this.pollOnly.set(serial, "no push received (blocked UDP / firewall?)");
        this.log(`live values CLU${serial}: no push within ${HEARTBEAT_MS / 1000} s, polling instead`);
        this.drop(serial);
        return false;
      }
      if (now - sub.registeredAt < REREGISTER_MS) return true;
    } else if (sub) this.drop(serial);
    // the CLU's Uptime first: changes every second, so a missing push shows that pushes are blocked
    const heartbeat: FeatureRead = { id: `CLU${serial}`, index: 0 };
    const all = [heartbeat, ...reads.filter((r) => !(r.id === heartbeat.id && r.index === 0))];
    const ids = new Map<number, FeatureRead[]>();
    const reuse = sub?.sig === sig ? [...sub.ids.keys()] : [];
    for (const [i, batch] of chunks(all, PUSH_BATCH).entries()) {
      const id = reuse[i] ?? this.nextId++;
      const answer = await this.execute(serial, registerExpression(local, port, id, batch));
      const rep = parseClientReport(answer);
      if (!rep || rep.id !== id || rep.values.length !== batch.length) {
        this.pollOnly.set(serial, `clientRegister not supported (${answer.slice(0, 60)})`);
        this.log(`live values CLU${serial}: clientRegister answered ${JSON.stringify(answer.slice(0, 80))}, polling instead`);
        for (const done of ids.keys()) void this.execute(serial, destroyExpression(local, port, done)).catch(() => undefined);
        return false;
      }
      ids.set(id, batch);
      if (this.store(serial, batch, rep.values)) this.changedInTick = true;
    }
    sub = { sig, local, port, ids, registeredAt: now, lastPushAt: sub?.sig === sig ? sub.lastPushAt : undefined };
    this.subs.set(serial, sub);
    return true;
  }

  private changedInTick = false;

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
    if (m.size === 0) {
      this.watched.delete(serial);
      this.drop(serial);
    }
    if (this.watched.size === 0) this.stop();
  }

  /** Reads everything watched once (also used right after a set/execute); joins a running tick. */
  tick(): Promise<void> {
    this.inFlight ??= this.readAll().finally(() => (this.inFlight = undefined));
    return this.inFlight;
  }

  /** consecutive failed ticks per CLU before the error is shown */
  static readonly REPORT_AFTER = 2;
  private readonly failures = new Map<number, number>();

  private async readAll(): Promise<void> {
    let changed = false;
    this.changedInTick = false;
    await Promise.all(
      [...this.watched].map(async ([serial, m]) => {
        const unique = new Map<string, FeatureRead>();
        for (const r of m.values()) unique.set(`${r.id}/${r.index}`, r);
        try {
          if (await this.subscribe(serial, [...unique.values()])) {
            this.failures.delete(serial);
            if (this.errors.delete(serial)) changed = true;
            return;
          }
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
          this.failures.delete(serial);
          if (this.errors.delete(serial)) changed = true;
        } catch (e) {
          // a real CLU now and then drops a req: answer (UDP): report only repeated failures
          const n = (this.failures.get(serial) ?? 0) + 1;
          this.failures.set(serial, n);
          if (n < LivePoller.REPORT_AFTER) return;
          if (this.errors.get(serial) !== (e as Error).message) changed = true;
          this.errors.set(serial, (e as Error).message);
        }
      }),
    );
    if (changed || this.changedInTick) this.onChange();
  }

  private ensureTimer(): void {
    this.timer ??= setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Pauses polling (view hidden) and ends push subscriptions; watches are kept. */
  pause(): void {
    this.stop();
    for (const serial of [...this.subs.keys()]) this.drop(serial);
  }

  /** Resumes polling if anything is watched. */
  resume(): void {
    if (this.watched.size > 0) {
      this.ensureTimer();
      void this.tick();
    }
  }

  dispose(): void {
    this.pause();
    this.watched.clear();
  }
}
