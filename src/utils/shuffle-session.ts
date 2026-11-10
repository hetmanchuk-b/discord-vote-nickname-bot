import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { Variant } from '../types.js';

export function buildButtons(selectedCount: number, availableCount: number) {
  const row = new ActionRowBuilder<ButtonBuilder>()

  if (availableCount && selectedCount < 10) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('shuffle:roll')
        .setLabel('🎲 Випадковий варіант')
        .setStyle(ButtonStyle.Primary)
    );
  }

  if (selectedCount > 0) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('shuffle:remove')
        .setLabel('↩ Прибрати останній')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  if (selectedCount >= 5) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('shuffle:create-poll')
        .setLabel('🗳 Створити голосування')
        .setStyle(ButtonStyle.Success)
    );
  }

  return [row];
}

export function renderContent(selectedVariants: Variant[]): string {
  return [
    '🎲 Випадкові варіанти',
    '',
    selectedVariants.length
      ? selectedVariants.map((v, i) => `${i + 1}. ${v.text} (${v.reactionCount} 👍)`).join('\n')
      : '_Поки що нічого не обрано_',
  ].join('\n');
}
