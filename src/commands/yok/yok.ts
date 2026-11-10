import { SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../../types.js';

const data = new SlashCommandBuilder()
  .setName('yok')
  .setDescription('Оцінити в процентах')
  .addStringOption((option) =>
    option
      .setName('text')
      .setDescription('Що оцінити')
      .setRequired(true)
  )
  .addUserOption((option) =>
    option
      .setName('user')
      .setDescription('Кого оцінити')
      .setRequired(false)
  );

async function execute(interaction: ChatInputCommandInteraction) {
  const user =
    interaction.options.getUser('user') ?? interaction.user;

  const text = interaction.options.getString('text');
  const percent = Math.floor(Math.random() * 101);
  const barWidth = 20;
  const filled = Math.round((percent / 100) * barWidth);
  const progressBar = `[${'#'.repeat(filled)}${'-'.repeat(barWidth - filled)}]`;

  await interaction.reply({
    content: `${user} **${text}** на **${percent}%**\n\`${progressBar}\``,
  });
}

export default { data, execute } satisfies Command;