import { kyivDate, nextKyivMidnight } from './kyiv-day.js';
import type { SettledDay, SettlementStore } from './settlement-store.js';
import { classifyWarning } from './warning-details.js';
import type { WarningDetail } from './warning-details.js';
import type { IntervalRetentionStore } from './interval-retention.js';

interface SettlementSchedulerOptions {
  guildId: string;
  store: SettlementStore;
  retention?: IntervalRetentionStore;
  beforeSettlement(): Promise<void>;
  now?: () => Date;
  onSettled?: (day: SettledDay) => void;
  onUnavailable?: (details: readonly WarningDetail[]) => void;
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
  private failureDetails = '';
  private retentionFailures = 0;
  private retentionPending = false;
  private caughtUpDay?: string;

  constructor(private readonly options: SettlementSchedulerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  get healthy(): boolean { return !this.stopped && this.failures === 0; }

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
      const day = kyivDate(at);
      // Cleanup-only retries must not create another checkpoint interval every
      // second. A new Kyiv day always flushes and checks accounting again.
      let caughtUp = this.retentionPending && this.caughtUpDay === day;
      if (!caughtUp) {
        await this.options.beforeSettlement();
        for (let count = 0; count < 31 && !this.stopped; count++) {
          const result = await this.options.store.settleNextClosedDay(this.options.guildId, at);
          if (!result) {
            caughtUp = true;
            break;
          }
          this.options.onSettled?.(result);
        }
        if (caughtUp) this.caughtUpDay = day;
      }
      if (this.failures) this.options.onRecovered?.();
      this.failures = 0;
      const retentionDelay = caughtUp && !this.stopped ? await this.pruneIntervals(at) : undefined;
      this.retentionPending = retentionDelay !== undefined;
      const now = this.now();
      const crossedMidnight = kyivDate(now) !== kyivDate(at);
      const settlementDelay = caughtUp && !crossedMidnight ? Math.max(1, nextKyivMidnight(now).getTime() - now.getTime()) : 1_000;
      this.schedule(retentionDelay === undefined ? settlementDelay : Math.min(settlementDelay, retentionDelay));
    } catch (error) {
      this.failures++;
      const details = classifyWarning(error, 'database');
      const key = details.join(',');
      if (this.failures === 1 || key !== this.failureDetails) this.options.onUnavailable?.(details);
      this.failureDetails = key;
      this.schedule(Math.min(60_000 * 2 ** Math.min(this.failures - 1, 3), 5 * 60_000));
    }
  }

  private async pruneIntervals(at: Date): Promise<number | undefined> {
    if (!this.options.retention) return;
    try {
      const result = await this.options.retention.prune(this.options.guildId, at);
      if (this.retentionFailures) console.log('Reputation interval cleanup recovered.');
      this.retentionFailures = 0;
      // One bounded transaction per wake; yield between backlog batches.
      return result.hasMore ? 1_000 : undefined;
    } catch {
      this.retentionFailures++;
      if (this.retentionFailures === 1) console.warn('Could not clean up expired voice intervals; will retry safely.');
      // Maintenance failure must not undo accounting or mark payouts unavailable.
      return Math.min(60_000 * 2 ** Math.min(this.retentionFailures - 1, 3), 5 * 60_000);
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.runDue(); }, delay);
    this.timer.unref();
  }
}
