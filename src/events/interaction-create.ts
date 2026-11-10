import { Events } from 'discord.js';
import type { Interaction } from 'discord.js';
import { handleButton } from '../buttons/index.js';
import { handleChatInput } from '../interactions/chat-input.js';

async function execute(interaction: Interaction) {
  if (interaction.isChatInputCommand()) {
    return handleChatInput(interaction);
  }
  if (interaction.isButton()) {
    return handleButton(interaction);
  }
}

export default {
  name: Events.InteractionCreate as const,
  execute,
};
