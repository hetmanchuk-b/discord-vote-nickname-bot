import { EmbedBuilder } from 'discord.js';
import type { PublicationPayload } from './report-render.js';
import type { PublicationTransport } from './discord-publications.js';
import type { WarningIssue, WarningState, WarningStore } from './warning-store.js';

export const WARNING_UPDATE_MS = 60 * 60_000;
const labels: Record<WarningIssue, string> = {
  tracking: 'Відстеження голосових каналів', settlement: 'Щоденне зарахування', reports: 'Доставка щоденних звітів',
};

export function renderWarning(guildId: string, state: WarningState, at: Date): PublicationPayload {
  const active = state.reasons.length > 0;
  const reasons = state.reasons.map(reason => labels[reason as WarningIssue]).filter(Boolean);
  return {
    content: '', components: [], allowedMentions: { parse: [] },
    embeds: [new EmbedBuilder().setColor(active ? 0xFEE75C : 0x57F287)
      .setTitle(active ? '⚠️ Проблема з репутацією' : '✅ Роботу репутації відновлено')
      .setDescription(active ? `${reasons.join('\n')}\n\nНепідтверджений голосовий час не зараховується. Збережені бали не втрачаються.` :
        'Усі відомі проблеми усунено. Пропущений непідтверджений час не зараховується заднім числом.')
      .addFields({ name: 'Оновлено', value: `<t:${Math.floor(at.getTime() / 1000)}:F>` })
      .setFooter({ text: `REP-WARN:${guildId}` })],
  };
}

interface WarningOptions {
  guildId: string;
  store: WarningStore;
  transport: PublicationTransport;
  now?: () => Date;
}

// One reusable message, not one message per retry. Local state remains usable
// during DB outages; persistence restores the message ID and hourly throttle.
export class OperationalWarnings {
  private readonly now: () => Date;
  private readonly intents = new Map<WarningIssue, boolean>();
  private state?: WarningState;
  private destination: string | null = null;
  private loaded = false;
  private stopped = false;
  private tail: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private firstIssueAt?: Date;

  constructor(private readonly options: WarningOptions) { this.now = options.now ?? (() => new Date()); }

  start(): Promise<void> { return this.queue(); }

  setIssue(issue: WarningIssue, active: boolean): Promise<void> {
    if (this.stopped || this.intents.get(issue) === active) return this.tail;
    this.intents.set(issue, active);
    if (active && !this.firstIssueAt) this.firstIssueAt = this.now();
    return this.queue();
  }

  channelChanged(channelId: string): Promise<void> {
    this.destination = channelId;
    return this.queue();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.tail;
  }

  private queue(): Promise<void> {
    if (this.stopped) return this.tail;
    this.tail = this.tail.then(() => this.sync()).catch(() => {
      console.warn('Could not update the reputation warning message; retrying later.');
      this.schedule(5 * 60_000);
    });
    return this.tail;
  }

  private schedule(delay: number) {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.queue(); }, Math.max(1, delay));
    this.timer.unref();
  }

  private async sync(): Promise<void> {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const now = this.now();
    let loadFailed = false;
    if (!this.loaded) {
      try {
        const loaded = await this.options.store.load(this.options.guildId);
        this.destination ??= loaded.destination;
        if (!this.state?.deliveryUncertain && (!this.state?.lastEditedAt || loaded.state?.lastEditedAt && loaded.state.lastEditedAt > this.state.lastEditedAt)) {
          this.state = loaded.state ?? this.state;
        }
        this.loaded = true;
      } catch { loadFailed = true; }
    }
    this.state ??= {
      channelId: null, messageId: null, reasons: [], activeSince: null,
      lastSeenAt: now, lastEditedAt: null, displayedActive: false, deliveryUncertain: false,
    };
    const state = this.state;
    const previous = state.reasons.length > 0;
    const reasons = new Set(state.reasons.filter(reason => Object.hasOwn(labels, reason)));
    for (const [issue, active] of this.intents) {
      if (active) reasons.add(issue);
      else reasons.delete(issue);
    }
    state.reasons = [...reasons].sort();
    const active = state.reasons.length > 0;
    if (active && !previous) state.activeSince = this.firstIssueAt ?? now;
    if (!active) this.firstIssueAt = undefined;
    state.lastSeenAt = now;
    const newDestination = state.channelId !== this.destination;
    const due = active !== state.displayedActive || active && (!state.lastEditedAt || now.getTime() - state.lastEditedAt.getTime() >= WARNING_UPDATE_MS);
    if (this.destination && (active || state.messageId || state.deliveryUncertain) && (due || newDestination || state.deliveryUncertain)) {
      if (newDestination) {
        state.channelId = this.destination;
        state.messageId = null;
      }
      state.deliveryUncertain = true;
      // Persist intent before I/O where possible. If the DB itself is down, the
      // cached channel still permits an alert; local state guards normal retries.
      if (!loadFailed) {
        try { await this.options.store.save(this.options.guildId, state); }
        catch { /* Deliver the warning even when its persistence is unavailable. */ }
      }
      const id = await this.options.transport.warning(
        this.destination, state.messageId, this.options.guildId,
        renderWarning(this.options.guildId, state, now),
      );
      state.channelId = this.destination;
      state.messageId = id;
      state.lastEditedAt = this.now();
      state.displayedActive = active;
      state.deliveryUncertain = false;
    }
    if (loadFailed) throw new Error('Warning persistence unavailable.');
    if (active || state.messageId || state.deliveryUncertain) await this.options.store.save(this.options.guildId, state);
    if (active) {
      if (!this.destination) this.schedule(5 * 60_000); // No channel: log/queue, never guess a destination.
      else this.schedule(state.lastEditedAt ? WARNING_UPDATE_MS - (this.now().getTime() - state.lastEditedAt.getTime()) : 5 * 60_000);
    }
  }
}
