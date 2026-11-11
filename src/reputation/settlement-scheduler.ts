import { kyivDate, nextKyivMidnight } from './kyiv-day.js';
import type { SettledDay, SettlementStore } from './settlement-store.js';

interface SettlementSchedulerOptions {
  guildId: string;
  store: SettlementStore;
  beforeSettlement(): Promise<void>;
  now?: () => Date;
  onSettled?: (day: SettledDay) => void;
  onUnavailable?: () => void;
  onRecovered?: () => void;
}

// Wakes at Kyiv midnight, on startup, and with bounded retry after failures.
// No minute-by-minute database polling; large catch-up queues yield in batches.
export class SettlementScheduler {
  private readonly now: () => Date;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = true;
  private failures = 0;

  constructor(private readonly options: SettlementSchedulerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  start(): Promise<void> {
    if (!this.stopped) return this.running ?? Promise.resolve();
    this.stopped = false;
    return this.runDue();
  }

  runDue(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.running = this.process().finally(() => { this.running = undefined; });
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private async process(): Promise<void> {
    try {
      // Persist a session crossing midnight before closing yesterday. If tracking
      // is suspended/unavailable, the store still settles only durable intervals.
      // Freeze the cutoff BEFORE flushing: a slow write crossing midnight must
      // not close a newly ended day whose final tail was not in that flush.
      const at = this.now();
      await this.options.beforeSettlement();
      let caughtUp = false;
      for (let count = 0; count < 31 && !this.stopped; count++) {
        const result = await this.options.store.settleNextClosedDay(this.options.guildId, at);
        if (!result) {
          caughtUp = true;
          break;
        }
        this.options.onSettled?.(result);
      }
      if (this.failures) this.options.onRecovered?.();
      this.failures = 0;
      const now = this.now();
      const crossedMidnight = kyivDate(now) !== kyivDate(at);
      this.schedule(caughtUp && !crossedMidnight ? Math.max(1, nextKyivMidnight(now).getTime() - now.getTime()) : 1_000);
    } catch {
      this.failures++;
      if (this.failures === 1) this.options.onUnavailable?.();
      this.schedule(Math.min(60_000 * 2 ** Math.min(this.failures - 1, 3), 5 * 60_000));
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.runDue(); }, delay);
    this.timer.unref();
  }
}
