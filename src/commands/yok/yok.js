const { SlashCommandBuilder } = require('discord.js');

const data = new SlashCommandBuilder()
  .setName('yok')
  .setDescription('Хто ти в процентах')
  .addStringOption((option) =>
    option
      .setName('text')
      .setDescription('Що оцінити')
      .setRequired(true)
  );

async function execute(interaction) {
  const text = interaction.options.getString('text');
  const percent = Math.floor(Math.random() * 101); // 0-100

  const phrases = [
    `Ти **${text}** на **${percent}%**`,
    `Вірогідність того, що ти **${text}** — **${percent}%**`,
  ];

  const result = phrases[Math.floor(Math.random() * phrases.length)];

  await interaction.reply({ content: result });
}

module.exports = { data, execute };