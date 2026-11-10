import type { ButtonInteraction } from 'discord.js';
import type { ButtonHandler } from '../types.js';
import { shuffleButtons } from './shuffle.js';

// Register additional button groups here; the event dispatcher stays unchanged.
const handlers: ReadonlyMap<string, ButtonHandler> = new Map(Object.entries({
  ...shuffleButtons,
}));

export async function handleButton(interaction: ButtonInteraction) {
  const handler = handlers.get(interaction.customId);
  if (!handler) {
    console.log(`Unhandled button interaction: ${interaction.customId}`);
    return;
  }
  return handler(interaction);
}
