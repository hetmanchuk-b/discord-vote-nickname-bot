const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Collection, ChannelType, PermissionFlagsBits, DiscordAPIError } = require('discord.js');
const { createMovieTransport } = require('../dist/movies/discord.js');
const { movieMarker } = require('../dist/movies/render.js');
const { MovieError } = require('../dist/movies/types.js');
const id = '11111111-2222-4333-8444-555555555555';
const post = { id, movie: { guildId: '700000000000000001' }, channelId: '700000000000000002', messageId: '700000000000000003' };
const message = (author = 'bot', footer = `${movieMarker(id)}pending`) => ({ id: post.messageId, author: { id: author }, embeds: [{ footer: { text: footer } }] });
function fixture() {
  const sends = [], edits = [];
  const channel = { type: ChannelType.GuildText, guildId: post.movie.guildId, guild: { members: { me: { id: 'bot' } } },
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async options => typeof options === 'string' ? message() : new Collection(), edit: async (...args) => edits.push(args) },
    send: async payload => { sends.push(payload); return { id: post.messageId }; } };
  const client = { user: { id: 'bot' }, channels: { fetch: async () => channel } };
  return { channel, client, sends, edits, transport: createMovieTransport(client) };
}
test('movie transport validates guild/type and all required permissions before sending metadata', async () => {
  const f = fixture(); await f.transport.check(post.movie.guildId, post.channelId);
  f.channel.type = ChannelType.GuildVoice; await f.transport.check(post.movie.guildId, post.channelId);
  f.channel.type = ChannelType.GuildStageVoice; await assert.rejects(f.transport.check(post.movie.guildId, post.channelId), error => error.code === 'invalid-destination');
  f.channel.type = ChannelType.GuildText;
  await assert.rejects(f.transport.check('other-guild', post.channelId), error => error.code === 'invalid-destination');
  for (const denied of [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory]) {
    f.channel.permissionsFor = () => ({ has: permission => permission !== denied });
    await assert.rejects(f.transport.check(post.movie.guildId, post.channelId), error => error.code === 'permissions');
  }
  assert.equal(f.sends.length, 0);
});
test('movie placeholder recovery searches bounded history, only adopts this bot/marker, and sends no rating controls until binding', async () => {
  const f = fixture(); let page = 0;
  f.channel.messages.fetch = async options => {
    page++;
    if (page === 1) { assert.equal(options.before, undefined); return new Collection(Array.from({ length: 100 }, (_, index) => [String(index), message('another-author')])); }
    assert.equal(options.before, '99'); return new Collection([['found', message()]]);
  };
  assert.equal(await f.transport.placeholder(post), post.messageId); assert.equal(page, 2); assert.equal(f.sends.length, 0);
  f.channel.messages.fetch = async () => new Collection();
  await f.transport.placeholder(post);
  assert.equal(f.sends.length, 1); const payload = f.sends[0];
  assert.equal(payload.enforceNonce, true); assert.equal(payload.nonce, id.replaceAll('-', '').slice(0, 24));
  assert.deepEqual(payload.components, []); assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal(payload.embeds[0].toJSON().footer.text, `${movieMarker(id)}pending`);
});
test('movie inspection checks author/marker/revision and treats missing messages as terminal, not a reason to repost', async () => {
  const f = fixture(); assert.equal(await f.transport.inspect(post), 'pending');
  f.channel.messages.fetch = async () => message('bot', `${movieMarker(id)}23 · footer`);
  assert.equal(await f.transport.inspect(post), 23n);
  f.channel.messages.fetch = async () => ({ author: { id: 'bot' }, embeds: [{ footer: { text: 'Одна оцінка на людину.' } }],
    components: [{ type: 1, components: [{ type: 2, customId: `movie:rate:${id}:1:24` }] }] });
  assert.equal(await f.transport.inspect(post), 24n);
  for (const invalid of [message('someone-else'), message('bot', 'MOVIE:another-id:23'), message('bot', `${movieMarker(id)}-1`)]) {
    f.channel.messages.fetch = async () => invalid; await assert.rejects(f.transport.inspect(post), MovieError);
  }
  const missing = () => new DiscordAPIError({ message: 'Unknown Message', code: 10008 }, 10008, 404, 'GET', 'https://discord.com/api/test', {});
  f.channel.messages.fetch = async () => { throw missing(); }; assert.equal(await f.transport.inspect(post), 'missing');
  f.channel.messages.edit = async () => { throw missing(); }; await assert.rejects(f.transport.edit(post, {}), error => error.code === 'post-missing');
  assert.equal(f.sends.length, 0);
});
