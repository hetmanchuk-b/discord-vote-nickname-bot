import { ChannelType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types.js';
import { normalizeVoicePollReason, VOICE_POLL_REASON_LIMIT, VoicePollError } from './voice-poll-store.js';
import type { VoicePollKind } from './voice-poll-store.js';
import { VoicePollUserError } from './voice-poll-runtime.js';

export function voicePollFeedback(error: unknown): string {
  if (error instanceof VoicePollUserError) return error.publicMessage;
  if (error instanceof VoicePollError) {
    const messages = {
      'invalid-reason': `❌ Вкажіть непорожню причину до ${VOICE_POLL_REASON_LIMIT} символів.`,
      'not-participated': '❌ Адресат не має підтвердженої участі в обліку репутації або видалив свої дані.',
      'balance-floor': '❌ Баланс адресата вже досяг мінімуму −500.',
      'balance-ceiling': '❌ Баланс адресата вже досяг максимуму 5 000.',
      'active-poll': '❌ Для цього адресата вже є активне голосування.',
      invalid: '❌ Некоректне голосування, адресат або повідомлення.',
      expired: '⌛ Голосування вже завершилося. Голос не змінено.',
      'not-ready': '⌛ Голосування ще готується. Спробуйте за мить.',
      'not-due': '⌛ Голосування ще триває.',
    };
    return messages[error.code];
  }
  return '❌ Не вдалося підтвердити дію. Перевірте повідомлення голосування або спробуйте пізніше.';
}

export function createVoicePollCommand(kind: VoicePollKind): Command {
  const reward = kind === 'reward';
  return {
  data: new SlashCommandBuilder().setName(reward ? 'voice-reward' : 'voice-penalty')
    .setDescription(reward ? 'Запропонувати нагороду учаснику голосового каналу.' : 'Запропонувати штраф учаснику голосового каналу.').setDMPermission(false)
    .addUserOption(option=>option.setName('user').setDescription(reward ? 'Кому запропонувати нагороду?' : 'Кому запропонувати штраф?').setRequired(true))
    .addIntegerOption(option=>option.setName('amount').setDescription(reward ? 'Розмір нагороди.' : 'Розмір штрафу.').setRequired(true)
      .addChoices({name:'10',value:10},{name:'50',value:50},{name:'100',value:100}))
    .addStringOption(option=>option.setName('reason').setDescription('Причина штрафу або нагороди.')
      .setRequired(true).setMinLength(1).setMaxLength(VOICE_POLL_REASON_LIMIT)),
  cooldown: 0,
  async execute(interaction) {
    if (!interaction.guildId || !interaction.channel || ![ChannelType.GuildText,ChannelType.GuildVoice].includes(interaction.channel.type)) {
      return interaction.reply({content:'❌ Запустіть команду у звичайному текстовому або голосовому каналі сервера.',flags:MessageFlags.Ephemeral});
    }
    const target = interaction.options.getUser('user',true);
    if (target.bot || interaction.user.bot || target.id === interaction.user.id) {
      return interaction.reply({content:'❌ Не можна обирати ботів або самого себе.',flags:MessageFlags.Ephemeral});
    }
    await interaction.deferReply({flags:MessageFlags.Ephemeral});
    try {
      const poll = await interaction.client.voicePolls.create({guildId:interaction.guildId,textChannelId:interaction.channelId,
        initiatorId:interaction.user.id,targetId:target.id,kind,amount:interaction.options.getInteger('amount',true),
        proposalReason:normalizeVoicePollReason(interaction.options.getString('reason',true))});
      return interaction.editReply({content:`${poll.status === 'active' ? '✅ Голосування створено' : reward ? '⌛ Голосування скасовано без нагороди' : '⌛ Голосування скасовано без штрафу'}: https://discord.com/channels/${poll.guildId}/${poll.textChannelId}/${poll.messageId}`,allowedMentions:{parse:[]}});
    } catch (error) {
      return interaction.editReply({content:voicePollFeedback(error),allowedMentions:{parse:[]}});
    }
  },
  };
}

export const voicePenaltyCommand = createVoicePollCommand('penalty');
export const voiceRewardCommand = createVoicePollCommand('reward');
