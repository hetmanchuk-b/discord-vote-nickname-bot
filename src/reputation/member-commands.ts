import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../types.js';
import { DELETION_CONFIRMATION_MS, DELETE_CANCEL_ID, DELETE_CONFIRM_ID, deletionConfirmations } from './deletion-confirmations.js';
import type { DeletionConfirmations } from './deletion-confirmations.js';

export type MemberCommand = 'balance' | 'today' | 'on' | 'off' | 'rules' | 'delete';
const definitions = {
  balance: ['reputation', 'Показати зараховану репутацію.'],
  today: ['voice-today', 'Показати сьогоднішній час у голосових каналах.'],
  on: ['reputation-on', 'Відновити власне відстеження репутації.'],
  off: ['reputation-off', 'Призупинити власне відстеження репутації.'],
  rules: ['reputation-rules', 'Показати правила голосової репутації лише вам.'],
  delete: ['reputation-delete', 'Видалити власні дані репутації після підтвердження.'],
} as const;

export function formatVoiceTime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 3600)} год ${Math.floor(seconds / 60) % 60} хв ${seconds % 60} с`;
}

function rulesEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎙 Правила голосової репутації')
    .addFields(
      { name: 'Як заробляти', value: '10 накопичених хвилин = 1 бал. Окремі відвідування протягом дня додаються. Наодинці, з вимкненим мікрофоном або звуком — повна ставка. Денних лімітів немає.' },
      { name: 'Що не враховується', value: 'Боти, AFK-канал сервера, Stage-канали, періоди особистої паузи та непідтверджений час під час збоїв.' },
      { name: 'Коли зараховуються бали', value: 'О 00:00 Europe/Kyiv за попередній календарний день. Неповні 10 хвилин відкидаються, а не переносяться. Після збою зарахування може бути відкладене.' },
      { name: 'Перевірка та керування', value: '`/reputation [user]` — зарахований баланс. `/voice-today [user]` — перевірений час і очікувані бали. `/reputation-off` та `/reputation-on` — пауза/відновлення без втрати попереднього прогресу. Відстеження типово увімкнене.' },
      { name: 'Видалення', value: '`/reputation-delete` потребує підтвердження протягом 60 секунд. Баланс і живі дані скидаються; облік вимикається до `/reputation-on`. Мінімальний запис про вимкнений облік, опубліковані звіти та наявні резервні копії залишаються. Відновлення починається з нуля.' },
    );
}

async function promptDeletion(interaction: ChatInputCommandInteraction, confirmations: DeletionConfirmations) {
  if (!interaction.guildId) return;
  const expiresAt = Date.now() + DELETION_CONFIRMATION_MS;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(DELETE_CONFIRM_ID).setLabel('Видалити').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(DELETE_CANCEL_ID).setLabel('Скасувати').setStyle(ButtonStyle.Secondary),
  );
  const message = await interaction.editReply({
    content: '⚠️ **Видалити ваші дані репутації?**\n' +
      'Баланс, накопичений час і живі щоденні результати буде видалено. Облік залишиться вимкненим до `/reputation-on`; відновлення почнеться з нуля.\n\n' +
      'Залишаться мінімальний запис про вимкнений облік, раніше опубліковані звіти та наявні резервні копії.\n' +
      `Підтвердження діє 60 секунд — до <t:${Math.floor(expiresAt / 1000)}:T>.`,
    components: [row], allowedMentions: { parse: [] },
  });
  confirmations.create({
    messageId: message.id, guildId: interaction.guildId, userId: interaction.user.id, expiresAt,
    onExpire: () => interaction.editReply({ content: '⌛ Підтвердження більше не діє. Запустіть `/reputation-delete` ще раз за потреби.', components: [] }),
  });
}

export function createMemberCommand(action: MemberCommand, confirmations = deletionConfirmations): Command {
  const [name, description] = definitions[action];
  const data = new SlashCommandBuilder().setName(name).setDescription(description).setDMPermission(false);
  if (action === 'balance' || action === 'today') {
    data.addUserOption(option => option.setName('user').setDescription('Чию статистику показати?'));
  }
  return {
    data,
    async execute(interaction) {
      if (!interaction.guildId) {
        return interaction.reply({ content: '❌ Команда доступна лише на сервері.', flags: MessageFlags.Ephemeral });
      }
      if (action === 'rules') {
        return interaction.reply({ embeds: [rulesEmbed()], flags: MessageFlags.Ephemeral });
      }
      const publicResponse = action === 'balance' || action === 'today';
      const target = publicResponse ? interaction.options.getUser('user') ?? interaction.user : interaction.user;
      if (target.bot) {
        return interaction.reply({ content: '❌ Боти не беруть участі в голосовій репутації.', flags: MessageFlags.Ephemeral });
      }
      if (publicResponse) await interaction.deferReply();
      else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        if (action === 'delete') return await promptDeletion(interaction, confirmations);
        const members = interaction.client.reputation;
        if (action === 'balance') {
          const balance = await members.getBalance(interaction.guildId, target.id);
          return await interaction.editReply({
            embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('🏅 Репутація')
              .setDescription(`<@${target.id}>\n**${balance.toLocaleString('uk-UA')}** балів`)
              .setFooter({ text: 'Зарахований баланс. Сьогоднішні очікувані бали ще не включено.' })],
            allowedMentions: { parse: [] },
          });
        }
        if (action === 'today') {
          const stats = await members.getToday(interaction.guildId, target.id);
          const warnings = [
            stats.incomplete ? '⚠️ Дані за день неповні: враховано лише перевірений час.' : '',
            !stats.trackingAvailable ? 'ℹ️ Збір часу зараз неактивний або тимчасово недоступний.' : '',
          ].filter(Boolean);
          return await interaction.editReply({
            embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle(`🎙 Голосова активність — ${stats.day}`)
              .setDescription([`<@${target.id}>`, ...warnings].join('\n'))
              .addFields(
                { name: 'Перевірений час', value: formatVoiceTime(stats.eligibleMs), inline: true },
                { name: 'Очікувано за сьогодні', value: `+${stats.pendingPoints} балів`, inline: true },
                { name: 'Особистий облік', value: stats.isTracking ? 'Tracking enabled' : 'Tracking paused' },
              ).setFooter({ text: 'Зарахування о 00:00 Europe/Kyiv. Неповні 10 хвилин не переносяться.' })],
            allowedMentions: { parse: [] },
          });
        }
        const enabled = action === 'on';
        const result = await members.setTracking(interaction.guildId, interaction.user.id, enabled);
        return await interaction.editReply({
          content: (enabled ? '✅ Облік увімкнено. Час паузи не зараховується заднім числом.' :
            '⏸️ Tracking paused. Попередній час і репутацію збережено; накопичені бали буде зараховано опівночі.') +
            (!result.trackingAvailable ? '\nℹ️ Налаштування збережено, але збір часу зараз неактивний або недоступний.' : ''),
          allowedMentions: { parse: [] },
        });
      } catch {
        console.error('Reputation member command could not be completed.');
        return interaction.editReply({
          content: '❌ Не вдалося підтвердити операцію. Перевірте статистику або повторіть спробу пізніше.',
          components: [], embeds: [], allowedMentions: { parse: [] },
        });
      }
    },
  };
}
