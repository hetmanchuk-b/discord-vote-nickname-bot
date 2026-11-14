import { Events } from 'discord.js';
import type { Interaction } from 'discord.js';
import { handleButton } from '../buttons/index.js';
import { handleChatInput } from '../interactions/chat-input.js';
import { handleMovieReviewSubmit } from '../interactions/movie-review.js';

async function execute(interaction: Interaction) {
  if (interaction.isChatInputCommand()) {
    return handleChatInput(interaction);
  }
  if (interaction.isButton()) {
    return handleButton(interaction);
  }
  if (interaction.isModalSubmit?.()) {
    return handleMovieReviewSubmit(interaction);
  }
}

export default {
  name: Events.InteractionCreate as const,
  execute,
};
