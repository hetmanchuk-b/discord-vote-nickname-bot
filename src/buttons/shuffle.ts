import { MessageFlags } from 'discord.js';
import type { ButtonInteraction } from 'discord.js';
import type { ButtonHandler, ShuffleSession } from '../types.js';
import { buildButtons, renderContent } from '../utils/shuffle-session.js';

type ShuffleHandler = (interaction: ButtonInteraction, state: ShuffleSession) => Promise<unknown>;

function withSession(handler: ShuffleHandler): ButtonHandler {
  return async interaction => {
    const state = interaction.client.shuffleSessions.get(interaction.message.id);
    if (!state) {
      return interaction.reply({
        content: '❌ Сесію не знайдено',
        flags: MessageFlags.Ephemeral,
      });
    }
    return handler(interaction, state);
  };
}

async function updateSelection(interaction: ButtonInteraction, state: ShuffleSession) {
  await interaction.update({
    content: renderContent(state.selectedVariants),
    components: buildButtons(state.selectedVariants.length, state.availableVariants.length),
  });
}

export const shuffleButtons = {
  'shuffle:roll': withSession(async (interaction, state) => {
    if (state.availableVariants.length === 0) {
      return interaction.reply({
        content: '❌ Варіанти закінчилися.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const weights = state.availableVariants.map(v => v.reactionCount + 1);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
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
    await updateSelection(interaction, state);
  }),

  'shuffle:remove': withSession(async (interaction, state) => {
    const variant = state.selectedVariants.pop();
    if (variant) {
      state.availableVariants.push(variant);
    }
    await updateSelection(interaction, state);
  }),

  'shuffle:create-poll': withSession(async (interaction, state) => {
    if (state.selectedVariants.length < 5) {
      return interaction.reply({
        content: '❌ Потрібно мінімум 5 варіантів',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!interaction.channel?.isSendable()) return;

    await interaction.channel.send({
      poll: {
        question: { text: '🏆 Оберіть найкращий варіант нікнейму' },
        answers: state.selectedVariants.map(variant => ({ text: variant.text })),
        allowMultiselect: false,
        duration: 24,
      },
    });

    interaction.client.shuffleSessions.delete(interaction.message.id);
    await interaction.update({
      content: renderContent(state.selectedVariants) + '\n\n ✅ Голосування створено',
      components: [],
    });
  }),
} satisfies Record<string, ButtonHandler>;
