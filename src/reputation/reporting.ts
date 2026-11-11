import type { Client } from 'discord.js';
import { createDiscordPublications } from './discord-publications.js';
import { createReportStore } from './report-store.js';
import type { ReportStore } from './report-store.js';
import { createReportSettingsStore } from './report-settings.js';
import { createWarningStore } from './warning-store.js';
import type { WarningIssue } from './warning-store.js';
import type { WarningDetail } from './warning-details.js';
import { OperationalWarnings } from './operational-warnings.js';
import { ReportPublisher } from './report-publisher.js';
import { renderReport } from './report-render.js';
import type { PublicationPayload } from './report-render.js';

export interface ReportPageRequest {
  reportId: string; page: number; guildId: string; channelId: string; messageId: string;
}
export interface ReputationReports {
  page(request: ReportPageRequest): Promise<PublicationPayload | null>;
  channelChanged(guildId: string, channelId: string): Promise<void>;
}

export function createReportNavigation(
  onChannelChanged: (guildId: string, channelId: string) => Promise<void> = async () => {},
  store: ReportStore = createReportStore(),
): ReputationReports {
  return {
    async page(request) {
      const report = await store.get(request.reportId);
      if (!report || report.status !== 'published' || report.guildId !== request.guildId ||
          report.channelId !== request.channelId || report.messageId !== request.messageId ||
          !Number.isSafeInteger(request.page) || request.page < 0 || request.page >= Math.max(1, Math.ceil(report.entryCount / 5))) return null;
      return renderReport(await store.snapshot(report.id, request.page));
    },
    channelChanged: onChannelChanged,
  };
}

export function createReportingRuntime(client: Client, guildId: string) {
  const transport = createDiscordPublications(client, guildId);
  const warnings = new OperationalWarnings({ guildId, transport, store: createWarningStore() });
  let deliveryHealthy: boolean | undefined;
  const publisher = new ReportPublisher({
    guildId, transport, store: createReportStore(), settings: createReportSettingsStore(),
    onHealth: (healthy, details) => {
      if (deliveryHealthy !== healthy) {
        if (!healthy) console.warn('Reputation report delivery is unavailable; pending reports will be retried.');
        else if (deliveryHealthy === false) console.log('Reputation report delivery recovered.');
        deliveryHealthy = healthy;
      }
      void warnings.setIssue('reports', !healthy, details);
    },
  });
  return {
    async start() { await warnings.start(); await publisher.start(); },
    publish: () => publisher.wake(),
    issue: (issue: WarningIssue, active: boolean, details?: readonly WarningDetail[]) => warnings.setIssue(issue, active, details),
    async channelChanged(channelId: string) {
      await warnings.channelChanged(channelId);
      await publisher.wake();
    },
    async stop() { await publisher.stop(); await warnings.stop(); },
  };
}
