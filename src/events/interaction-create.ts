import { Events, MessageFlags, Collection } from 'discord.js';
import type { Interaction } from 'discord.js';
import { buildButtons, renderContent } from '../utils/shuffle-session.js';

async function execute(interaction: Interaction) {
  if (interaction.isChatInputCommand()) {
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
    if (previousTimestamp !== undefined) {
      const expirationTime = previousTimestamp + cooldownAmount;
      const expiredTimestamp = Math.round(expirationTime / 1_000);
      return interaction.reply({
        content: `Please wait, you are on a cooldown for \`${command.data.name}\`. You can use it again <t:${expiredTimestamp}:R>.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    timestamps.set(interaction.user.id, now);
    setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);

    try {
      // await interaction.deferReply();
      await command.execute(interaction)
    } catch (error) {
      console.error(error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: 'There was an error while executing this command!',
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: 'There was an error while executing this command!',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  } else if (interaction.isButton()) {
    switch (interaction.customId) {
      case 'shuffle:roll': {
        const state = interaction.client.shuffleSessions.get(interaction.message.id)
        if (!state) {
          return interaction.reply({
            content: '❌ Сесію не знайдено',
            flags: MessageFlags.Ephemeral
          })
        }

        if (state.availableVariants.length === 0) {
          return interaction.reply({
            content: '❌ Варіанти закінчилися.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const weights = state.availableVariants.map(
          v => v.reactionCount + 1
        );

        const totalWeight = weights.reduce(
          (sum, weight) => sum + weight,
          0
        );

        let random = Math.random() * totalWeight;

        let index = 0;

        for (let i = 0; i < weights.length; i++) {
          random -= weights[i];

          if (random < 0) {
            index = i;
            break;
          }
        }

        const [variant] = state.availableVariants.splice(index, 1);

        state.selectedVariants.push(variant);

        await interaction.update({
          content: renderContent(state.selectedVariants),
          components: buildButtons(state.selectedVariants.length, state.availableVariants.length),
        })

        break
      }
      case 'shuffle:remove': {
        const state = interaction.client.shuffleSessions.get(interaction.message.id)
        if (!state) {
          return interaction.reply({
            content: '❌ Сесію не знайдено',
            flags: MessageFlags.Ephemeral
          })
        }

        const variant = state.selectedVariants.pop()

        if (variant) {
          state.availableVariants.push(variant)
        }

        await interaction.update({
          content: renderContent(state.selectedVariants),
          components: buildButtons(state.selectedVariants.length, state.availableVariants.length),
        })

        break
      }
      case 'shuffle:create-poll': {
        const state = interaction.client.shuffleSessions.get(interaction.message.id)
        if (!state) {
          return interaction.reply({
            content: '❌ Сесію не знайдено',
            flags: MessageFlags.Ephemeral
          })
        }

        if (state.selectedVariants.length < 5) {
          return interaction.reply({
            content: '❌ Потрібно мінімум 5 варіантів',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (!interaction.channel?.isSendable()) return;

        await interaction.channel.send({
          poll: {
            question: {
              text: '🏆 Оберіть найкращий варіант нікнейму',
            },
            answers: state.selectedVariants.map((variant) => ({text: variant.text})),
            allowMultiselect: false,
            duration: 24
          }
        })

        interaction.client.shuffleSessions.delete(interaction.message.id)

        await interaction.update({
          content: renderContent(state.selectedVariants) + '\n\n ✅ Голосування створено',
          components: [],
        })

        break
      }
      default:
        console.log(`Unhandled button interaction: ${interaction.customId}`)
    }
  }
}

export default {
  name: Events.InteractionCreate as const,
  execute,
};