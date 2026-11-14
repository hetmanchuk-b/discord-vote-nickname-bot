import { MessageFlags } from 'discord.js';
import type { ButtonInteraction, ModalSubmitInteraction, InteractionReplyOptions } from 'discord.js';
import { parseMovieReviewAction, parseMovieReviewSubmit, renderMovieReviewForm, renderMovieReviewPage, MOVIE_REVIEW_PREFIX } from '../movies/review-render.js';
import { MovieError, movieFeedback } from '../movies/types.js';

async function editorDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new MovieError('unavailable')), 1800);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
// Main-card controls always reply privately. Only already-ephemeral pages may be edited.
export async function handleMovieReviewButton(interaction: ButtonInteraction): Promise<unknown> {
  let acknowledged = false;
  try {
    const action = parseMovieReviewAction(interaction.customId);
    if (!action || !interaction.guildId || interaction.user.bot) throw new MovieError('invalid-review');
    const privateAction = action.action === 'edit' || action.action === 'page' || action.action === 'show';
    if (privateAction && !interaction.message.flags.has(MessageFlags.Ephemeral)) throw new MovieError('invalid-review');
    const context = { postId: action.postId, guildId: interaction.guildId, channelId: interaction.channelId,
      messageId: 'messageId' in action ? action.messageId : interaction.message.id, userId: interaction.user.id };
    if (action.action === 'write' || action.action === 'edit') {
      // Modals cannot follow deferReply; bound this read so the initial response is timely.
      const editor = await editorDeadline(interaction.client.movies.reviewEditor(context));
      return await interaction.showModal(renderMovieReviewForm(context, editor));
    }
    if (privateAction) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    acknowledged = true;
    const data = await interaction.client.movies.reviewPage(context, action.action === 'page' ? action.page : 0, action.action === 'show' ? action.version : undefined);
    return await interaction.editReply(renderMovieReviewPage(context, data));
  } catch (error) {
    try {
      const response = { content: movieFeedback(error), allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral } satisfies InteractionReplyOptions;
      if (acknowledged || interaction.deferred || interaction.replied) return await interaction.followUp(response);
      return await interaction.reply(response);
    } catch { console.warn('Could not deliver movie review feedback.'); }
  }
}
export async function handleMovieReviewSubmit(interaction: ModalSubmitInteraction): Promise<unknown> {
  if (!interaction.customId.startsWith(MOVIE_REVIEW_PREFIX)) return;
  let acknowledged = false;
  try {
    const parsed = parseMovieReviewSubmit(interaction.customId);
    if (!parsed || !interaction.guildId || !interaction.channelId || interaction.user.bot) throw new MovieError('invalid-review');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }); acknowledged = true;
    const result = await interaction.client.movies.writeReview({ ...parsed, guildId: interaction.guildId, channelId: interaction.channelId,
      userId: interaction.user.id, interactionId: interaction.id, text: interaction.fields.getTextInputValue('review'),
      containsSpoilers: interaction.fields.getCheckbox('spoilers'),
      delete: interaction.fields.fields.has('delete') && interaction.fields.getCheckbox('delete') });
    const content = result === 'deleted' ? '🗑️ Ваш відгук видалено. Оцінку фільму не змінено.' : result === 'saved' ?
      '✅ Відгук збережено. Його можуть прочитати учасники сервера.' : '⌛ Запит уже враховано або відгук змінено. Відкрийте його знову.';
    return await interaction.editReply({ content, allowedMentions: { parse: [] } });
  } catch (error) {
    try {
      const response = { content: movieFeedback(error), allowedMentions: { parse: [] } };
      if (acknowledged || interaction.deferred || interaction.replied) return await interaction.editReply(response);
      return await interaction.reply({ ...response, flags: MessageFlags.Ephemeral });
    } catch { console.warn('Could not deliver movie review submission feedback.'); }
  }
}
