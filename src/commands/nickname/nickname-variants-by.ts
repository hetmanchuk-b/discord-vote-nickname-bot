import { SlashCommandBuilder, AttachmentBuilder, MessageFlags } from 'discord.js';
import fetchAllVariants from '../../utils/fetch-all-variants.js';
import groupMessages from '../../utils/group-messages.js';
import { MAX_VARIANTS_PER_USER } from '../../utils/constants.js';
import type { Command } from '../../types.js';

const data = new SlashCommandBuilder()
  .setName('nickname-variants-by')
  .setDescription('Показати варіанти по користувачах')

export default {
  data,
  async execute(interaction) {
    if (!interaction.isChatInputCommand()) return;

    if (!interaction.channel?.isThread()) {
      return interaction.reply({
        content: '❌ Команду можна використовувати тільки в гілках',
        flags: MessageFlags.Ephemeral
      })
    }

    await interaction.deferReply()

    try {
      const allMessages = await fetchAllVariants(interaction.channel)
      const grouped = groupMessages(allMessages)

      const output = [...grouped.entries()]
        .map(([user, variants]) => {
          return `${variants.length > MAX_VARIANTS_PER_USER ? '_дег._ ' : ''}**${user} (${variants.length})**: ${variants.join(', ')}`
        })
        .join('\n')
      
      if (output && output.length > 1900) {
        const attachment = new AttachmentBuilder(
          Buffer.from(output, 'utf-8'),
          { name: 'variants.txt' },
        )
        return interaction.editReply({
          content: "📄 Список варіантів файлом.",
          files: [attachment]
        })
      }

      await interaction.editReply(output || 'Варіанти не знайдено')
    } catch (error) {
      console.error(error)
      await interaction.editReply("❌ Помилка при отриманні варіантів.");
    }
  }
} satisfies Command;