export type ExternalMovieRating = { source: string; value: string };
export interface MovieMetadata {
  imdbId: string;
  title: string;
  year: string | null;
  runtime: string | null;
  genres: string | null;
  director: string | null;
  country: string | null;
  cast: string | null;
  plot: string | null;
  posterUrl: string | null;
  externalRatings: ExternalMovieRating[];
}
export type MovieErrorCode = 'invalid-link' | 'not-movie' | 'not-found' | 'unconfigured' | 'unavailable' |
  'invalid-response' | 'invalid-vote' | 'post-missing' | 'permissions' | 'invalid-destination' | 'stopped' | 'invalid-review' | 'review-changed';
export class MovieError extends Error {
  constructor(readonly code: MovieErrorCode) { super('Movie operation could not be completed.'); }
}
export function movieFeedback(error: unknown): string {
  const messages: Record<MovieErrorCode, string> = {
    'invalid-link': '❌ Вкажіть посилання IMDb на фільм: https://www.imdb.com/title/tt…/',
    'not-movie': '❌ Це не фільм. Серіали та окремі епізоди поки не підтримуються.',
    'not-found': '❌ Фільм не знайдено в OMDb.',
    unconfigured: '❌ Фільми тимчасово недоступні. Потрібно перевірити налаштування бази даних та OMDb.',
    unavailable: '❌ Не вдалося отримати дані фільму. Спробуйте пізніше.',
    'invalid-response': '❌ Сервіс фільмів повернув некоректні дані. Спробуйте пізніше.',
    'invalid-vote': '❌ Некоректна оцінка або повідомлення фільму.',
    'post-missing': '❌ Це повідомлення фільму більше не доступне.',
    permissions: '❌ Боту потрібні View Channel, Send Messages, Embed Links та Read Message History.',
    'invalid-destination': '❌ Запустіть команду у звичайному текстовому або голосовому каналі сервера.',
    stopped: '⌛ Бот завершує роботу. Спробуйте пізніше.',
    'invalid-review': '❌ Напишіть відгук до 1000 символів або явно оберіть його видалення.',
    'review-changed': '⌛ Відгук уже змінено або видалено. Відкрийте його знову, щоб не перезаписати нові дані.',
  };
  return error instanceof MovieError ? messages[error.code] : '❌ Не вдалося підтвердити дію з фільмом. Спробуйте пізніше.';
}
