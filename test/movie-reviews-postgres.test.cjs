const assert = require('node:assert/strict');
const { test } = require('node:test');
const process = require('node:process');
const { randomInt } = require('node:crypto');
const { createReputationDatabase } = require('../dist/reputation/database.js');
const { createMovieStore } = require('../dist/movies/store.js');
const { createMovieReviewStore } = require('../dist/movies/review-store.js');
const url = process.env.REPUTATION_TEST_DATABASE_URL;
const options = { skip: !url && 'Set REPUTATION_TEST_DATABASE_URL to a disposable migrated database.' };
let serial = 0n;
const sid = () => String(920000000000000000n + BigInt(Date.now()) * 100n + serial++);
const metadata = { imdbId: 'tt3896198', title: 'Movie', year: '2017', runtime: null, genres: null, director: null, country: null, cast: null, plot: null, posterUrl: null, externalRatings: [] };
async function setup(db, guildId) {
  const movies = createMovieStore(() => db), reviews = createMovieReviewStore(() => db);
  const post = await movies.reserve({ guildId, channelId: '720000000000000001', interactionId: sid(), link: 'https://www.imdb.com/title/tt3896198/' }, metadata);
  const messageId = sid(); await movies.attach(post.id, messageId);
  const context = { postId: post.id, guildId, channelId: post.channelId, messageId, userId: '720000000000000002' };
  return { movies, reviews, post, context };
}
const write = (context, overrides = {}) => ({ ...context, text: '  Worth watching!  ', containsSpoilers: false, delete: false, baseVersion: '0', interactionId: sid(), ...overrides });

test('PostgreSQL reviews persist across restart, share across reposts, and do not require or mutate ratings/reputation', options, async () => {
  const guildId = `${Date.now()}${randomInt(100000,999999)}`; let db = createReputationDatabase(url);
  try {
    let { reviews, movies, context, post } = await setup(db, guildId);
    const first = write(context); assert.equal(await reviews.write(first), 'saved');
    assert.deepEqual(await reviews.editor(context), { text: 'Worth watching!', containsSpoilers: false, version: first.interactionId });
    assert.equal((await movies.snapshot(post.id)).reviewCount, 1); assert.equal((await movies.snapshot(post.id)).count, 0);
    assert.equal(await db.reputationGuild.count({ where: { guildId } }), 0);
    const second = await setup(db, guildId); assert.equal(second.post.movieId, post.movieId);
    assert.equal((await second.reviews.editor(second.context)).text, 'Worth watching!');
    assert.equal((await reviews.page(context, 0)).review.score, null);
    await movies.vote({ ...context, score: 8, interactionId: sid() });
    assert.equal((await reviews.page(context, 0)).review.score, 8);
    const edit = write(context, { baseVersion: first.interactionId, text: 'An edited review.' }); await reviews.write(edit);
    assert.equal((await movies.snapshot(post.id)).reviewCount, 1); assert.equal((await movies.snapshot(post.id)).average, 8);
    await db.$disconnect(); db = createReputationDatabase(url); reviews = createMovieReviewStore(() => db);
    assert.equal((await reviews.editor(context)).text, edit.text);
    const deletion = write(context, { delete: true, baseVersion: edit.interactionId }); assert.equal(await reviews.write(deletion), 'deleted');
    const row = await db.movieReview.findUniqueOrThrow({ where: { movieId_userId: { movieId: post.movieId, userId: context.userId } } });
    assert.equal(row.text, null); assert.equal(row.containsSpoilers, false);
    assert.equal((await reviews.page(context, 0)).count, 0);
    assert.equal(await reviews.write(edit), 'unchanged'); // A replay cannot restore deleted text.
    await assert.rejects(reviews.write(write(context)), error => error.code === 'review-changed'); // Ancient blank form.
    await reviews.write(write(context, { baseVersion: deletion.interactionId, text: 'A genuinely new review.' }));
    assert.equal(await db.movieRating.count({ where: { movieId: post.movieId } }), 1);
    assert.equal((await createMovieStore(() => db).snapshot(post.id)).average, 8);
  } finally { try { await db.movie.deleteMany({ where: { guildId } }); } finally { await db.$disconnect(); } }
});
test('PostgreSQL spoiler text is withheld until exact-version reveal, and deleted/edited reviews cannot reveal replacements', options, async () => {
  const guildId = `${Date.now()}${randomInt(100000,999999)}`, db = createReputationDatabase(url);
  try {
    const { reviews, context } = await setup(db, guildId);
    const first = write(context, { text: 'FIRST SECRET || @everyone', containsSpoilers: true }); await reviews.write(first);
    const other = { ...context, userId: '720000000000000003' };
    const second = write(other, { text: 'SECOND SECRET', containsSpoilers: true }); await reviews.write(second);
    for (const page of [0, 1]) { const result = await reviews.page(context, page); assert.equal(result.review.text, ''); assert.equal(result.revealed, false); }
    const revealed = await reviews.page(context, 0, first.interactionId); assert.equal(revealed.review.text, first.text); assert.equal(revealed.revealed, true);
    const edit = write(context, { text: 'REPLACEMENT SECRET', containsSpoilers: true, baseVersion: first.interactionId }); await reviews.write(edit);
    await assert.rejects(reviews.page(context, 0, first.interactionId), error => error.code === 'review-changed');
    await reviews.write(write(other, { delete: true, baseVersion: second.interactionId }));
    await assert.rejects(reviews.page(context, 0, second.interactionId), error => error.code === 'review-changed');
    const clamped = await reviews.page(context, 999); assert.equal(clamped.page, 0); assert.equal(clamped.count, 1); assert.equal(clamped.review.text, '');
  } finally { try { await db.movie.deleteMany({ where: { guildId } }); } finally { await db.$disconnect(); } }
});
test('PostgreSQL review access binds guild/channel/source message and editing is strictly per user', options, async () => {
  const guildId = `${Date.now()}${randomInt(100000,999999)}`, db = createReputationDatabase(url);
  try {
    const { reviews, context, movies, post } = await setup(db, guildId);
    const first = write(context); await reviews.write(first);
    for (const invalid of [{ guildId: '720000000000000099' }, { channelId: '720000000000000099' }, { messageId: '720000000000000099' }]) {
      await assert.rejects(reviews.editor({ ...context, ...invalid }));
      await assert.rejects(reviews.page({ ...context, ...invalid }, 0));
      await assert.rejects(reviews.write(write({ ...context, ...invalid })));
    }
    const other = { ...context, userId: '720000000000000003' };
    assert.equal((await reviews.editor(other)).text, null);
    await assert.rejects(reviews.write(write(other, { delete: true, baseVersion: first.interactionId })), error => error.code === 'review-changed');
    assert.equal((await reviews.editor(context)).text, 'Worth watching!');
    for (const text of [' ', 'x'.repeat(1001), 'null\0byte']) await assert.rejects(reviews.write(write(context, { text, baseVersion: first.interactionId })), error => error.code === 'invalid-review');
    await movies.missing(post.id); await assert.rejects(reviews.write(write(context, { baseVersion: first.interactionId })));
    assert.equal(await db.movieReview.count({ where: { movieId: post.movieId, text: { not: null } } }), 1);
  } finally { try { await db.movie.deleteMany({ where: { guildId } }); } finally { await db.$disconnect(); } }
});
test('PostgreSQL concurrent forms cannot overwrite newer content or resurrect deleted content', options, async () => {
  const guildId = `${Date.now()}${randomInt(100000,999999)}`, db = createReputationDatabase(url);
  try {
    const { reviews, context, post } = await setup(db, guildId);
    const forms = await Promise.allSettled([reviews.write(write(context, { text: 'Form A' })), reviews.write(write(context, { text: 'Form B' }))]);
    assert.equal(forms.filter(result => result.status === 'fulfilled' && result.value === 'saved').length, 1);
    assert.equal(await db.movieReview.count({ where: { movieId: post.movieId, text: { not: null } } }), 1);
    const current = await reviews.editor(context);
    const deletion = write(context, { delete: true, baseVersion: current.version }); await reviews.write(deletion);
    await assert.rejects(reviews.write(write(context, { text: 'Stale editor', baseVersion: current.version })), error => error.code === 'review-changed');
    assert.equal((await reviews.editor(context)).text, null);
    const firstOther = { ...context, userId: '720000000000000004' }, secondOther = { ...context, userId: '720000000000000005' };
    await Promise.all([reviews.write(write(firstOther)), reviews.write(write(secondOther))]);
    assert.equal((await reviews.page(context, 0)).count, 2);
  } finally { try { await db.movie.deleteMany({ where: { guildId } }); } finally { await db.$disconnect(); } }
});
