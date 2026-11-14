import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } from 'discord.js';
import type { MessageCreateOptions, MessageEditOptions } from 'discord.js';
import { imdbLink, moviePoster } from './metadata.js';
import type { MovieSnapshot } from './store.js';
import { movieReviewButtons } from './review-render.js';

export const MOVIE_BUTTON_PREFIX = 'movie:rate:';
export const movieMarker = (id: string) => `MOVIE:${id}:`;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export function parseMovieButton(value: string): { postId: string; score: number } | null {
  const match = new RegExp(`^movie:rate:(${uuid}):(10|[1-9])(?::(\\d{1,19}))?$`).exec(value);
  return match?.[1] && match[2] ? { postId: match[1], score: Number(match[2]) } : null;
}
// Hidden component metadata keeps bookkeeping IDs/revisions out of the visible card.
export function movieButtonRevision(value: string, postId: string): bigint | null {
  const parsed = parseMovieButton(value);
  const revision = value.split(':')[4];
  return parsed?.postId === postId && revision ? BigInt(revision) : null;
}
export type MoviePayload = Pick<MessageCreateOptions & MessageEditOptions, 'embeds' | 'components' | 'allowedMentions'>;
export function renderMoviePlaceholder(id: string): MoviePayload {
  return { embeds: [new EmbedBuilder().setColor(0xe6b35a).setDescription('🎬 Готую картку фільму…').setFooter({ text: `${movieMarker(id)}pending` })],
    components: [], allowedMentions: { parse: [] } };
}
const safe = (value: string) => escapeMarkdown(value);
function title(value: string): string {
  if (value.length <= 256) return value;
  return value.slice(0, 254).replace(/[\uD800-\uDBFF]$/, '') + '…';
}
export function renderMovie(snapshot: MovieSnapshot): MoviePayload {
  const movie = snapshot.metadata;
  const heading = title(`🎬 ${safe(movie.title)}${movie.year ? ` (${safe(movie.year)})` : ''}`);
  const details = [movie.runtime, movie.genres].filter((value): value is string => Boolean(value)).map(safe).join(' · ');
  const description = [details, movie.plot ? safe(movie.plot) : null, '[WPARTY](https://wparty.net/s/ds6p2p199fv)'].filter(Boolean).join('\n\n');
  const embed = new EmbedBuilder().setColor(0xe6b35a).setTitle(heading).setURL(imdbLink(movie.imdbId));
  if (description) embed.setDescription(description);
  const poster = moviePoster(movie.posterUrl);
  if (poster) embed.setThumbnail(poster);
  if (movie.director) embed.addFields({ name: 'Режисер', value: safe(movie.director), inline: true });
  if (movie.country) embed.addFields({ name: 'Країна', value: safe(movie.country), inline: true });
  if (movie.cast) embed.addFields({ name: 'У ролях', value: safe(movie.cast) });
  if (movie.externalRatings.length) embed.addFields({ name: 'Зовнішні оцінки',
    value: movie.externalRatings.map(rating => `${safe(rating.source)} **${safe(rating.value)}**`).join(' · ') });
  embed.addFields({ name: 'Оцінка нашої спільноти', value: snapshot.count && snapshot.average !== null ?
    `**${snapshot.average.toLocaleString('uk-UA', { maximumFractionDigits: 1 })}/10** · Оцінок: **${snapshot.count.toLocaleString('uk-UA')}**` : 'Оцінок ще немає. Будьте першими!' });
  embed.setFooter({ text: 'Одна оцінка на людину. Можна змінити.' });
  const components = [0, 5].map(offset => new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...Array.from({ length: 5 }, (_, index) => {
      const score = offset + index + 1;
      return new ButtonBuilder().setCustomId(`${MOVIE_BUTTON_PREFIX}${snapshot.post.id}:${score}:${snapshot.revision}`).setLabel(String(score)).setStyle(ButtonStyle.Secondary);
    }),
  ));
  components.push(movieReviewButtons(snapshot.post.id, snapshot.reviewCount ?? 0));
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}
