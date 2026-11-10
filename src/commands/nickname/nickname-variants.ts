import { SlashCommandBuilder, AttachmentBuilder, MessageFlags } from 'discord.js';
import fetchAllVariants from '../../utils/fetch-all-variants.js';
import type { Command } from '../../types.js';

const data = new SlashCommandBuilder()
  .setName("nickname-variants")
  .setDescription("Показати всі варіанти")

export default {
  data,
  async execute(interaction) {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.channel?.isThread()) {
      return interaction.reply({
        content: "❌ Команду можна використовувати тільки в гілках",
        flags: MessageFlags.Ephemeral
      })
    }
    await interaction.deferReply()

    try {
      const allMessages = await fetchAllVariants(interaction.channel)
      const output = allMessages.map(m => m.content).join('\n')

      if (output && output.length > 1900) {
        const attachment = new AttachmentBuilder(
          Buffer.from(output, 'utf-8'),
          { name: 'variants.txt' },
        )
        return interaction.editReply({
          content: "📄 Список занадто великий, тому додаю його файлом.",
          files: [attachment]
        })
      }

      await interaction.editReply(`Всі варіанти: \n${output}`)
    } catch (error) {
      console.error(error)
      await interaction.editReply('❌ Помилка при отриманні варіантів.')
    }

  }
} satisfies Command;