import { ActionRowBuilder, ButtonBuilder, ButtonStyle, CheckboxBuilder, EmbedBuilder, LabelBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, escapeMarkdown } from 'discord.js';
import { imdbLink } from './metadata.js';
import { MOVIE_REVIEW_LIMIT } from './review-store.js';
import type { MovieReviewContext, MovieReviewEditor, MovieReviewPage } from './review-store.js';
import type { MoviePayload } from './render.js';

export const MOVIE_REVIEW_PREFIX = 'movie:review:';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export type MovieReviewAction = { action: 'write' | 'read'; postId: string } |
  { action: 'edit'; postId: string; messageId: string } |
  { action: 'page'; postId: string; messageId: string; page: number } |
  { action: 'show'; postId: string; messageId: string; version: string };
export function parseMovieReviewAction(value: string): MovieReviewAction | null {
  let match = new RegExp(`^movie:review:(write|read):(${uuid})$`).exec(value);
  if (match?.[2] && (match[1] === 'write' || match[1] === 'read')) return { action: match[1], postId: match[2] };
  match = new RegExp(`^movie:review:(edit|page|show):(${uuid}):(\\d{17,20})(?::(\\d{1,20}))?$`).exec(value);
  if (!match?.[2] || !match[3]) return null;
  const base = { postId: match[2], messageId: match[3] };
  if (match[1] === 'edit' && !match[4]) return { action: 'edit', ...base };
  if (match[1] === 'page' && match[4] && Number(match[4]) <= 1_000_000) return { action: 'page', ...base, page: Number(match[4]) };
  if (match[1] === 'show' && match[4] && /^\d{17,20}$/.test(match[4])) return { action: 'show', ...base, version: match[4] };
  return null;
}
export function parseMovieReviewSubmit(value: string): { postId: string; messageId: string; baseVersion: string } | null {
  const match = new RegExp(`^movie:review:save:(${uuid}):(\\d{17,20}):(0|\\d{17,20})$`).exec(value);
  return match?.[1] && match[2] && match[3] ? { postId: match[1], messageId: match[2], baseVersion: match[3] } : null;
}
export function movieReviewButtons(postId: string, count: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${MOVIE_REVIEW_PREFIX}write:${postId}`).setLabel('Написати / змінити відгук').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${MOVIE_REVIEW_PREFIX}read:${postId}`).setLabel(`Відгуки (${count})`).setStyle(ButtonStyle.Secondary),
  );
}
export function renderMovieReviewForm(context: MovieReviewContext, editor: MovieReviewEditor): ModalBuilder {
  const text = new TextInputBuilder().setCustomId('review').setStyle(TextInputStyle.Paragraph)
    .setMaxLength(MOVIE_REVIEW_LIMIT).setRequired(false).setPlaceholder('Враження → що сподобалось → що ні → кому радите.');
  if (editor.text) text.setValue(editor.text);
  const modal = new ModalBuilder().setCustomId(`${MOVIE_REVIEW_PREFIX}save:${context.postId}:${context.messageId}:${editor.version}`)
    .setTitle('Відгук про фільм').addLabelComponents(
      new LabelBuilder().setLabel('Ваш відгук · до 1000 символів').setDescription('Автор і наявна оцінка будуть видимі учасникам сервера. 3–5 речень, не переказ сюжету.').setTextInputComponent(text),
      new LabelBuilder().setLabel('Містить спойлери').setDescription('Текст відкриється лише після окремого підтвердження читача.')
        .setCheckboxComponent(new CheckboxBuilder().setCustomId('spoilers').setDefault(editor.containsSpoilers)),
    );
  if (editor.text !== null) modal.addLabelComponents(
    new LabelBuilder().setLabel('Видалити мій відгук').setDescription('Увімкніть і надішліть форму для видалення. Ваша оцінка 1–10 залишиться.')
      .setCheckboxComponent(new CheckboxBuilder().setCustomId('delete').setDefault(false)),
  );
  return modal;
}
export function renderMovieReviewPage(context: MovieReviewContext, data: MovieReviewPage): MoviePayload {
  const embed = new EmbedBuilder().setColor(0xe6b35a).setTitle(`Відгуки · ${escapeMarkdown(data.title)}`.slice(0, 256)).setURL(imdbLink(data.imdbId));
  const review = data.review;
  if (!review) embed.setDescription('Відгуків ще немає. Напишіть перший!');
  else {
    embed.setDescription(review.containsSpoilers && !data.revealed ? '⚠️ Відгук містить спойлери. Відкрийте текст, лише якщо готові їх прочитати.' : escapeMarkdown(review.text, { maskedLink: true }));
    embed.addFields({ name: 'Автор', value: `<@${review.userId}>`, inline: true },
      { name: 'Оцінка автора', value: review.score === null ? 'Без оцінки' : `${review.score}/10`, inline: true });
    embed.setFooter({ text: `${data.page + 1}/${data.count} · Оновлено ${review.updatedAt.toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' })}` });
  }
  const source = `${context.postId}:${context.messageId}`;
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (data.count > 1) components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${MOVIE_REVIEW_PREFIX}page:${source}:${Math.max(0, data.page - 1)}`).setLabel('← Назад').setStyle(ButtonStyle.Secondary).setDisabled(data.page === 0),
    new ButtonBuilder().setCustomId(`${MOVIE_REVIEW_PREFIX}page:${source}:${data.page + 1}`).setLabel('Далі →').setStyle(ButtonStyle.Secondary).setDisabled(data.page >= data.count - 1),
  ));
  if (review?.containsSpoilers && !data.revealed) components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${MOVIE_REVIEW_PREFIX}show:${source}:${review.version}`).setLabel('Показати спойлери').setStyle(ButtonStyle.Danger),
  ));
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${MOVIE_REVIEW_PREFIX}edit:${source}`).setLabel('Мій відгук: написати / змінити / видалити').setStyle(ButtonStyle.Secondary),
  ));
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}
