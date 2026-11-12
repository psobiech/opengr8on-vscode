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
  local: string;
  port: number;
  /** `<object id>#<chunk>` → its subscription; `CLU<serial>#0` (Uptime first) is the heartbeat */
  objects: Map<string, ObjectSub>;
}

/** One clientRegister id: the watched features of one object (chunked when there are many). */
interface ObjectSub {
  id: number;
  reads: FeatureRead[];
  sig: string;
  registeredAt: number;
  lastPushAt?: number;
}

/** Reads per clientRegister (request stays well below one UDP datagram). */
const PUSH_BATCH = 40;
/** Re-register this often (recovers after a CLU restart, which forgets subscriptions). */
const REREGISTER_MS = 30_000;
/** No push within this time after registering: pushes do not reach us (firewall?) → poll. */
const HEARTBEAT_MS = 5_000;
/** Pushes stopped this long (Uptime pushes every second): register again; failing = CLU lost. */
const STALL_MS = 5_000;

/**
 * Live values of watched features: pushed by the CLU (clientRegister) where possible, else polled.
 * Each tick (re-)subscribes or reads, per CLU, every watched feature in batches through `execute`
 * (the CluRunner queue keeps one request in flight per CLU). Values and the last error per CLU are
 * kept for display; `onChange` fires after every tick that changed something.
 *
 * Watches come from expanded module rows only; their pushes (and the CLU Uptime heartbeat in every
 * subscription) also report the CLU as seen (onContact), repeated failures as lost.
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
  /** A CLU answered (push) or was lost (repeated failures). Set by the extension. */
  onContact: ((serial: number, answered: boolean) => void) | undefined;

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
    if (this.subs.get(serial)?.objects.size) return { mode: "push" };
    return { mode: "poll", reason: this.pollOnly.get(serial) };
  }

  /** A clientReport received from `address` (decrypted text). Returns true if it was ours. */
  applyPush(text: string): boolean {
    const rep = parseClientReport(text);
    if (!rep) {
      this.logOnce(`unreadable:${/clientReport:(\d+)/.exec(text)?.[1] ?? "?"}`, `live values: unreadable push ${JSON.stringify(text.slice(0, 160))}`);
      return false;
    }
    for (const [serial, sub] of this.subs) {
      const o = [...sub.objects.values()].find((x) => x.id === rep.id);
      if (!o) continue;
      const reads = o.reads;
      o.lastPushAt = this.now();
      this.onContact?.(serial, true);
      if (rep.values.length !== reads.length) {
        // e.g. an unquoted string value with a comma: only this object's values are lost
        this.logOnce(`count:${rep.id}`, `live values CLU${serial}: push ${rep.id} has ${rep.values.length} values for ${reads.length} reads (${reads[0].id}): ${JSON.stringify(text.slice(0, 160))}`);
        return true;
      }
      if (this.store(serial, reads, rep.values)) this.onChange();
      return true;
    }
    return false;
  }

  private readonly logged = new Set<string>();
  /** Logs a diagnostic once per key (pushes arrive every second). */
  private logOnce(key: string, line: string): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.log(line);
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
    for (const o of sub.objects.values()) this.destroy(serial, sub, o.id);
  }

  private destroy(serial: number, sub: Subscription, id: number): void {
    void this.execute(serial, destroyExpression(sub.local, sub.port, id)).catch(() => undefined);
  }

  /**
   * Subscribes (or keeps the subscriptions of) one CLU, one clientRegister id per object, changed
   * incrementally: objects still watched keep their id (expanding another module does not touch
   * them), new ones are registered, removed ones destroyed; each is re-registered every
   * REREGISTER_MS. Returns false when push is not used for the CLU (then the caller polls). Throws
   * on communication errors (reported like poll errors).
   */
  private async subscribe(serial: number, reads: FeatureRead[]): Promise<boolean> {
    if (!this.push || this.pollOnly.has(serial)) return false;
    const port = this.push.port();
    const local = this.push.localFor(serial);
    if (!port || !local) return false;
    const now = this.now();
    let sub = this.subs.get(serial);
    if (sub && (sub.local !== local || sub.port !== port)) {
      this.drop(serial);
      sub = undefined;
    }
    // the CLU's Uptime first: changes every second, so its pushes show the CLU and the path are alive
    const hbRead: FeatureRead = { id: `CLU${serial}`, index: 0 };
    const hbKey = `${hbRead.id}#0`;
    const hb = sub?.objects.get(hbKey);
    if (sub && hb) {
      if (hb.lastPushAt === undefined && now - hb.registeredAt > HEARTBEAT_MS) {
        this.pollOnly.set(serial, "no push received (blocked UDP / firewall?)");
        this.log(`live values CLU${serial}: no push within ${HEARTBEAT_MS / 1000} s, polling instead`);
        this.drop(serial);
        return false;
      }
      if (hb.lastPushAt !== undefined && now - hb.lastPushAt > STALL_MS) {
        // CLU restarted (forgot its subscriptions) or is gone: a fresh register tells which
        const others = [...sub.objects.values()].filter((o) => o !== hb && o.lastPushAt !== undefined && now - o.lastPushAt <= STALL_MS).length;
        this.log(`live values CLU${serial}: no push for ${Math.round((now - hb.lastPushAt) / 1000)} s, registering again${others ? ` (${others} other subscription(s) still pushing)` : ""}`);
        this.drop(serial);
        sub = undefined;
      }
    }
    const want = new Map<string, FeatureRead[]>();
    const byObject = new Map<string, FeatureRead[]>([[hbRead.id, [hbRead]]]);
    for (const r of reads) if (!(r.id === hbRead.id && r.index === 0)) byObject.set(r.id, [...(byObject.get(r.id) ?? []), r]);
    for (const [id, rs] of byObject) chunks(rs, PUSH_BATCH).forEach((c, i) => want.set(`${id}#${i}`, c));

    if (!sub) this.subs.set(serial, (sub = { local, port, objects: new Map() }));
    for (const [key, o] of [...sub.objects]) {
      if (want.has(key)) continue;
      sub.objects.delete(key);
      this.destroy(serial, sub, o.id);
    }
    for (const [key, batch] of want) {
      const sig = batch.map((r) => r.index).join(",");
      const old = sub.objects.get(key);
      if (old && old.sig === sig && now - old.registeredAt < REREGISTER_MS) continue;
      if (old && old.sig !== sig) this.destroy(serial, sub, old.id);
      const id = old && old.sig === sig ? old.id : this.nextId++;
      const answer = await this.execute(serial, registerExpression(local, port, id, batch));
      const rep = parseClientReport(answer);
      if (!rep || rep.id !== id || rep.values.length !== batch.length) {
        this.pollOnly.set(serial, `clientRegister not supported (${answer.slice(0, 60)})`);
        this.log(`live values CLU${serial}: clientRegister answered ${JSON.stringify(answer.slice(0, 80))}, polling instead`);
        if (!sub.objects.has(key)) this.destroy(serial, sub, id);
        this.drop(serial);
        return false;
      }
      sub.objects.set(key, { id, reads: batch, sig, registeredAt: now, lastPushAt: old && old.sig === sig ? old.lastPushAt : undefined });
      if (this.store(serial, batch, rep.values)) this.changedInTick = true;
    }
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
  /** Idempotent: watching what is already watched sends nothing (called on every re-render). */
  watch(serial: number, owner: string, reads: FeatureRead[]): void {
    let m = this.watched.get(serial);
    if (!m) this.watched.set(serial, (m = new Map()));
    let added = false;
    for (const r of reads) {
      const k = `${owner}#${r.id}/${r.index}`;
      if (!m.has(k)) (m.set(k, r), (added = true));
    }
    if (!added) return;
    this.ensureTimer();
    void this.tick();
  }

  /** Ends every watch of a CLU whose owner starts with `prefix` (e.g. its tree collapsed). */
  unwatchPrefix(serial: number, prefix: string): void {
    const m = this.watched.get(serial);
    if (!m) return;
    const owners = new Set([...m.keys()].map((k) => k.slice(0, k.indexOf("#"))).filter((o) => o.startsWith(prefix)));
    for (const o of owners) this.unwatch(serial, o);
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
        const reads = [...unique.values()];
        try {
          if (await this.subscribe(serial, reads)) {
            this.failures.delete(serial);
            if (this.errors.delete(serial)) changed = true;
            return;
          }
          for (const batch of chunks(reads)) {
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
          this.onContact?.(serial, false);
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

  /** Pauses (view hidden) and ends push subscriptions; watches are kept. */
  pause(): void {
    this.stop();
    for (const serial of [...this.subs.keys()]) this.drop(serial);
  }

  /** Resumes if anything is watched. */
  resume(): void {
    if (this.watched.size > 0) {
      this.ensureTimer();
      void this.tick();
    }
  }

  dispose(): void {
    this.stop();
    for (const serial of [...this.subs.keys()]) this.drop(serial);
    this.watched.clear();
  }
}
