import { MessageFlags } from 'discord.js';
import type { ButtonInteraction } from 'discord.js';
import type { ButtonHandler } from '../types.js';
import { shuffleButtons } from './shuffle.js';
import { reputationButtons } from './reputation.js';
import { handleReputationPage } from './reputation-report.js';
import { REPORT_PAGE_PREFIX } from '../reputation/report-render.js';
import { PENALTY_BUTTON_PREFIX, REWARD_BUTTON_PREFIX } from '../reputation/voice-poll-render.js';
import { handleVoicePoll } from './voice-poll.js';
import { MOVIE_BUTTON_PREFIX } from '../movies/render.js';
import { handleMovieRating } from './movie-rating.js';

// Register additional button groups here; the event dispatcher stays unchanged.
const handlers: ReadonlyMap<string, ButtonHandler> = new Map(Object.entries({
  ...shuffleButtons,
  ...reputationButtons,
}));

export async function handleButton(interaction: ButtonInteraction) {
  const handler = handlers.get(interaction.customId) ??
    (interaction.customId.startsWith(MOVIE_BUTTON_PREFIX) ? handleMovieRating :
      interaction.customId.startsWith(REPORT_PAGE_PREFIX) ? handleReputationPage :
      (interaction.customId.startsWith(PENALTY_BUTTON_PREFIX) || interaction.customId.startsWith(REWARD_BUTTON_PREFIX)) ? handleVoicePoll : undefined);
  if (!handler) {
    console.log(`Unhandled button interaction: ${interaction.customId}`);
    return;
  }
  try {
    return await handler(interaction);
  } catch {
    // Keep gateway listeners alive without logging driver/webhook credentials.
    console.error('Button interaction could not be completed.');
    const response = {
      content: '❌ Не вдалося підтвердити дію. Перевірте результат або спробуйте пізніше.',
      flags: MessageFlags.Ephemeral,
    } as const;
    try {
      if (interaction.replied || interaction.deferred) return await interaction.followUp(response);
      return await interaction.reply(response);
    } catch {
      console.warn('Could not deliver button interaction error feedback.');
    }
  }
}
