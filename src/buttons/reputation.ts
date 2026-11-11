import { MessageFlags } from 'discord.js';
import type { ButtonHandler } from '../types.js';
import { DELETE_CANCEL_ID, DELETE_CONFIRM_ID, deletionConfirmations } from '../reputation/deletion-confirmations.js';
import type { DeletionConfirmations } from '../reputation/deletion-confirmations.js';
import { PublicationPendingError } from '../reputation/report-errors.js';

export function createReputationButtons(confirmations: DeletionConfirmations = deletionConfirmations): Record<string, ButtonHandler> {
  function handler(confirm: boolean): ButtonHandler {
    return async interaction => {
      const guildId = interaction.guildId;
      const result = guildId ? confirmations.consume(
        interaction.message.id, guildId, interaction.user.id,
      ) : 'forbidden';
      if (!guildId || result !== 'confirmed') {
        return interaction.reply({
          content: result === 'forbidden' ? '❌ Це підтвердження не для вас.' :
            '⌛ Підтвердження вже використане або прострочене. Запустіть `/reputation-delete` ще раз.',
          flags: MessageFlags.Ephemeral,
        });
      }
      await interaction.deferUpdate();
      if (!confirm) {
        return interaction.editReply({ content: '✅ Видалення скасовано. Дані не змінено.', components: [] });
      }
      await interaction.editReply({ content: '⏳ Видаляю ваші дані репутації…', components: [] });
      try {
        // Session ownership is checked above; never accept a target user from customId.
        await interaction.client.reputation.deleteData(guildId, interaction.user.id);
        return await interaction.editReply({
          content: '✅ Живі дані репутації видалено. Баланс і накопичений час: 0. Tracking paused.\n' +
            'Для нового старту використайте `/reputation-on`. Мінімальний запис про вимкнений облік, опубліковані звіти, результати голосувань та резервні копії залишено.',
          components: [], allowedMentions: { parse: [] },
        });
      } catch (error) {
        if (error instanceof PublicationPendingError) return interaction.editReply({
          content: '⏳ Публікація звіту або результату голосування ще підтверджується. Дані не видалено; повторіть `/reputation-delete` після відновлення доставки.',
          components: [],
        });
        console.error('Could not confirm reputation data deletion.');
        return interaction.editReply({
          content: '❌ Не вдалося підтвердити видалення. Перевірте `/reputation` та `/voice-today` або повторіть `/reputation-delete`.',
          components: [],
        });
      }
    };
  }
  return { [DELETE_CONFIRM_ID]: handler(true), [DELETE_CANCEL_ID]: handler(false) };
}

export const reputationButtons = createReputationButtons();
