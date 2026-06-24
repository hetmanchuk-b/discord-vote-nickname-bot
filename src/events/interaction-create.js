const { Events, MessageFlags, Collection} = require('discord.js');

const {buildButtons, renderContent} = require('../utils/shuffle-session.js');

async function execute(interaction) {
  if (interaction.isChatInputCommand()) {
    const command = interaction.client.commands.get(interaction.commandName);

    if (!command) {
      console.error(`No command matching ${interaction.commandName} was found.`);
      return;
    }

    const { cooldowns } = interaction.client;

    if (!cooldowns.has(command.data.name)) {
      cooldowns.set(command.data.name, new Collection());
    }

    const now = Date.now();
    const timestamps = cooldowns.get(command.data.name);
    const defaultCooldownDuration = 3;
    const cooldownAmount = (command.cooldown ?? defaultCooldownDuration) * 1_000;

    if (timestamps.has(interaction.user.id)) {
      const expirationTime = timestamps.get(interaction.user.id) + cooldownAmount;
      const expiredTimestamp = Math.round(expirationTime / 1_000);
      return interaction.reply({
        content: `Please wait, you are on a cooldown for \`${command.data.name}\`. You can use it again <t:${expiredTimestamp}:R>.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    timestamps.set(interaction.user.id, now);
    setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);

    try {
      await command.execute(interaction);
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

        const index = Math.floor(Math.random() * state.availableVariants.length)
        const [variant] = state.availableVariants.splice(index, 1)

        state.selectedVariants.push(variant)

        await interaction.update({
          content: renderContent(state.selectedVariants),
          components: buildButtons(state.selectedVariants.length),
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
          components: buildButtons(state.selectedVariants.length),
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
            ephemeral: true,
          });
        }

        await interaction.channel.send({
          poll: {
            question: {
              text: '🏆 Оберіть найкращий варіант нікнейму',
            },
            answers: state.selectedVariants.map((variant) => ({text: variant})),
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

module.exports = {
  name: Events.InteractionCreate,
  execute,
};