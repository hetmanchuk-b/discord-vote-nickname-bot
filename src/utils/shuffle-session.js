const {ActionRowBuilder, ButtonBuilder, ButtonStyle} = require('discord.js')

function buildButtons(selectedCount) {
  const row = new ActionRowBuilder()

  row.addComponents(
    new ButtonBuilder()
      .setCustomId('shuffle:roll')
      .setLabel('🎲 Випадковий варіант')
      .setStyle(ButtonStyle.Primary)
  );

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

function renderContent(selectedVariants) {
  return [
    '🎲 Випадкові варіанти',
    '',
    selectedVariants.length
      ? selectedVariants.map((v, i) => `${i + 1}. ${v}`).join('\n')
      : '_Поки що нічого не обрано_',
  ].join('\n');
}

module.exports = {
  buildButtons,
  renderContent,
};