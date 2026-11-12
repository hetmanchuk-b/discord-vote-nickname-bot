import { Buffer } from 'node:buffer';
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } from 'discord.js';
import type { MessageEditOptions } from 'discord.js';
import type { VoicePoll } from './voice-poll-store.js';

// Existing Discord identifiers are public protocol, not internal type names.
export const PENALTY_BUTTON_PREFIX = 'voice-penalty:';
export const REWARD_BUTTON_PREFIX = 'voice-reward:';
export const voicePollMarker = (id: string, final: boolean) => `VP:${id}:${final ? 'final' : 'active'}`;
export type VoicePollPayload = Pick<MessageEditOptions, 'content' | 'embeds' | 'components' | 'allowedMentions' | 'attachments' | 'files'>;

export function renderVoicePoll(poll: VoicePoll): VoicePollPayload {
  const active = poll.status === 'active' || poll.status === 'creating';
  const reward = poll.kind === 'reward';
  const action = reward ? 'Нагороду' : 'Штраф';
  const prefix = reward ? REWARD_BUTTON_PREFIX : PENALTY_BUTTON_PREFIX;
  let description: string;
  let files: AttachmentBuilder[] = [];
  if (active) {
    const timing = poll.endsAt ? `Завершення: <t:${Math.floor(poll.endsAt.getTime()/1000)}:T>.` :
      'Голосування триває **120 секунд** від часу публікації цього повідомлення.';
    description = `<@${poll.initiatorId}> пропонує ${reward ? 'нагороду' : 'штраф'} **${poll.amount}** балів для <@${poll.targetId}>.\n` +
      `Голосують люди в <#${poll.voiceChannelId}>; присутність перевіряється наприкінці.\n` +
      `**Так** — за ${reward ? 'нагороду' : 'штраф'}; **Ні** — проти. Вибір можна змінити. Сам адресат не голосує.\n` +
      'У разі невдачі буде оприлюднено лише тих, чиї голоси «Ні» зараховано.\n' +
      timing;
  } else if (poll.status === 'succeeded') {
    description = `<@${poll.targetId}> ${reward ? 'отримав' : 'втратив'} **${poll.appliedAmount}** балів репутації.`;
  } else if (poll.status === 'failed') {
    description = `Не вдалося досягти одностайності щодо ${reward ? 'нагороди' : 'штрафу'} для <@${poll.targetId}>.`;
    if (poll.noVoterIds.length) description += `\n**Проголосували «Ні»:** ${poll.noVoterIds.slice(0,60).map(id=>`<@${id}>`).join(', ')}`;
    if (poll.noVoterIds.length > 60) {
      description += '\nПовний список — у файлі.';
      files = [new AttachmentBuilder(Buffer.from(poll.noVoterIds.join('\n'),'utf8'), { name: reward ? 'voice-reward-no-voters.txt' : 'voice-penalty-no-voters.txt' })];
    }
  } else {
    description = poll.reason === 'target-erased' || poll.reason === 'target-untracked' ?
      `${action} скасовано: дані репутації адресата видалено або участь більше не підтверджена.` :
      poll.reason === 'balance-floor' ? 'Штраф скасовано: баланс адресата вже досяг мінімуму −500.' :
      poll.reason === 'balance-ceiling' ? 'Нагороду скасовано: баланс адресата вже досяг максимуму 5 000.' :
      `${action} скасовано: не вдалося надійно перевірити голосування та присутність у встановлений час.`;
  }
  if ((active || poll.status === 'succeeded') && poll.proposalReason) {
    description += `\n\n**Причина:** ${escapeMarkdown(poll.proposalReason)}`;
  }
  return {
    content: '', allowedMentions: { parse: [] }, attachments: [], files,
    embeds: [new EmbedBuilder().setColor(active ? 0xFEE75C : poll.status === 'succeeded' ? reward ? 0x57F287 : 0xED4245 : 0x5865F2)
      .setDescription(description).setFooter({ text: voicePollMarker(poll.id,!active) })],
    components: active ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${prefix}${poll.id}:yes`).setLabel('Так').setStyle(reward ? ButtonStyle.Success : ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`${prefix}${poll.id}:no`).setLabel('Ні').setStyle(ButtonStyle.Secondary),
    )] : [],
  };
}
