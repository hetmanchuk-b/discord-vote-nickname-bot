import { Buffer } from 'node:buffer';
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { MessageEditOptions } from 'discord.js';
import type { PenaltyPoll } from './voice-penalty-store.js';

export const PENALTY_BUTTON_PREFIX = 'voice-penalty:';
export const penaltyMarker = (id: string, final: boolean) => `VP:${id}:${final ? 'final' : 'active'}`;
export type PenaltyPayload = Pick<MessageEditOptions, 'content' | 'embeds' | 'components' | 'allowedMentions' | 'attachments' | 'files'>;

export function renderPenalty(poll: PenaltyPoll): PenaltyPayload {
  const active = poll.status === 'active' || poll.status === 'creating';
  let description: string;
  let files: AttachmentBuilder[] = [];
  if (active) {
    const timing = poll.endsAt ? `Завершення: <t:${Math.floor(poll.endsAt.getTime()/1000)}:T>.` :
      'Голосування триває **120 секунд** від часу публікації цього повідомлення.';
    description = `<@${poll.initiatorId}> пропонує штраф **${poll.amount}** балів для <@${poll.targetId}>.\n` +
      `Голосують люди в <#${poll.voiceChannelId}>; присутність перевіряється наприкінці.\n` +
      `**Так** — за штраф; **Ні** — проти. Вибір можна змінити. Сам адресат не голосує.\n` +
      'У разі невдачі буде оприлюднено лише тих, чиї голоси «Ні» зараховано.\n' +
      timing;
  } else if (poll.status === 'succeeded') {
    description = `<@${poll.targetId}> втратив **${poll.actualFine}** балів репутації.`;
  } else if (poll.status === 'failed') {
    description = `Не вдалося досягти одностайності щодо штрафу для <@${poll.targetId}>.`;
    if (poll.noVoterIds.length) description += `\n**Проголосували «Ні»:** ${poll.noVoterIds.slice(0,60).map(id=>`<@${id}>`).join(', ')}`;
    if (poll.noVoterIds.length > 60) {
      description += '\nПовний список — у файлі.';
      files = [new AttachmentBuilder(Buffer.from(poll.noVoterIds.join('\n'),'utf8'), { name: 'voice-penalty-no-voters.txt' })];
    }
  } else {
    description = poll.reason === 'target-erased' || poll.reason === 'target-untracked' ?
      'Штраф скасовано: дані репутації адресата видалено або участь більше не підтверджена.' :
      poll.reason === 'balance-floor' ? 'Штраф скасовано: баланс адресата вже досяг мінімуму −500.' :
      'Штраф скасовано: не вдалося надійно перевірити голосування та присутність у встановлений час.';
  }
  return {
    content: '', allowedMentions: { parse: [] }, attachments: [], files,
    embeds: [new EmbedBuilder().setColor(active ? 0xFEE75C : poll.status === 'succeeded' ? 0xED4245 : 0x5865F2)
      .setDescription(description).setFooter({ text: penaltyMarker(poll.id,!active) })],
    components: active ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${PENALTY_BUTTON_PREFIX}${poll.id}:yes`).setLabel('Так').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`${PENALTY_BUTTON_PREFIX}${poll.id}:no`).setLabel('Ні').setStyle(ButtonStyle.Secondary),
    )] : [],
  };
}
