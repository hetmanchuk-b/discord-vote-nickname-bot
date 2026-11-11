import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../types.js';
import { createReportSettingsStore } from '../../reputation/report-settings.js';
import type { ReportSettingsStore } from '../../reputation/report-settings.js';

const data = new SlashCommandBuilder()
  .setName('set-reputation-report')
  .setDescription('Налаштувати канал звітів і попереджень репутації.')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption(option => option
    .setName('id')
    .setDescription('ID текстового каналу цього сервера')
    .setRequired(true));

export function createSetReputationReportCommand(
  settings: ReportSettingsStore = createReportSettingsStore(),
): Command {
  return {
    data,
    async execute(interaction) {
      if (!interaction.guild) {
        return interaction.reply({
          content: '❌ Команда доступна лише на сервері.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: '❌ Потрібен дозвіл «Керувати сервером».',
          flags: MessageFlags.Ephemeral,
        });
      }

      const channelId = interaction.options.getString('id', true).trim();
      if (!/^\d{17,20}$/.test(channelId)) {
        return interaction.reply({
          content: '❌ Вкажіть коректний ID текстового каналу.',
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const channel = await interaction.guild.channels.fetch(channelId);
        if (!channel || channel.guildId !== interaction.guild.id || channel.type !== ChannelType.GuildText) {
          return interaction.editReply('❌ Оберіть звичайний текстовий канал цього сервера.');
        }

        const bot = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
        const permissions = channel.permissionsFor(bot);
        const required = [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ReadMessageHistory,
        ];
        if (!permissions?.has(required)) {
          return interaction.editReply(
            '❌ Боту потрібні дозволи переглядати канал, надсилати повідомлення, вбудовувати посилання та читати історію повідомлень.',
          );
        }

        await settings.setReportChannelId(interaction.guild.id, channel.id);
        await interaction.editReply(`✅ Канал звітів і попереджень репутації: <#${channel.id}>.`);
      } catch {
        // Do not log raw driver errors: connection strings can contain credentials.
        console.error('Could not configure the reputation report channel. Check channel access and database availability.');
        await interaction.editReply('❌ Не вдалося зберегти налаштування. Перевірте доступ до каналу та бази даних і повторіть спробу.');
      }
    },
  };
}

export default createSetReputationReportCommand();
