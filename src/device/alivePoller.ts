/**
 * Background check alive: keeps `online` / `lastSeen` of every CLU current without reading any
 * module values (those are subscribed only for expanded module rows, see liveValues.ts). A CLU
 * that answered anything else within the interval (req:, TFTP, pushes) is not asked again; the
 * answer itself reaches the Devices view through CluRunner.onContact.
 */
export interface AliveTarget {
  serial: number;
  /** last answer of any kind */
  lastSeen?: Date;
  /** false: checked every round, however recent lastSeen is (restored after a restart, lost) */
  online?: boolean;
}

export class AlivePoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;

  constructor(
    /** CLUs to check (reachable, with a key) */
    private readonly targets: () => readonly AliveTarget[],
    /** check alive of one CLU; errors are swallowed (no answer = lost via onContact) */
    private readonly checkAlive: (serial: number) => Promise<unknown>,
    private readonly intervalMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), this.intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One round (joins a running one): CLUs not heard from within the interval, in parallel. */
  tick(): Promise<void> {
    this.running ??= Promise.all(
      this.targets()
        .filter((c) => c.online === false || !c.lastSeen || this.now() - c.lastSeen.getTime() >= this.intervalMs)
        .map((c) => this.checkAlive(c.serial).catch(() => undefined)),
    )
      .then(() => undefined)
      .finally(() => (this.running = undefined));
    return this.running;
  }
}
