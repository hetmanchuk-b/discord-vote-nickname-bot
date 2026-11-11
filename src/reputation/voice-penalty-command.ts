import { ChannelType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types.js';
import { PenaltyError } from './voice-penalty-store.js';
import { PenaltyUserError } from './voice-penalty-runtime.js';

export function penaltyFeedback(error: unknown): string {
  if (error instanceof PenaltyUserError) return error.publicMessage;
  if (error instanceof PenaltyError) {
    const messages = {
      'not-participated': '❌ Адресат не має підтвердженої участі в обліку репутації або видалив свої дані.',
      'balance-floor': '❌ Баланс адресата вже досяг мінімуму −500.',
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

export const voicePenaltyCommand: Command = {
  data: new SlashCommandBuilder().setName('voice-penalty').setDescription('Запропонувати штраф учаснику голосового каналу.').setDMPermission(false)
    .addUserOption(option=>option.setName('user').setDescription('Кому запропонувати штраф?').setRequired(true))
    .addIntegerOption(option=>option.setName('amount').setDescription('Розмір штрафу.').setRequired(true)
      .addChoices({name:'10',value:10},{name:'50',value:50},{name:'100',value:100})),
  cooldown: 0,
  async execute(interaction) {
    if (!interaction.guildId || !interaction.channel || ![ChannelType.GuildText,ChannelType.GuildVoice].includes(interaction.channel.type)) {
      return interaction.reply({content:'❌ Запустіть команду у звичайному текстовому або голосовому каналі сервера.',flags:MessageFlags.Ephemeral});
    }
    const target = interaction.options.getUser('user',true);
    if (target.bot || interaction.user.bot || target.id === interaction.user.id) {
      return interaction.reply({content:'❌ Не можна штрафувати ботів або самого себе.',flags:MessageFlags.Ephemeral});
    }
    await interaction.deferReply({flags:MessageFlags.Ephemeral});
    try {
      const poll = await interaction.client.voicePenalties.create({guildId:interaction.guildId,textChannelId:interaction.channelId,
        initiatorId:interaction.user.id,targetId:target.id,amount:interaction.options.getInteger('amount',true)});
      return interaction.editReply({content:`${poll.status === 'active' ? '✅ Голосування створено' : '⌛ Голосування скасовано без штрафу'}: https://discord.com/channels/${poll.guildId}/${poll.textChannelId}/${poll.messageId}`,allowedMentions:{parse:[]}});
    } catch (error) {
      return interaction.editReply({content:penaltyFeedback(error),allowedMentions:{parse:[]}});
    }
  },
};
