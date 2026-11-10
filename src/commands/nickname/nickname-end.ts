import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import fetchAllVariantsWithReactions from '../../utils/fetch-all-variants-with-reactions.js';
import getUniqueVariants from '../../utils/get-unique-variants.js';
import { buildButtons, renderContent } from '../../utils/shuffle-session.js';
import type { Command } from '../../types.js';

const data = new SlashCommandBuilder()
  .setName('nickname-end')
  .setDescription('Дістати випадковий варіант')

async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.isChatInputCommand()) return

  if (!interaction.channel?.isThread()) {
    return interaction.reply({
      content: '❌ Команду можна використовувати тільки в гілках',
      flags: MessageFlags.Ephemeral
    })
  }

  await interaction.deferReply()

  try {
    const messages = await fetchAllVariantsWithReactions(interaction.channel)
    const variants = getUniqueVariants(messages)

    if (variants.length < 2) return interaction.editReply('❌ Потрібно щонайменше 2 варіанта.')

    const reply = await interaction.editReply({
      content: renderContent([]),
      components: buildButtons(0, variants.length)
    })

    interaction.client.shuffleSessions.set(reply.id, {
      availableVariants: [...variants],
      selectedVariants: [],
      threadId: interaction.channel.id,
    })

  } catch (error) {
    console.error(error)
    await interaction.editReply('❌ Помилка')
  }
}

export default { data, execute } satisfies Command;
