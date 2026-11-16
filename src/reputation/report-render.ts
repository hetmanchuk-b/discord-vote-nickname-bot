import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { MessageEditOptions } from 'discord.js';
import type { DailyReport, ReportSnapshot } from './report-store.js';
import { formatVoiceTime } from '../utils/format-voice-time.js';
import { formatPoints } from './point-units.js';
import { reportPageCount } from './report-pagination.js';

export const REPORT_PAGE_PREFIX = 'reputation:page:';
export type PublicationPayload = Pick<MessageEditOptions, 'content' | 'embeds' | 'components' | 'allowedMentions'>;
export const reportMarker = (id: string, published: boolean) => `REP:${id}:${published ? 'published' : 'pending'}`;

export function renderPlaceholder(report: DailyReport): PublicationPayload {
  return {
    content: '', embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle(`⏳ Репутація — ${report.day}`)
      .setDescription('Готую щоденний звіт…').setFooter({ text: reportMarker(report.id, false) })],
    components: [], allowedMentions: { parse: [] },
  };
}

export function renderReport({ report, entries, page }: ReportSnapshot, deliveryAt?: Date): PublicationPayload {
  const pages = reportPageCount(report);
  const detailed = (report.formatVersion ?? 1) >= 2;
  const signed = (points: number) => `${points > 0 ? '+' : ''}${formatPoints(points)}`;
  const description = [];
  if (report.incomplete) description.push('⚠️ Відстеження було неповним. Враховано лише перевірений час.');
  const confirmedAt = deliveryAt ?? report.publishedAt ?? report.preparedAt ?? report.createdAt;
  if (confirmedAt.getTime() - report.endedAt.getTime() > 5 * 60_000) {
    description.push('🕒 Доставка/підтвердження звіту із затримкою за вказаний календарний день.');
  }
  if (!report.entryCount) description.push(detailed ? 'Змін репутації за день немає.' : report.activityMs > 0n ? 'No reputation earned today' :
    report.incomplete ? 'No verified activity recorded' : 'No activity recorded');
  const total = detailed ? `**Зміна за день:** ${signed(report.pointsAwarded)} балів · **Учасників зі змінами:** ${report.entryCount}` :
    `**Зараховано:** ${formatPoints(report.pointsAwarded)} балів · **Учасників із балами:** ${report.entryCount}`;
  const embed = new EmbedBuilder().setColor(report.incomplete ? 0xFEE75C : 0x57F287)
    .setTitle(`🎙 Голосова репутація — ${report.day}`)
    .setDescription([...description, total].join('\n'))
    .setFooter({ text: `${reportMarker(report.id, true)} · Сторінка ${page + 1}/${pages} · Europe/Kyiv` });
  for (const entry of entries) {
    const lines = [`<@${entry.userId}> · ${formatVoiceTime(entry.eligibleMs)} · Баланс: **${formatPoints(entry.balanceAfter)}**`];
    if (entry.soloMs !== null && entry.soloMs > 0) lines.push(`Наодинці: **${entry.soloMs < 1000 ? 'менше 1 с' : formatVoiceTime(entry.soloMs)}**`);
    if (detailed) {
      if (entry.dailyPoints) lines.push(`${entry.dailyPoints < 0 ? 'Пропуск дня' : 'Час і відвідування'}: **${signed(entry.dailyPoints)}**`);
      if (entry.voteRewards) lines.push(`Голосування — нагороди: **+${formatPoints(entry.voteRewards)}** (опитувань: ${entry.rewardVoteCount})`);
      if (entry.votePenalties) lines.push(`Голосування — штрафи: **−${formatPoints(entry.votePenalties)}** (опитувань: ${entry.penaltyVoteCount})`);
    }
    embed.addFields({ name: `#${entry.position + 1} · ${detailed ? signed(entry.points) : `+${formatPoints(entry.points)}`} балів`, value: lines.join('\n') });
  }
  const components = pages > 1 ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${REPORT_PAGE_PREFIX}${report.id}:${Math.max(0, page - 1)}`)
      .setLabel('◀ Попередня').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`${REPORT_PAGE_PREFIX}${report.id}:${Math.min(pages - 1, page + 1)}`)
      .setLabel('Наступна ▶').setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1),
  )] : [];
  return { content: '', embeds: [embed], components, allowedMentions: { parse: [] } };
}
