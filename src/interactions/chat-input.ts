import { Collection, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';

export async function handleChatInput(interaction: ChatInputCommandInteraction) {
  const command = interaction.client.commands.get(interaction.commandName);

  if (!command) {
    console.error(`No command matching ${interaction.commandName} was found.`);
    return;
  }

  const { cooldowns } = interaction.client;
  const timestamps = cooldowns.get(command.data.name) ?? new Collection<string, number>();
  cooldowns.set(command.data.name, timestamps);

  const now = Date.now();
  const defaultCooldownDuration = 3;
  const cooldownAmount = (command.cooldown ?? defaultCooldownDuration) * 1_000;

  const previousTimestamp = timestamps.get(interaction.user.id);
  if (cooldownAmount > 0 && previousTimestamp !== undefined) {
    const expirationTime = previousTimestamp + cooldownAmount;
    const expiredTimestamp = Math.round(expirationTime / 1_000);
    return interaction.reply({
      content: `Please wait, you are on a cooldown for \`${command.data.name}\`. You can use it again <t:${expiredTimestamp}:R>.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (cooldownAmount > 0) {
    timestamps.set(interaction.user.id, now);
    setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    const response = {
      content: 'There was an error while executing this command!',
      flags: MessageFlags.Ephemeral,
    } as const;
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(response);
    } else {
      await interaction.reply(response);
    }
  }
}
