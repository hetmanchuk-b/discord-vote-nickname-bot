import { randomUUID } from 'node:crypto';
import { getReputationDatabase } from '../reputation/database.js';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { externalMovieRatings } from './metadata.js';
import { MovieError } from './types.js';
import type { MovieMetadata } from './types.js';

export type MoviePost = Prisma.MoviePostGetPayload<{ include: { movie: true } }>;
export interface MovieSnapshot { post: MoviePost; metadata: MovieMetadata; revision: bigint; average: number | null; count: number }
export interface MovieVote {
  postId: string; guildId: string; channelId: string; messageId: string; userId: string; score: number; interactionId: string;
}
export interface MovieRequest { guildId: string; channelId: string; interactionId: string; link: string }
export function movieMetadata(row: MoviePost['movie']): MovieMetadata {
  return { imdbId: row.imdbId, title: row.title, year: row.year, runtime: row.runtime, genres: row.genres,
    director: row.director, country: row.country, cast: row.cast, plot: row.plot, posterUrl: row.posterUrl,
    externalRatings: externalMovieRatings(row.externalRatings) };
}
const include = { movie: true } as const;
const snowflake = (id: string) => /^\d{17,20}$/.test(id);
export function createMovieStore(getDatabase: () => PrismaClient = getReputationDatabase) {
  return {
    async find(guildId: string, imdbId: string): Promise<MovieMetadata | null> {
      const row = await getDatabase().movie.findUnique({ where: { guildId_imdbId: { guildId, imdbId } } });
      return row ? movieMetadata(row) : null;
    },
    async reserve(request: MovieRequest, metadata: MovieMetadata): Promise<MoviePost> {
      if (![request.guildId, request.channelId, request.interactionId].every(snowflake)) throw new MovieError('invalid-destination');
      return getDatabase().$transaction(async tx => {
        const movie = await tx.movie.upsert({
          // A nonempty scalar update enables a native ON CONFLICT upsert and
          // holds the movie lock through post reservation, including first-use races.
          where: { guildId_imdbId: { guildId: request.guildId, imdbId: metadata.imdbId } }, update: { imdbId: metadata.imdbId },
          create: { ...metadata, externalRatings: metadata.externalRatings.map(rating => ({ ...rating })), id: randomUUID(), guildId: request.guildId },
        });
        const post = await tx.moviePost.upsert({ where: { requestId: request.interactionId }, update: {},
          create: { id: randomUUID(), requestId: request.interactionId, movieId: movie.id, channelId: request.channelId }, include });
        if (post.movieId !== movie.id || post.channelId !== request.channelId) throw new MovieError('invalid-destination');
        return post;
      });
    },
    async get(id: string): Promise<MoviePost | null> { return getDatabase().moviePost.findUnique({ where: { id }, include }); },
    async pending(): Promise<string[]> {
      const rows = await getDatabase().$queryRaw<{ id: string }[]>`
        SELECT p.id FROM movie_posts p JOIN movies m ON m.id = p.movie_id
        WHERE p.status <> 'missing' AND (p.delivered_revision IS NULL OR p.delivered_revision < m.revision)
        ORDER BY p.last_attempt_at ASC NULLS FIRST, p.created_at ASC, p.id ASC LIMIT 50`;
      return rows.map(row => row.id);
    },
    async attempted(id: string): Promise<void> {
      await getDatabase().moviePost.update({ where: { id }, data: { lastAttemptAt: new Date() } });
    },
    async attach(id: string, messageId: string): Promise<void> {
      await getDatabase().moviePost.updateMany({ where: { id, status: 'creating', messageId: null }, data: { messageId, status: 'active' } });
    },
    async missing(id: string): Promise<void> {
      await getDatabase().moviePost.update({ where: { id }, data: { status: 'missing' } });
    },
    async snapshot(id: string): Promise<MovieSnapshot | null> {
      return getDatabase().$transaction(async tx => {
        const initial = await tx.moviePost.findUnique({ where: { id } });
        if (!initial || initial.status !== 'active') return null;
        // Same row lock as rating writes: the revision and aggregate describe one state.
        await tx.$queryRaw`SELECT id FROM movies WHERE id = ${initial.movieId}::uuid FOR UPDATE`;
        const post = await tx.moviePost.findUniqueOrThrow({ where: { id }, include });
        if (post.status !== 'active') return null;
        const stats = await tx.movieRating.aggregate({ where: { movieId: post.movieId }, _avg: { score: true }, _count: { _all: true } });
        return { post, metadata: movieMetadata(post.movie), revision: post.movie.revision, average: stats._avg.score, count: stats._count._all };
      });
    },
    async delivered(id: string, revision: bigint): Promise<void> {
      await getDatabase().moviePost.updateMany({ where: { id, status: 'active', movie: { revision: { gte: revision } },
        OR: [{ deliveredRevision: null }, { deliveredRevision: { lt: revision } }] }, data: { deliveredRevision: revision } });
    },
    async vote(vote: MovieVote): Promise<number> {
      if (!Number.isInteger(vote.score) || vote.score < 1 || vote.score > 10 ||
        ![vote.guildId, vote.channelId, vote.messageId, vote.userId, vote.interactionId].every(snowflake)) throw new MovieError('invalid-vote');
      return getDatabase().$transaction(async tx => {
        const initial = await tx.moviePost.findUnique({ where: { id: vote.postId } });
        if (!initial) throw new MovieError('post-missing');
        await tx.$queryRaw`SELECT id FROM movies WHERE id = ${initial.movieId}::uuid FOR UPDATE`;
        const post = await tx.moviePost.findUniqueOrThrow({ where: { id: vote.postId }, include });
        if (post.status !== 'active' || post.movie.guildId !== vote.guildId || post.channelId !== vote.channelId || post.messageId !== vote.messageId) {
          throw new MovieError('invalid-vote');
        }
        const where = { movieId_userId: { movieId: post.movieId, userId: vote.userId } };
        const previous = await tx.movieRating.findUnique({ where });
        if (previous && BigInt(previous.interactionId) >= BigInt(vote.interactionId)) return previous.score;
        await tx.movieRating.upsert({ where, create: { movieId: post.movieId, userId: vote.userId, score: vote.score, interactionId: vote.interactionId },
          update: { score: vote.score, interactionId: vote.interactionId, updatedAt: new Date() } });
        if (previous?.score !== vote.score) await tx.movie.update({ where: { id: post.movieId }, data: { revision: { increment: 1n } } });
        return vote.score;
      });
    },
  };
}
export type MovieStore = ReturnType<typeof createMovieStore>;
