import { imdbIdFromLink } from './metadata.js';
import type { MovieLookup } from './metadata.js';
import { MovieError } from './types.js';
import type { MovieMetadata } from './types.js';
import { renderMovie } from './render.js';
import type { MoviePayload } from './render.js';
import type { MoviePost, MovieRequest, MovieStore, MovieVote } from './store.js';
import { createMovieReviewStore } from './review-store.js';
import type { MovieReviewContext, MovieReviewEditor, MovieReviewPage, MovieReviewStore, MovieReviewWrite } from './review-store.js';

export interface MovieTransport {
  check(guildId: string, channelId: string): Promise<void>;
  placeholder(post: MoviePost): Promise<string>;
  inspect(post: MoviePost): Promise<'missing' | 'pending' | bigint>;
  edit(post: MoviePost, payload: MoviePayload): Promise<void>;
}
/** One serialized delivery worker. DB revisions, not timers, are the durable queue. */
export class MoviePublisher {
  private stopped = true;
  private running: Promise<void> | undefined;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  constructor(private readonly store: MovieStore, private readonly transport: MovieTransport,
    private readonly warn: () => void = () => console.warn('Movie card delivery is pending; it will be retried.')) {}
  start(): Promise<void> { this.stopped = false; return this.wake(); }
  wake(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.dirty = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.running) this.running = this.run().finally(() => {
      this.running = undefined;
      if (this.dirty && !this.stopped) queueMicrotask(() => { void this.wake(); });
    });
    return this.running;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }
  private schedule(delay: number): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.wake(); }, delay);
    this.timer.unref();
  }
  private async deliver(id: string): Promise<void> {
    let post = await this.store.get(id);
    if (!post || post.status === 'missing') return;
    await this.store.attempted(id);
    if (!post.messageId) {
      // Only an empty placeholder is created. Lost acknowledgements can never
      // create a second full movie card; metadata/buttons are edited in after binding.
      await this.store.attach(id, await this.transport.placeholder(post));
    }
    const snapshot = await this.store.snapshot(id);
    if (!snapshot) return;
    post = snapshot.post;
    const state = await this.transport.inspect(post);
    if (state === 'missing') { await this.store.missing(id); return; }
    if (state === 'pending' || state < snapshot.revision) {
      await this.transport.edit(post, renderMovie(snapshot));
      await this.store.delivered(id, snapshot.revision);
    } else {
      // Adopt an acknowledged-lost edit, without overwriting a newer revision.
      await this.store.delivered(id, state);
    }
  }
  private async run(): Promise<void> {
    do {
      this.dirty = false;
      let failed = false;
      let hasMore = false;
      try {
        const ids = await this.store.pending();
        for (const id of ids) {
          if (this.stopped) break;
          try { await this.deliver(id); }
          catch (error) {
            if (error instanceof MovieError && error.code === 'post-missing') await this.store.missing(id);
            else failed = true;
          }
        }
        hasMore = ids.length === 50;
      } catch { failed = true; }
      if (failed) {
        if (!this.failures) this.warn();
        this.failures++;
        this.schedule(Math.min(300_000, 30_000 * 2 ** Math.min(this.failures - 1, 4)));
      } else {
        this.failures = 0;
        if (hasMore && !this.dirty) this.schedule(1_000);
      }
    } while (this.dirty && !this.stopped);
  }
}
export interface Movies {
  create(request: MovieRequest): Promise<MoviePost>;
  vote(request: MovieVote): Promise<number>;
  reviewEditor(context: MovieReviewContext): Promise<MovieReviewEditor>;
  reviewPage(context: MovieReviewContext, page: number, revealVersion?: string): Promise<MovieReviewPage>;
  writeReview(request: MovieReviewWrite): Promise<'saved' | 'deleted' | 'unchanged'>;
}
export class MovieRuntime implements Movies {
  readonly publisher: MoviePublisher;
  private stopped = false;
  private pending = new Set<Promise<unknown>>();
  private lookups = new Map<string, Promise<MovieMetadata>>();
  constructor(private readonly store: MovieStore, private readonly lookup: MovieLookup, private readonly transport: MovieTransport,
    private readonly enabled = true, warn?: () => void, private readonly reviews: MovieReviewStore = createMovieReviewStore()) { this.publisher = new MoviePublisher(store, transport, warn); }
  start(): Promise<void> { return this.enabled && !this.stopped ? this.publisher.start() : Promise.resolve(); }
  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new MovieError('stopped'));
    if (!this.enabled) return Promise.reject(new MovieError('unconfigured'));
    const task = operation(); this.pending.add(task);
    return task.finally(() => { this.pending.delete(task); });
  }
  create(request: MovieRequest): Promise<MoviePost> {
    return this.track(async () => {
      const imdbId = imdbIdFromLink(request.link);
      await this.transport.check(request.guildId, request.channelId);
      let metadata = await this.store.find(request.guildId, imdbId);
      if (!metadata) {
        let lookup = this.lookups.get(imdbId);
        if (!lookup) { lookup = this.lookup.get(imdbId); this.lookups.set(imdbId, lookup); }
        try { metadata = await lookup; }
        finally { if (this.lookups.get(imdbId) === lookup) this.lookups.delete(imdbId); }
      }
      if (this.stopped) throw new MovieError('stopped');
      const post = await this.store.reserve(request, metadata);
      if (!this.stopped) void this.publisher.wake();
      return post;
    });
  }
  vote(request: MovieVote): Promise<number> {
    return this.track(async () => {
      const score = await this.store.vote(request);
      // Receipt is independent of Discord edits. Delivery retries never cast a vote.
      void this.publisher.wake();
      return score;
    });
  }
  reviewEditor(context: MovieReviewContext): Promise<MovieReviewEditor> {
    return this.track(() => this.reviews.editor(context));
  }
  reviewPage(context: MovieReviewContext, page: number, revealVersion?: string): Promise<MovieReviewPage> {
    return this.track(() => this.reviews.page(context, page, revealVersion));
  }
  writeReview(request: MovieReviewWrite): Promise<'saved' | 'deleted' | 'unchanged'> {
    return this.track(async () => {
      const result = await this.reviews.write(request);
      void this.publisher.wake();
      return result;
    });
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.pending]);
    await this.publisher.stop();
  }
}
