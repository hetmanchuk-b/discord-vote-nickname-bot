import type { ReportSettingsStore } from './report-settings.js';
import type { ReportStore, DailyReport } from './report-store.js';
import type { PublicationTransport } from './discord-publications.js';
import { renderReport } from './report-render.js';

interface PublisherOptions {
  guildId: string;
  store: ReportStore;
  settings: ReportSettingsStore;
  transport: PublicationTransport;
  onHealth(healthy: boolean): void;
}

// Only presentation happens here; no balance or settlement writes. Durable states
// distinguish an empty placeholder from a frozen, possibly already delivered report.
export class ReportPublisher {
  private running?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private failures = 0;
  private dirty = false;

  constructor(private readonly options: PublisherOptions) {}

  start(): Promise<void> {
    this.stopped = false;
    return this.wake();
  }

  wake(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.dirty = true;
      return this.running;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.running = this.process().finally(() => {
      this.running = undefined;
      if (this.dirty && !this.stopped) {
        this.dirty = false;
        void this.wake();
      }
    });
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  private async process(): Promise<void> {
    let failed = false;
    let more = false;
    try {
      const reports = await this.options.store.pending(this.options.guildId);
      more = reports.length === 31;
      const destination = await this.options.settings.getReportChannelId(this.options.guildId);
      for (const report of reports) {
        if (this.stopped) break;
        try {
          await this.options.store.noteAttempt(report.id);
          await this.deliver(report, destination);
        }
        catch { failed = true; }
      }
    } catch { failed = true; }
    if (this.stopped) return;
    this.options.onHealth(!failed);
    this.failures = failed ? this.failures + 1 : 0;
    if (!this.stopped && (failed || more)) {
      const delay = failed ? Math.min(60_000 * 2 ** Math.min(this.failures - 1, 3), 5 * 60_000) : 1_000;
      this.timer = setTimeout(() => { void this.wake(); }, delay);
      this.timer.unref();
    }
  }

  private async deliver(initial: DailyReport, destination: string | null): Promise<void> {
    const { store, transport } = this.options;
    let report = await store.get(initial.id);
    if (!report || report.status === 'published' || report.status === 'missing') return;
    if (report.status === 'pending') {
      if (!destination) throw new Error('No report channel configured.');
      if (!report.messageId || report.channelId !== destination) {
        const id = await transport.createPlaceholder(destination, report);
        report = await store.attachMessage(report.id, destination, id);
      }
      if (report.status === 'published') return;
      if (!report.messageId || !report.channelId) throw new Error('Missing report destination.');
      const state = await transport.inspect(report.channelId, report.messageId, report.id);
      if (state === 'missing') {
        await store.clearPlaceholder(report.id, report.messageId);
        throw new Error('Report placeholder disappeared.');
      }
      if (state === 'published' && report.status === 'pending') throw new Error('Unexpected report publication state.');
      report = await store.prepare(report.id);
    }
    if (report.status !== 'publishing') return;
    if (!report.channelId || !report.messageId) throw new Error('Missing frozen report destination.');
    const state = await transport.inspect(report.channelId, report.messageId, report.id);
    if (state === 'missing') {
      await store.markMissing(report.id);
      return; // Respect deleted messages; never automatically recreate published data.
    }
    if (state === 'pending') {
      await transport.edit(report.channelId, report.messageId, renderReport(await store.snapshot(report.id, 0), new Date()));
    }
    // If an edit/DB acknowledgement was lost, observing the published marker lets
    // us adopt the existing message without a second message or another payout.
    await store.finish(report.id);
  }
}
