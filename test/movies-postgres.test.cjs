const assert = require('node:assert/strict');
const { test } = require('node:test');
const process = require('node:process');
const { randomInt } = require('node:crypto');
const { createReputationDatabase } = require('../dist/reputation/database.js');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../dist/generated/prisma/client.js');
const { createMovieStore } = require('../dist/movies/store.js');
const { MoviePublisher } = require('../dist/movies/runtime.js');
const { MovieError } = require('../dist/movies/types.js');
const { movieButtonRevision } = require('../dist/movies/render.js');
const url = process.env.REPUTATION_TEST_DATABASE_URL;
const options = { skip: !url && 'Set REPUTATION_TEST_DATABASE_URL to a disposable migrated database.' };
const metadata = { imdbId: 'tt3896198', title: 'Guardians of the Galaxy: Vol. 2', year: '2017', runtime: '136 min', genres: 'Action, Adventure, Comedy',
  director: 'James Gunn', country: 'United States', cast: 'Chris Pratt, Zoe Saldaña, Dave Bautista', plot: 'The Guardians struggle to keep together as a team.',
  posterUrl: 'https://m.media-amazon.com/images/M/poster.jpg', externalRatings: [{ source: 'IMDb', value: '7.6/10' }] };
let serial = 0n;
const snowflake = () => String(910000000000000000n + BigInt(Date.now()) * 100n + serial++);
const guild = () => `${Date.now()}${randomInt(100000,999999)}`;
const channelId = '720000000000000001', userId = '720000000000000002';
const request = guildId => ({ guildId, channelId, interactionId: snowflake(), link: 'https://www.imdb.com/title/tt3896198/' });
const vote = (post, score, overrides = {}) => ({ postId: post.id, guildId: post.movie.guildId, channelId: post.channelId, messageId: post.messageId, userId, interactionId: snowflake(), score, ...overrides });

test('PostgreSQL movie metadata/ratings persist, reposts share scores, and votes are mutable/latest-interaction-wins without reputation participation', options, async () => {
  let db = createReputationDatabase(url); const guildId = guild(), otherGuild = guild();
  let store = createMovieStore(() => db);
  try {
    const input = request(guildId);
    const first = await store.reserve(input, metadata);
    assert.equal((await store.reserve(input, metadata)).id, first.id); // Replay of one command, not another post.
    const second = await store.reserve(request(guildId), metadata);
    const other = await store.reserve(request(otherGuild), metadata);
    assert.equal(first.movieId, second.movieId); assert.notEqual(first.movieId, other.movieId);
    assert.equal(await db.reputationGuild.count({ where: { guildId } }), 0);
    await store.attach(first.id, snowflake()); await store.attach(second.id, snowflake()); await store.attach(other.id, snowflake());
    const post = await store.get(first.id), post2 = await store.get(second.id);
    await store.vote(vote(post, 8));
    await store.vote(vote(post2, 6, { userId: '720000000000000003' }));
    let snapshot = await store.snapshot(first.id); assert.equal(snapshot.average, 7); assert.equal(snapshot.count, 2);
    const newer = snowflake();
    assert.equal(await store.vote(vote(post2, 10, { interactionId: newer })), 10);
    assert.equal(await store.vote(vote(post, 1, { interactionId: String(BigInt(newer) - 1n) })), 10);
    assert.equal(await store.vote(vote(post, 2, { interactionId: newer })), 10);
    snapshot = await store.snapshot(second.id); assert.equal(snapshot.average, 8); assert.equal(snapshot.count, 2);
    const oldId = snowflake(), newId = snowflake();
    await Promise.all([store.vote(vote(post, 5, { interactionId: newId })), store.vote(vote(post2, 9, { interactionId: oldId }))]);
    assert.equal((await store.snapshot(first.id)).average, 5.5);
    for (const overrides of [{ guildId: otherGuild }, { channelId: '720000000000000009' }, { messageId: '720000000000000009' }, { score: 0 }, { score: 11 }, { score: 1.5 }]) {
      await assert.rejects(store.vote(vote(post, 4, overrides)), MovieError);
    }
    assert.equal((await store.snapshot(first.id)).count, 2);
    assert.equal((await store.snapshot(other.id)).count, 0);
    await assert.rejects(db.movieRating.create({ data: { movieId: first.movieId, userId: '720000000000000008', score: 0, interactionId: snowflake() } }));
    const revision = (await store.snapshot(first.id)).revision;
    await store.delivered(first.id, revision); await store.delivered(first.id, revision - 1n);
    assert.equal((await store.get(first.id)).deliveredRevision, revision);
    await db.$disconnect(); db = createReputationDatabase(url); store = createMovieStore(() => db);
    assert.deepEqual(await store.find(guildId, metadata.imdbId), metadata);
    assert.equal((await store.snapshot(second.id)).average, 5.5);
    await store.missing(first.id); await assert.rejects(store.vote(vote(post, 4)), MovieError);
    assert.equal(await db.movieRating.count({ where: { movieId: first.movieId } }), 2);
    assert.equal((await store.reserve(request(guildId), metadata)).movieId, first.movieId);
  } finally { try { await db.movie.deleteMany({ where: { guildId: { in: [guildId, otherGuild] } } }); } finally { await db.$disconnect(); } }
});

test('PostgreSQL concurrent first posts/replayed commands create one movie and one post per interaction', options, async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 3 }), log: [{ level: 'query', emit: 'event' }] });
  const guildId = guild(), store = createMovieStore(() => db);
  let nativeMovieUpsert = false;
  db.$on('query', event => { if (event.query.includes('INSERT INTO "public"."movies"') && event.query.includes('ON CONFLICT')) nativeMovieUpsert = true; });
  try {
    const input = request(guildId);
    const posts = await Promise.all([store.reserve(input, metadata), store.reserve(input, metadata), store.reserve(request(guildId), metadata)]);
    assert.equal(posts[0].id, posts[1].id); assert.notEqual(posts[0].id, posts[2].id);
    assert.equal(await db.movie.count({ where: { guildId } }), 1);
    assert.equal(await db.moviePost.count({ where: { movie: { guildId } } }), 2);
    assert.equal(nativeMovieUpsert, true, 'First-use serialization must use a database-native upsert, not a read/create race.');
  } finally { try { await db.movie.deleteMany({ where: { guildId } }); } finally { await db.$disconnect(); } }
});

test('PostgreSQL serializes concurrent movie voters and synchronizes every repost even when ratings change during an edit', options, async () => {
  const db = createReputationDatabase(url), guildId = guild(), store = createMovieStore(() => db);
  const messages = new Map(); let sends = 0, edits = 0, publisher, raced = false;
  const transport = {
    check: async () => {}, placeholder: async post => { const existing = messages.get(post.id); if (existing) return existing.id;
      const id = snowflake(); messages.set(post.id, { id, revision: 'pending' }); sends++; return id; },
    inspect: async post => messages.get(post.id)?.revision ?? 'missing',
    edit: async (post, payload) => {
      edits++;
      if (!raced) { raced = true; await store.vote(vote(post, 8)); void publisher.wake(); }
      messages.get(post.id).revision = movieButtonRevision(payload.components[0].toJSON().components[0].custom_id, post.id);
    },
  };
  publisher = new MoviePublisher(store, transport, () => {});
  try {
    const first = await store.reserve(request(guildId), metadata), second = await store.reserve(request(guildId), metadata);
    await publisher.start();
    assert.equal(sends, 2); assert.ok(edits >= 3);
    assert.equal((await store.get(first.id)).deliveredRevision, 1n); assert.equal((await store.get(second.id)).deliveredRevision, 1n);
    const post = await store.get(first.id);
    await Promise.all(Array.from({ length: 6 }, (_, i) => store.vote(vote(post, i + 1, { userId: `72000000000000001${i}` }))));
    await publisher.wake();
    const snapshot = await store.snapshot(first.id); assert.equal(snapshot.count, 7); assert.equal(snapshot.average, 29 / 7);
    assert.equal((await store.get(second.id)).deliveredRevision, snapshot.revision);
    assert.equal(messages.get(first.id).revision, snapshot.revision); assert.equal(sends, 2);
  } finally { await publisher.stop(); try { await db.movie.deleteMany({ where: { guildId } }); } finally { await db.$disconnect(); } }
});

test('PostgreSQL queued movie publications recover across connections, lost acknowledgements do not duplicate full cards, and deletions do not erase ratings', options, async () => {
  let db = createReputationDatabase(url), store = createMovieStore(() => db); const guildId = guild();
  const messages = new Map(); let sends = 0, edits = 0, failPlaceholder = true, failEdit = true, deleted = false;
  const transport = { check: async () => {}, placeholder: async post => {
    let message = messages.get(post.id); if (!message) { message = { id: snowflake(), revision: 'pending' }; messages.set(post.id, message); sends++; }
    if (failPlaceholder) { failPlaceholder = false; throw new Error('lost placeholder acknowledgement'); } return message.id;
  }, inspect: async post => deleted ? 'missing' : messages.get(post.id).revision,
  edit: async (post, payload) => { edits++; messages.get(post.id).revision = movieButtonRevision(payload.components[0].toJSON().components[0].custom_id, post.id);
    if (failEdit) { failEdit = false; throw new Error('lost edit acknowledgement'); } } };
  let publisher = new MoviePublisher(store, transport, () => {});
  try {
    const post = await store.reserve(request(guildId), metadata);
    await publisher.start(); assert.equal((await store.get(post.id)).messageId, null);
    await publisher.stop(); await db.$disconnect(); db = createReputationDatabase(url); store = createMovieStore(() => db);
    publisher = new MoviePublisher(store, transport, () => {});
    await publisher.start(); assert.equal((await store.get(post.id)).deliveredRevision, null);
    await publisher.wake(); assert.equal((await store.get(post.id)).deliveredRevision, 0n);
    assert.equal(sends, 1); assert.equal(edits, 1);
    const active = await store.get(post.id); await store.vote(vote(active, 9)); deleted = true; await publisher.wake();
    assert.equal((await store.get(post.id)).status, 'missing');
    assert.equal(await db.movieRating.count({ where: { movieId: post.movieId } }), 1);
    await publisher.wake(); assert.equal(sends, 1);
  } finally { await publisher.stop(); try { await db.movie.deleteMany({ where: { guildId } }); } finally { await db.$disconnect(); } }
});
