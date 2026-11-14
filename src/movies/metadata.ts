import { Buffer } from 'node:buffer';
import { MovieError } from './types.js';
import type { ExternalMovieRating, MovieMetadata } from './types.js';

export function imdbIdFromLink(input: string): string {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['imdb.com', 'www.imdb.com', 'm.imdb.com'].includes(url.hostname)) throw new Error();
    const match = /^\/title\/(tt\d{7,12})(?:\/|$)/i.exec(url.pathname);
    if (!match?.[1]) throw new Error();
    return match[1].toLowerCase();
  } catch { throw new MovieError('invalid-link'); }
}
export const imdbLink = (id: string) => `https://www.imdb.com/title/${id}/`;
function text(value: unknown, limit: number): string | null {
  if (typeof value !== 'string' || !value.trim() || value.trim() === 'N/A') return null;
  return value.trim().slice(0, limit);
}
export function moviePoster(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['m.media-amazon.com', 'ia.media-imdb.com', 'images-na.ssl-images-amazon.com'].includes(url.hostname) ||
      [...url.searchParams.keys()].some(key => /key|token|secret/i.test(key))) return null;
    return url.href;
  } catch { return null; }
}
export function externalMovieRatings(value: unknown): ExternalMovieRating[] {
  if (!Array.isArray(value)) return [];
  const names = new Map([['Internet Movie Database', 'IMDb'], ['Rotten Tomatoes', 'Rotten Tomatoes'], ['Metacritic', 'Metacritic'], ['IMDb', 'IMDb']]);
  const result = new Map<string, string>();
  for (const rating of value.slice(0, 10)) {
    if (!rating || typeof rating !== 'object') continue;
    const name = rating.Source ?? rating.source;
    const source = typeof name === 'string' ? names.get(name) : undefined;
    const score = text(rating.Value ?? rating.value, 24);
    if (source && score && /^\d{1,3}(?:\.\d{1,2})?(?:\/10|\/100|%)$/.test(score)) result.set(source, score);
  }
  return [...result].map(([source, score]) => ({ source, value: score })).slice(0, 3);
}
export function parseMovieMetadata(value: unknown, id: string): MovieMetadata {
  if (!value || typeof value !== 'object') throw new MovieError('invalid-response');
  const data = value as Record<string, unknown>;
  if (data.Response === 'False') {
    if (data.Error === 'Movie not found!') throw new MovieError('not-found');
    if (data.Error === 'Invalid API key!' || data.Error === 'No API key provided.') throw new MovieError('unconfigured');
    throw new MovieError('unavailable');
  }
  if (data.Response !== 'True' || data.imdbID !== id) throw new MovieError('invalid-response');
  if (data.Type !== 'movie') throw new MovieError('not-movie');
  const title = text(data.Title, 180);
  if (!title) throw new MovieError('invalid-response');
  const ratings = externalMovieRatings(data.Ratings);
  if (!ratings.some(rating => rating.source === 'IMDb') && typeof data.imdbRating === 'string' && /^\d{1,2}(?:\.\d)?$/.test(data.imdbRating)) {
    ratings.unshift({ source: 'IMDb', value: `${data.imdbRating}/10` });
  }
  return {
    imdbId: id, title, year: text(data.Year, 24), runtime: text(data.Runtime, 40), genres: text(data.Genre, 180),
    director: text(data.Director, 180), country: text(data.Country, 120), cast: text(data.Actors, 400),
    plot: text(data.Plot, 900), posterUrl: moviePoster(data.Poster), externalRatings: ratings.slice(0, 3),
  };
}
export interface MovieLookup { get(id: string): Promise<MovieMetadata> }
export function createMovieLookup(options: { apiKey?: () => string | undefined; fetch?: typeof fetch } = {}): MovieLookup {
  return {
    async get(id) {
      if (!/^tt\d{7,12}$/.test(id)) throw new MovieError('invalid-link');
      const key = (options.apiKey ? options.apiKey() : process.env.OMDB_API_KEY)?.trim();
      if (!key) throw new MovieError('unconfigured');
      try {
        // Never fetch the caller's URL or print a URL containing the API key.
        const url = new URL('https://www.omdbapi.com/');
        url.search = new URLSearchParams({ apikey: key, i: id, plot: 'short', r: 'json' }).toString();
        const response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(8_000), redirect: 'error' });
        if (!response.ok || !response.body || Number(response.headers.get('content-length') ?? 0) > 65536) {
          await response.body?.cancel().catch(() => {});
          throw new MovieError('unavailable');
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            const result = await reader.read();
            if (result.done) break;
            size += result.value.byteLength;
            if (size > 65536) { await reader.cancel(); throw new MovieError('invalid-response'); }
            chunks.push(result.value);
          }
        } finally { reader.releaseLock(); }
        return parseMovieMetadata(JSON.parse(Buffer.concat(chunks).toString('utf8')), id);
      } catch (error) {
        if (error instanceof MovieError) throw error;
        throw new MovieError('unavailable');
      }
    },
  };
}
