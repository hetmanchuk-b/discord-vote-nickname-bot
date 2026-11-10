import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import type { ChatInputCommandInteraction, Message } from 'discord.js';
import type { Command } from '../../types.js';

const data = new SlashCommandBuilder()
  .setName('nickname-manage-result')
  .setDescription('Застосувати вибраний нікнейм')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames)

async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild || !interaction.channel?.isThread()) {
    return interaction.reply({
      content: "❌ Команду можна використовувати тільки в гілках",
    })
  }
  await interaction.deferReply()

  // Find first message
  try {
    await interaction.editReply('🏆 Шукаю перше повідомлення o(*≧▽≦)ツ┏━┓')
    const thread = interaction.channel
    const pinned = await thread.messages.fetchPins();

    const metadataMessage = pinned.items[0]?.message

    const targetUserId = metadataMessage?.content.match(/USER_ID:(\d+)/)?.[1];
    if (!targetUserId) return interaction.editReply('❌ Не знайдено користувача для зміни нікнейму.');

    await interaction.editReply('🏆 Шукаю голосування o(*￣▽￣*)ブ')
    // Find poll message
    let pollMessage: Message | null = null
    let before: string | undefined;

    while (true) {
      const fetched = await thread.messages.fetch({limit: 100, ...(before && { before })});
      if (fetched.size === 0) break;
      pollMessage = [...fetched.values()].find((message) => message.poll) ?? pollMessage;
      if (pollMessage) break;
      before = fetched.lastKey();
    }

    if (!pollMessage?.poll) {
      return interaction.editReply("❌ Голосування не знайдено.");
    }

    await interaction.editReply('🏆 Голосування знайдено (✿◡‿◡)')

    // End poll if still active
    if (!pollMessage.poll.resultsFinalized) {
      await pollMessage.poll.end()
    }

    // Refetch updated result
    const updatedPollMessage = await thread.messages.fetch({ message: pollMessage.id, force: true })
    if (!updatedPollMessage.poll) return interaction.editReply('❌ Голосування не знайдено.');
    const answers = Array.from(updatedPollMessage.poll.answers.values())

    const maxVotes = Math.max(...answers.map(answer => answer.voteCount));

    if (maxVotes === 0) {
      return interaction.editReply("❌ Ніхто не проголосував.");
    }

    await interaction.editReply('🏆 Визначаю переможця O(∩_∩)O')

    const winners = answers.filter(answer => answer.voteCount === maxVotes);

    // Draw
    if (winners.length > 1) {
      return interaction.editReply([
        "⚔ Нічия",
        "",
        ...winners.map(
          (winner) =>
            `• ${winner.text}`
        ),
      ].join("\n"))
    }

    const winningVariant = winners[0].text

    await interaction.editReply('🏆 Переможця визначено, застосовую нікнейм *(੭*ˊᵕˋ)੭*ଘ')

    // Apply nickname
    const member = await interaction.guild.members.fetch(targetUserId)

    if (member.id === interaction.guild.ownerId) {
      return interaction.editReply(
        `🏆 Переможець: **${winningVariant}**\n\n` +
        `👑 Це власник сервера. Discord не дозволяє боту змінювати його нікнейм.`
      )
    }

    if (!member.manageable) {
      return interaction.editReply(
        `🏆 Переможець: **${winningVariant}**\n\n❌ Не можу змінити нікнейм цього користувача через ієрархію ролей.`
      );
    }

    await member.setNickname(winningVariant, 'Nickname voting')

    await interaction.editReply(`🏆 Переможець: **${winningVariant}**\n\nНікнейм змінено для <@${targetUserId}>`)
  } catch (error) {
    console.error(error)
    await interaction.editReply("❌ Помилка при обробці результатів.")
  }
}

export default { data, execute } satisfies Command;