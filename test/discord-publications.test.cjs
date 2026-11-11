const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ChannelType, Collection, DiscordAPIError, PermissionFlagsBits } = require('discord.js');
const { createDiscordPublications } = require('../dist/reputation/discord-publications.js');
const { reportMarker } = require('../dist/reputation/report-render.js');

const id = '11111111-1111-4111-8111-111111111111';
function fixture() {
  const messages = new Map();
  const sends = [];
  const edits = [];
  const destination = {
    guildId: 'guild', type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async request => {
        if (typeof request === 'string') {
          if (!messages.has(request)) throw new DiscordAPIError({ code: 10008, message: 'Unknown message' }, 10008, 404, 'GET', 'https://discord.test', {});
          return messages.get(request);
        }
        return new Collection([...messages]);
      },
      edit: async (...args) => { edits.push(args); },
    },
    send: async payload => {
      sends.push(payload);
      const message = { id: `message-${sends.length}`, author: { id: 'bot' }, embeds: payload.embeds.map(embed => embed.toJSON?.() ?? embed) };
      messages.set(message.id, message);
      return message;
    },
  };
  const client = { user: { id: 'bot' }, guilds: { cache: new Map([['guild', { channels: { fetch: async () => destination }, members: { me: { id: 'bot' } } }]]) } };
  return { transport: createDiscordPublications(client, 'guild'), messages, sends, edits, destination };
}

test('empty placeholder creation enforces a short nonce and reuses the bot-owned marker on retry', async () => {
  const f = fixture();
  const report = { id, day: '2026-11-11' };
  assert.equal(await f.transport.createPlaceholder('channel', report), 'message-1');
  assert.equal(await f.transport.createPlaceholder('channel', report), 'message-1');
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].enforceNonce, true);
  assert.ok(f.sends[0].nonce.length <= 25);
  assert.deepEqual(f.sends[0].allowedMentions, { parse: [] });
  assert.equal(f.sends[0].embeds[0].toJSON().fields, undefined);
});

test('inspect distinguishes missing, placeholder, published, and foreign-authored messages', async () => {
  const f = fixture();
  assert.equal(await f.transport.inspect('channel', 'missing', id), 'missing');
  f.messages.set('message', { author: { id: 'bot' }, embeds: [{ footer: { text: reportMarker(id, false) } }] });
  assert.equal(await f.transport.inspect('channel', 'message', id), 'pending');
  f.messages.get('message').embeds[0].footer.text = `${reportMarker(id, true)} · page`;
  assert.equal(await f.transport.inspect('channel', 'message', id), 'published');
  f.messages.get('message').author.id = 'other';
  await assert.rejects(f.transport.inspect('channel', 'message', id), error => error.details.includes('report-message-mismatch'));
});

test('a channel outside the configured server cannot be edited', async () => {
  const f = fixture();
  f.destination.guildId = 'other-guild';
  await assert.rejects(f.transport.edit('channel', 'message', { content: 'test' }), error => error.details.includes('report-channel-invalid'));
  assert.equal(f.edits.length, 0);
});

test('an unacknowledged warning is adopted by its marker without creating a second message', async () => {
  const f = fixture();
  f.messages.set('existing', { id: 'existing', author: { id: 'bot' }, embeds: [{ footer: { text: 'REP-WARN:guild' } }] });
  const message = await f.transport.warning('channel', null, 'guild', { embeds: [], components: [], allowedMentions: { parse: [] } });
  assert.equal(message, 'existing');
  assert.equal(f.sends.length, 0);
  assert.equal(f.edits[0][0], 'existing');
});

test('known missing write permissions fail before preparing an unpublished report', async () => {
  const f = fixture();
  f.destination.permissionsFor = () => ({ has: () => false });
  f.messages.set('message', { author: { id: 'bot' }, embeds: [{ footer: { text: reportMarker(id, false) } }] });
  await assert.rejects(f.transport.inspect('channel', 'message', id), error => error.details.includes('discord-send-messages'));
  assert.equal(f.edits.length, 0);
});

test('already published markers can be reconciled even after write permission is lost', async () => {
  const f = fixture();
  f.destination.permissionsFor = () => ({ has: () => false });
  f.messages.set('message', { author: { id: 'bot' }, embeds: [{ footer: { text: reportMarker(id, true) } }] });
  assert.equal(await f.transport.inspect('channel', 'message', id), 'published');
});

test('warning updates reuse a known message rather than creating new messages', async () => {
  const f = fixture();
  await f.transport.warning('channel', 'existing', 'guild', { content: '', embeds: [], components: [], allowedMentions: { parse: [] } });
  assert.equal(f.sends.length, 0);
  assert.equal(f.edits[0][0], 'existing');
});

test('permission diagnostics identify each missing permission without exposing destination details',async()=>{
  const f=fixture();
  f.destination.permissionsFor=()=>({has:permission=>permission!==PermissionFlagsBits.SendMessages && permission!==PermissionFlagsBits.EmbedLinks});
  await assert.rejects(f.transport.edit('channel','message',{}),error=>{
    assert.deepEqual(error.details,['discord-embed-links','discord-send-messages']);return true;
  });
  assert.equal(f.edits.length,0);
});

test('Discord API exceptions become allowlisted summaries without their message, URL, or request data',async()=>{
  const f=fixture();
  const secret='private-discord-token';
  f.destination.send=async()=>{throw new DiscordAPIError({code:50013,message:secret},50013,403,'POST',`https://private.invalid/${secret}`,{token:secret});};
  await assert.rejects(f.transport.createPlaceholder('channel',{id,day:'2026-11-11'}),error=>{
    assert.deepEqual(error.details,['discord-permissions']);
    assert.doesNotMatch(String(error)+JSON.stringify(error)+error.stack,/private-discord-token|private.invalid/);
    assert.equal(error.cause,undefined);return true;
  });
});
