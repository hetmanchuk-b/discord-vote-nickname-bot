const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MessageFlags, ButtonStyle } = require('discord.js');
const { Response, structuredClone } = globalThis;
const { setImmediate } = require('node:timers');
const { imdbIdFromLink, parseMovieMetadata, createMovieLookup, moviePoster } = require('../dist/movies/metadata.js');
const { MovieError, movieFeedback } = require('../dist/movies/types.js');
const { renderMovie, renderMoviePlaceholder, parseMovieButton, movieButtonRevision } = require('../dist/movies/render.js');
const { MoviePublisher, MovieRuntime } = require('../dist/movies/runtime.js');
const { movieCommand } = require('../dist/movies/command.js');
const { handleButton } = require('../dist/buttons/index.js');
const response = {
  Response: 'True', Type: 'movie', imdbID: 'tt3896198', Title: 'Guardians of the Galaxy: Vol. 2', Year: '2017', Runtime: '136 min',
  Genre: 'Action, Adventure, Comedy', Director: 'James Gunn', Country: 'United States', Actors: 'Chris Pratt, Zoe Saldaña, Dave Bautista',
  Plot: 'The Guardians struggle to keep together as a team.', Poster: 'https://m.media-amazon.com/images/M/poster.jpg',
  Ratings: [{ Source: 'Internet Movie Database', Value: '7.6/10' }, { Source: 'Rotten Tomatoes', Value: '85%' }, { Source: 'Metacritic', Value: '67/100' }],
};
const metadata = () => parseMovieMetadata(response, response.imdbID);
const id = '11111111-2222-4333-8444-555555555555';
const guildId = '700000000000000001', channelId = '700000000000000002', messageId = '700000000000000003';
const request = { guildId, channelId, interactionId: '800000000000000001', link: 'https://www.imdb.com/title/tt3896198/' };
function fixture() {
  const movie = { ...metadata(), id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', guildId, revision: 0n };
  const post = { id, movieId: movie.id, movie, requestId: request.interactionId, channelId, messageId: null, status: 'creating', deliveredRevision: null };
  let state = null, sends = 0, edits = 0, reservations = 0;
  const store = {
    find: async () => null, reserve: async () => { reservations++; return structuredClone(post); }, get: async () => structuredClone(post),
    pending: async () => post.status !== 'missing' && (post.deliveredRevision === null || post.deliveredRevision < movie.revision) ? [id] : [],
    attempted: async () => {}, attach: async (_id, value) => { post.messageId = value; post.status = 'active'; },
    snapshot: async () => ({ post: structuredClone(post), metadata: metadata(), revision: movie.revision, average: movie.revision ? 8 : null, count: movie.revision ? 1 : 0 }),
    delivered: async (_id, revision) => { post.deliveredRevision = revision; }, missing: async () => { post.status = 'missing'; },
    vote: async () => { movie.revision++; return 8; },
  };
  const transport = {
    check: async () => {},
    placeholder: async () => { if (state === null) { sends++; state = 'pending'; } return messageId; },
    inspect: async () => state ?? 'missing',
    edit: async (_post, payload) => { edits++; state = movieButtonRevision(payload.components[0].toJSON().components[0].custom_id, _post.id); },
  };
  return { post, movie, store, transport, counts: () => ({ sends, edits, reservations }), setState: value => { state = value; } };
}

test('IMDb links are normalized without fetching arbitrary hosts or accepting lookalike URLs', () => {
  for (const link of ['https://www.imdb.com/title/tt3896198/?ref_=foo', 'https://imdb.com/title/tt3896198', 'https://m.imdb.com/title/tt3896198/ratings']) assert.equal(imdbIdFromLink(link), 'tt3896198');
  for (const link of ['http://imdb.com/title/tt3896198/', 'https://imdb.com.evil.test/title/tt3896198/', 'https://evil@imdb.com/title/tt3896198/', 'https://imdb.com:443/title/tt3896198x', 'https://imdb.com/name/nm1234567/', 'https://localhost/title/tt3896198/', 'https://imdb.com/title/tt123/', 'not a URL']) assert.throws(() => imdbIdFromLink(link), MovieError);
});
test('OMDb metadata is allowlisted, N/A fields omitted, and non-movies/mismatched IDs rejected', () => {
  assert.equal(metadata().externalRatings.length, 3);
  assert.equal(metadata().title, response.Title);
  const sparse = parseMovieMetadata({ ...response, Poster: 'N/A', Actors: 'N/A', Ratings: [], imdbRating: '7.6', Plot: 'N/A' }, response.imdbID);
  assert.equal(sparse.posterUrl, null); assert.equal(sparse.cast, null); assert.equal(sparse.plot, null);
  assert.deepEqual(sparse.externalRatings, [{ source: 'IMDb', value: '7.6/10' }]);
  assert.throws(() => parseMovieMetadata({ ...response, Type: 'series' }, response.imdbID), /Movie operation/);
  assert.throws(() => parseMovieMetadata(response, 'tt0133093'), MovieError);
  assert.throws(() => parseMovieMetadata({ ...response, Title: 'N/A' }, response.imdbID), MovieError);
  for (const url of ['http://m.media-amazon.com/x.jpg', 'https://evil.test/x.jpg', 'https://m.media-amazon.com/x.jpg?apikey=private', 'javascript:alert(1)']) assert.equal(moviePoster(url), null);
});
test('lookup uses HTTPS OMDb with a deadline and suppresses provider/network secrets', async () => {
  let calls = 0;
  const lookup = createMovieLookup({ apiKey: () => 'FAKE_PRIVATE_KEY', fetch: async (url, options) => {
    calls++; assert.equal(url.origin, 'https://www.omdbapi.com'); assert.equal(url.searchParams.get('i'), 'tt3896198');
    assert.equal(url.searchParams.get('plot'), 'short'); assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    return new Response(JSON.stringify(response));
  } });
  assert.equal((await lookup.get('tt3896198')).title, response.Title); assert.equal(calls, 1);
  const broken = createMovieLookup({ apiKey: () => 'FAKE_PRIVATE_KEY', fetch: async () => { throw new Error('https://provider/?apikey=FAKE_PRIVATE_KEY'); } });
  await assert.rejects(broken.get('tt3896198'), error => { assert.ok(error instanceof MovieError); assert.doesNotMatch(error.message + movieFeedback(error), /FAKE_PRIVATE_KEY|provider/); return true; });
});
test('lookup rejects missing keys, oversized/malformed bodies, API failures and redirects', async () => {
  await assert.rejects(createMovieLookup({ apiKey: () => '' }).get('tt3896198'), error => error.code === 'unconfigured');
  for (const make of [() => new Response('x'.repeat(65537)), () => new Response('{}', { headers: { 'content-length': '70000' } }), () => new Response('not JSON'), () => new Response('oops', { status: 503 })]) {
    await assert.rejects(createMovieLookup({ apiKey: () => 'fake', fetch: async () => make() }).get('tt3896198'), MovieError);
  }
  for (const [Error, code] of [['Movie not found!', 'not-found'], ['Invalid API key!', 'unconfigured'], ['Request limit reached!', 'unavailable']]) {
    await assert.rejects(createMovieLookup({ apiKey: () => 'fake', fetch: async () => new Response(JSON.stringify({ Response: 'False', Error })) }).get('tt3896198'), error => error.code === code);
  }
});
test('compact movie embeds separate public-source/community ratings, use a thumbnail and neutral 1–10 buttons', () => {
  const payload = renderMovie({ post: { id }, metadata: metadata(), revision: 12n, average: 8.25, count: 4 });
  const embed = payload.embeds[0].toJSON();
  assert.match(embed.title, /Guardians.*2017/); assert.equal(embed.url, request.link); assert.equal(embed.thumbnail.url, response.Poster); assert.equal(embed.image, undefined);
  assert.match(embed.description, /136 min.*Action/); assert.match(embed.description, /Guardians struggle/);
  assert.ok(embed.description.includes('[WPARTY](https://wparty.net/s/ds6p2p199fv)'));
  assert.equal(embed.fields.find(field => field.name === 'Режисер').inline, true);
  assert.equal(embed.fields.find(field => field.name === 'У ролях').value, response.Actors);
  assert.match(embed.fields.find(field => field.name === 'Зовнішні оцінки').value, /IMDb.*7\.6\/10.*85%.*67\/100/);
  assert.match(embed.fields.at(-1).value, /8,3\/10.*4/);
  assert.equal(payload.components.length, 3);
  assert.match(payload.components[2].toJSON().components[1].label, /Відгуки \(0\)/);
  const buttons = payload.components.slice(0, 2).flatMap(row => row.toJSON().components);
  assert.deepEqual(buttons.map(button => button.label), Array.from({ length: 10 }, (_, i) => String(i + 1)));
  assert.ok(buttons.every(button => button.style === ButtonStyle.Secondary && button.custom_id.length <= 100));
  assert.deepEqual(parseMovieButton(buttons[9].custom_id), { postId: id, score: 10 });
  assert.equal(movieButtonRevision(buttons[9].custom_id, id), 12n);
  assert.doesNotMatch(embed.footer.text, /MOVIE:|11111111/);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal(renderMoviePlaceholder(id).components.length, 0);
});
test('missing posters/ratings do not produce N/A text; pathological metadata stays inside Discord limits', () => {
  const sparse = parseMovieMetadata({ ...response, Poster: 'N/A', Director: 'N/A', Country: 'N/A', Actors: 'N/A', Ratings: [] }, response.imdbID);
  const embed = renderMovie({ post: { id }, metadata: sparse, revision: 0n, average: null, count: 0 }).embeds[0].toJSON();
  assert.equal(embed.thumbnail, undefined); assert.equal(embed.fields.length, 1); assert.match(embed.fields[0].value, /Оцінок ще немає/);
  const long = parseMovieMetadata(Object.fromEntries(Object.entries(response).map(([key, value]) => [key, ['Title','Genre','Runtime','Director','Country','Actors','Plot','Year'].includes(key) ? '*'.repeat(9000) : value])), response.imdbID);
  const json = renderMovie({ post: { id }, metadata: long, revision: 0n, average: null, count: 0 }).embeds[0].toJSON();
  assert.ok(json.title.length <= 256); assert.ok(json.description.length <= 4096); assert.ok(json.fields.every(field => field.value.length <= 1024));
  assert.ok(json.title.length + json.description.length + json.footer.text.length + json.fields.reduce((n, field) => n + field.name.length + field.value.length, 0) <= 6000);
});
test('malformed/cross-format rating button identifiers are rejected', () => {
  for (const value of [`movie:rate:${id}:0`, `movie:rate:${id}:11`, `movie:rate:${id}:01`, `movie:rate:${id}:1:extra`, 'movie:rate:not-uuid:1']) assert.equal(parseMovieButton(value), null);
});
test('publication binds an empty placeholder before enabling ratings and adopts lost edit acknowledgements', async () => {
  const f = fixture(); const original = f.transport.edit; let fail = true;
  f.transport.edit = async (...args) => { await original(...args); if (fail) { fail = false; throw new Error('lost ack'); } };
  const publisher = new MoviePublisher(f.store, f.transport, () => {});
  try {
    await publisher.start(); assert.equal(f.post.messageId, messageId); assert.equal(f.post.deliveredRevision, null);
    await publisher.wake(); assert.equal(f.post.deliveredRevision, 0n); assert.deepEqual(f.counts(), { sends: 1, edits: 1, reservations: 0 });
  } finally { await publisher.stop(); }
});
test('lost placeholder acknowledgements recover before full publication; deleted posts are never recreated', async () => {
  const f = fixture(); const original = f.transport.placeholder; let fail = true;
  f.transport.placeholder = async (...args) => { const result = await original(...args); if (fail) { fail = false; throw new Error('lost ack'); } return result; };
  const publisher = new MoviePublisher(f.store, f.transport, () => {});
  try {
    await publisher.start(); assert.equal(f.post.messageId, null);
    await publisher.wake(); assert.equal(f.post.deliveredRevision, 0n); assert.equal(f.counts().sends, 1);
    f.movie.revision++; f.setState('missing'); await publisher.wake(); assert.equal(f.post.status, 'missing');
    await publisher.wake(); assert.equal(f.counts().sends, 1);
  } finally { await publisher.stop(); }
});
test('ratings committed during delivery produce another revision instead of being acknowledged as delivered', async () => {
  const f = fixture(); const original = f.transport.edit; let once = true; let publisher;
  f.transport.edit = async (...args) => { if (once) { once = false; f.movie.revision++; void publisher.wake(); } await original(...args); };
  publisher = new MoviePublisher(f.store, f.transport, () => {});
  try { await publisher.start(); assert.equal(f.post.deliveredRevision, 1n); assert.equal(f.counts().edits, 2); }
  finally { await publisher.stop(); }
});
test('runtime reuses cached metadata and stops accepting work without requiring passive tracking', async () => {
  const f = fixture(); let lookupCalls = 0;
  f.store.find = async () => metadata();
  const runtime = new MovieRuntime(f.store, { get: async () => { lookupCalls++; return metadata(); } }, f.transport);
  try { await runtime.start(); await runtime.create(request); assert.equal(lookupCalls, 0); }
  finally { await runtime.stop(); }
  await assert.rejects(runtime.create(request), error => error.code === 'stopped');
  const disabled = new MovieRuntime(f.store, { get: async () => metadata() }, f.transport, false);
  await disabled.start(); await assert.rejects(disabled.create(request), error => error.code === 'unconfigured'); await disabled.stop();
});
test('runtime coalesces concurrent lookups and shutdown waits without writing a new post after lookup completion', async () => {
  const f = fixture(); let release, calls = 0;
  const lookup = new Promise(resolve => { release = resolve; });
  const runtime = new MovieRuntime(f.store, { get: () => { calls++; return lookup; } }, f.transport);
  const first = runtime.create(request);
  const second = runtime.create({ ...request, interactionId: '800000000000000002' });
  const rejectedFirst = assert.rejects(first, error => error.code === 'stopped');
  const rejectedSecond = assert.rejects(second, error => error.code === 'stopped');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  const stopping = runtime.stop(); release(metadata());
  await Promise.all([rejectedFirst, rejectedSecond, stopping]); assert.equal(f.counts().reservations, 0);
});
test('saving a rating is independent of unavailable Discord delivery', async () => {
  const f = fixture(); f.transport.edit = async () => { throw new Error('Discord unavailable'); };
  const runtime = new MovieRuntime(f.store, { get: async () => metadata() }, f.transport, true, () => {});
  try {
    await runtime.start();
    assert.equal(await runtime.vote({ postId: id, guildId, channelId, messageId, userId: '700000000000000004', score: 8, interactionId: '900000000000000001' }), 8);
  }
  finally { await runtime.stop(); }
});
test('movie command contains acknowledgement/feedback failures instead of exposing SDK credentials to the generic command logger', async t => {
  t.mock.method(console, 'warn', () => {});
  const interaction = { guildId, user: { bot: false }, deferReply: async () => { throw new Error('private webhook token'); },
    reply: async () => { throw new Error('private token'); } };
  await assert.doesNotReject(movieCommand.execute(interaction));
});
test('movie command creates a guild-scoped post, handles secrets safely and does not ping', async () => {
  const replies = []; let input;
  const interaction = { id: request.interactionId, guildId, channelId, user: { bot: false },
    options: { getString: () => request.link }, client: { movies: { create: async value => { input = value; return { channelId, messageId, deliveredRevision: 0n, status: 'active' }; } } },
    deferReply: async options => replies.push(options), editReply: async options => replies.push(options) };
  await movieCommand.execute(interaction); assert.deepEqual(input, request); assert.equal(replies[0].flags, MessageFlags.Ephemeral);
  assert.match(replies[1].content, /discord\.com\/channels/); assert.deepEqual(replies[1].allowedMentions, { parse: [] });
  interaction.client.movies.create = async () => { throw new Error('private DATABASE_URL api key'); };
  await movieCommand.execute(interaction); assert.doesNotMatch(replies.at(-1).content, /DATABASE_URL|api key/);
});
test('movie buttons work for any human guild member and privately confirm the effective score', async () => {
  let saved, feedback; const interaction = { customId: `movie:rate:${id}:8`, guildId, channelId, id: '900000000000000001',
    message: { id: messageId }, user: { id: '700000000000000004', bot: false },
    client: { movies: { vote: async value => { saved = value; return 8; } } },
    deferReply: async options => assert.equal(options.flags, MessageFlags.Ephemeral), editReply: async options => { feedback = options; },
    reply: async options => { feedback = options; } };
  await handleButton(interaction); assert.equal(saved.score, 8); assert.equal(saved.userId, interaction.user.id); assert.match(feedback.content, /8\/10/);
  saved = undefined; interaction.user.bot = true; await handleButton(interaction); assert.equal(saved, undefined);
  interaction.user.bot = false; interaction.guildId = null; await handleButton(interaction); assert.equal(saved, undefined);
});
