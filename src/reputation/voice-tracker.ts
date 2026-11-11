import { TrackingLeaseLostError } from './tracking-store.js';
import type { TrackingChange, TrackingStore } from './tracking-store.js';

export const CHECKPOINT_INTERVAL_MS = 5 * 60_000;
const MAX_OBSERVATION_GAP_MS = CHECKPOINT_INTERVAL_MS + 60_000;

export interface TrackingStatusEvent {
  status: 'unavailable' | 'recovered' | 'suspended' | 'lease-lost';
  at: Date;
  reason: string;
}

interface TrackerOptions {
  guildId: string;
  store: TrackingStore;
  // Candidates include paused humans; persisted preferences decide who earns time.
  presentUserIds(): readonly string[];
  now?: () => Date;
  onStatus?: (event: TrackingStatusEvent) => void;
}

interface Observation {
  at: Date;
  present: Set<string>;
}

// One serialized writer per server. Captured event timestamps prevent database
// latency from moving join/leave times. An uncertain write is never retried:
// recovery starts a fresh run, preserving only what the database actually committed.
export class VoiceTracker {
  private readonly now: () => Date;
  private tail: Promise<unknown> = Promise.resolve();
  private runId?: string;
  private cursor?: Date;
  private present = new Set<string>();
  private paused = new Set<string>();
  private suspended = true;
  private leaseLost = false;
  private retryAt = 0;
  private failures = 0;

  constructor(private readonly options: TrackerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  get status(): 'suspended' | 'tracking' | 'unavailable' | 'lease-lost' {
    if (this.leaseLost) return 'lease-lost';
    if (this.suspended) return 'suspended';
    return this.runId ? 'tracking' : 'unavailable';
  }

  start(): Promise<void> {
    return this.enqueue(async () => {
      this.suspended = false;
      if (!this.runId) await this.recover();
    });
  }

  observe(): Promise<void> {
    const observation = this.capture();
    return this.enqueue(() => this.process(observation, false));
  }

  checkpoint(): Promise<void> {
    const observation = this.capture();
    return this.enqueue(() => this.process(observation, true));
  }

  setTracking(userId: string, enabled: boolean): Promise<void> {
    const observation = this.capture();
    return this.enqueue(async () => {
      const change: TrackingChange = { userId, enabled };
      // Flush before changing state. If storage is unavailable, do not claim success.
      if (!this.suspended && !this.leaseLost) {
        await this.process(observation, true);
        if (!this.runId || !this.cursor) throw new Error('Voice tracking storage is unavailable.');
        const at = observation.at < this.cursor ? this.cursor : observation.at;
        try {
          await this.options.store.checkpoint({
            guildId: this.options.guildId, runId: this.runId,
            from: this.cursor, to: at, userIds: [], preference: change,
          });
          this.cursor = at;
        } catch (error) {
          this.failed(error);
          // Raw driver causes can expose credentials through the command error logger.
          // eslint-disable-next-line preserve-caught-error
          throw new Error('Could not persist the tracking preference.');
        }
      } else {
        try {
          await this.options.store.setTracking(this.options.guildId, change, observation.at);
        } catch {
          throw new Error('Could not persist the tracking preference.');
        }
      }
      if (enabled) this.paused.delete(userId);
      else this.paused.add(userId);
    });
  }

  deleteData(userId: string): Promise<void> {
    const observation = this.capture();
    return this.enqueue(async () => {
      // Flush everyone first so deleting one member does not discard others' tails.
      if (!this.suspended && !this.leaseLost && this.runId) await this.process(observation, true);
      this.paused.add(userId);
      const now = this.now();
      const at = this.cursor && this.cursor > now ? this.cursor : now;
      try {
        await this.options.store.deleteMemberData(this.options.guildId, userId, at);
      } catch (error) {
        // Unknown commit outcome: discard caches and reload persisted opt-outs on recovery.
        this.failed(error);
        // eslint-disable-next-line preserve-caught-error
        throw new Error('Could not confirm deletion of reputation data.');
      }
    });
  }

  // Disconnects discard the unsaved tail; we cannot prove the missing interval.
  suspend(reason = 'gateway'): Promise<void> {
    const at = this.now();
    return this.enqueue(async () => {
      this.suspended = true;
      await this.close(at, reason);
      this.options.onStatus?.({ status: 'suspended', at, reason });
    });
  }

  stop(): Promise<void> {
    const observation = this.capture();
    return this.enqueue(async () => {
      if (!this.suspended && this.runId) await this.process(observation, true);
      this.suspended = true;
      await this.close(observation.at, 'shutdown');
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  private capture(): Observation {
    return { at: this.now(), present: new Set(this.options.presentUserIds()) };
  }

  private async recover(): Promise<void> {
    if (this.leaseLost || this.now().getTime() < this.retryAt) return;
    // Never recover using an old queued snapshot captured during an outage.
    const observation = this.capture();
    try {
      const run = await this.options.store.openRun(this.options.guildId, observation.at);
      this.runId = run.runId;
      this.cursor = observation.at;
      this.present = observation.present;
      this.paused = new Set(run.pausedUserIds);
      if (this.failures) {
        this.options.onStatus?.({ status: 'recovered', at: observation.at, reason: 'database' });
      }
      this.failures = 0;
      this.retryAt = 0;
    } catch (error) {
      this.failed(error);
    }
  }

  private async process(observation: Observation, force: boolean): Promise<void> {
    if (this.suspended || this.leaseLost) return;
    if (!this.runId || !this.cursor) {
      await this.recover();
      return;
    }
    if (observation.at < this.cursor) return; // Stale queued event / clock rollback.
    if (observation.at.getTime() - this.cursor.getTime() > MAX_OBSERVATION_GAP_MS) {
      await this.close(observation.at, 'observation-gap');
      this.options.onStatus?.({ status: 'suspended', at: observation.at, reason: 'observation-gap' });
      if (!this.failures) {
        await this.recover();
        if (this.runId) {
          this.options.onStatus?.({ status: 'recovered', at: this.cursor ?? observation.at, reason: 'observation-gap' });
        }
      }
      return;
    }
    const unchanged = this.present.size === observation.present.size &&
      [...this.present].every(id => observation.present.has(id));
    if (!force && unchanged) return; // Mute/deafen and eligible-to-eligible moves.

    try {
      await this.options.store.checkpoint({
        guildId: this.options.guildId, runId: this.runId,
        from: this.cursor, to: observation.at,
        userIds: [...this.present].filter(id => !this.paused.has(id)),
      });
      this.cursor = observation.at;
      this.present = observation.present;
    } catch (error) {
      this.failed(error);
    }
  }

  private async close(at: Date, reason: string): Promise<void> {
    const runId = this.runId;
    this.runId = undefined;
    this.cursor = undefined;
    this.present.clear();
    if (!runId) return;
    try {
      await this.options.store.closeRun(this.options.guildId, runId, at, reason);
    } catch (error) {
      this.failed(error);
    }
  }

  private failed(error: unknown): void {
    this.runId = undefined;
    this.cursor = undefined;
    this.present.clear();
    const at = this.now();
    if (error instanceof TrackingLeaseLostError) {
      this.leaseLost = true;
      this.options.onStatus?.({ status: 'lease-lost', at, reason: 'another-tracker' });
      return;
    }
    this.failures++;
    this.retryAt = at.getTime() + Math.min(5_000 * 2 ** Math.min(this.failures - 1, 6), CHECKPOINT_INTERVAL_MS);
    if (this.failures === 1) {
      this.options.onStatus?.({ status: 'unavailable', at, reason: 'database' });
    }
  }
}
