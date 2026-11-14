import { getReputationDatabase } from '../reputation/database.js';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { MovieError } from './types.js';

export const MOVIE_REVIEW_LIMIT = 1000;
export interface MovieReviewContext { postId: string; guildId: string; channelId: string; messageId: string; userId: string }
export interface MovieReviewEditor { text: string | null; containsSpoilers: boolean; version: string }
export interface MovieReviewWrite extends MovieReviewContext {
  text: string; containsSpoilers: boolean; delete: boolean; baseVersion: string; interactionId: string;
}
export interface MovieReviewPage {
  title: string; imdbId: string; page: number; count: number;
  review: { userId: string; text: string; containsSpoilers: boolean; version: string; score: number | null; updatedAt: Date } | null;
  revealed: boolean;
}
export function normalizeMovieReview(value: string): string {
  if (typeof value !== 'string') throw new MovieError('invalid-review');
  const text = value.trim();
  if (!text || text.length > MOVIE_REVIEW_LIMIT || text.includes('\0')) throw new MovieError('invalid-review');
  return text;
}
const snowflake = (id: string) => /^\d{17,20}$/.test(id);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function createMovieReviewStore(getDatabase: () => PrismaClient = getReputationDatabase) {
  async function withMovie<T>(context: MovieReviewContext, work: (tx: Prisma.TransactionClient, movieId: string) => Promise<T>): Promise<T> {
    if (!uuid.test(context.postId) || ![context.guildId, context.channelId, context.messageId, context.userId].every(snowflake)) throw new MovieError('invalid-vote');
    return getDatabase().$transaction(async tx => {
      const initial = await tx.moviePost.findUnique({ where: { id: context.postId } });
      if (!initial) throw new MovieError('post-missing');
      // Shared with score writes/snapshots: counts, text versions and scores stay consistent.
      await tx.$queryRaw`SELECT id FROM movies WHERE id = ${initial.movieId}::uuid FOR UPDATE`;
      const post = await tx.moviePost.findUniqueOrThrow({ where: { id: context.postId }, include: { movie: true } });
      if (post.status !== 'active' || post.movie.guildId !== context.guildId || post.channelId !== context.channelId || post.messageId !== context.messageId) throw new MovieError('invalid-vote');
      return work(tx, post.movieId);
    });
  }
  return {
    editor(context: MovieReviewContext): Promise<MovieReviewEditor> {
      return withMovie(context, async (tx, movieId) => {
        const review = await tx.movieReview.findUnique({ where: { movieId_userId: { movieId, userId: context.userId } } });
        return { text: review?.text ?? null, containsSpoilers: review?.containsSpoilers ?? false, version: review?.interactionId ?? '0' };
      });
    },
    async write(request: MovieReviewWrite): Promise<'saved' | 'deleted' | 'unchanged'> {
      if (!snowflake(request.interactionId) || !/^(?:0|\d{17,20})$/.test(request.baseVersion) || typeof request.containsSpoilers !== 'boolean' || typeof request.delete !== 'boolean') throw new MovieError('invalid-review');
      const text = request.delete ? null : normalizeMovieReview(request.text);
      return withMovie(request, async (tx, movieId) => {
        const where = { movieId_userId: { movieId, userId: request.userId } };
        const previous = await tx.movieReview.findUnique({ where });
        if (previous && BigInt(previous.interactionId) >= BigInt(request.interactionId)) return 'unchanged';
        if ((previous?.interactionId ?? '0') !== request.baseVersion) throw new MovieError('review-changed');
        const now = new Date();
        const data = { text, containsSpoilers: text !== null && request.containsSpoilers, interactionId: request.interactionId, updatedAt: now };
        await tx.movieReview.upsert({ where, create: { movieId, userId: request.userId, ...data },
          update: { ...data, ...(text !== null && previous?.text === null ? { createdAt: now } : {}) } });
        if ((previous?.text ?? null) !== text || (previous?.containsSpoilers ?? false) !== data.containsSpoilers) {
          await tx.movie.update({ where: { id: movieId }, data: { revision: { increment: 1n } } });
        }
        return text === null ? 'deleted' : 'saved';
      });
    },
    async page(context: MovieReviewContext, page: number, revealVersion?: string): Promise<MovieReviewPage> {
      if (!Number.isInteger(page) || page < 0 || page > 1_000_000 || revealVersion !== undefined && !snowflake(revealVersion)) throw new MovieError('invalid-review');
      return withMovie(context, async (tx, movieId) => {
        const movie = await tx.movie.findUniqueOrThrow({ where: { id: movieId } });
        const where = { movieId, text: { not: null } };
        const count = await tx.movieReview.count({ where });
        let position = Math.max(0, Math.min(page, count - 1));
        let selected;
        if (revealVersion) {
          selected = await tx.movieReview.findFirst({ where: { ...where, interactionId: revealVersion } });
          if (!selected) throw new MovieError('review-changed');
          position = await tx.movieReview.count({ where: { ...where, OR: [
            { createdAt: { lt: selected.createdAt } }, { createdAt: selected.createdAt, userId: { lt: selected.userId } },
          ] } });
        } else {
          selected = await tx.movieReview.findFirst({ where, orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }], skip: position });
        }
        const rating = selected ? await tx.movieRating.findUnique({ where: { movieId_userId: { movieId, userId: selected.userId } } }) : null;
        const revealed = Boolean(revealVersion);
        return { title: movie.title, imdbId: movie.imdbId, page: position, count, revealed,
          review: selected && selected.text !== null ? { userId: selected.userId,
            // Do not even return spoiler text to a renderer until explicit version-bound consent.
            text: selected.containsSpoilers && !revealed ? '' : selected.text,
            containsSpoilers: selected.containsSpoilers, version: selected.interactionId, score: rating?.score ?? null, updatedAt: selected.updatedAt } : null };
      });
    },
  };
}
export type MovieReviewStore = ReturnType<typeof createMovieReviewStore>;
