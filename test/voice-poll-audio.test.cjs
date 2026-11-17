const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { AbortController } = globalThis;
const { setImmediate } = require('node:timers/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { ChannelType, Events, PermissionFlagsBits } = require('discord.js');
const { VoicePollAudio, VoicePollAudioError } = require('../dist/reputation/voice-poll-audio.js');
const { createDiscordVoiceAnnouncementDriver } = require('../dist/reputation/voice-poll-audio-discord.js');
const request = { id: 'poll-one', guildId: 'guild', voiceChannelId: 'room' };
const flush = async () => { for (let i = 0; i < 4; i++) await setImmediate(); };
function fixture(t) {
  const timers = [], sessions = [], failures = []; let warned = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { const timer = { callback, delay, cleared: false, unref() {} }; timers.push(timer); return timer; });
  t.mock.method(globalThis, 'clearTimeout', timer => { if (timer) timer.cleared = true; });
  const driver = { open: async (input, signal, ended) => {
    const session = { input, signal, ended, plays: 0, closes: 0, ready: Promise.resolve(), play() { this.plays++; }, close() { this.closes++; } };
    sessions.push(session); return session;
  } };
  const audio = new VoicePollAudio(driver, code => { warned++; failures.push(code); });
  return { audio, driver, timers, sessions, failures, warned: () => warned };
}
test('voice announcement leaves on track completion and never repeats a duplicate start', async t => {
  const f = fixture(t); f.audio.play(request); await flush();
  assert.equal(f.sessions[0].plays, 1); assert.equal(f.timers[0].delay, 15000);
  f.sessions[0].ended(); assert.equal(f.sessions[0].closes, 1); assert.equal(f.sessions[0].signal.aborted, true);
  assert.equal(f.timers[0].cleared, true); f.audio.play(request); await flush(); assert.equal(f.sessions.length, 1); f.audio.stop();
});
test('hard fifteen-second cap includes connection/setup time and suppresses late readiness', async t => {
  const f = fixture(t); let ready;
  const open = f.driver.open; f.driver.open = async (...args) => { const session = await open(...args); session.ready = new Promise(resolve => { ready = resolve; }); return session; };
  f.audio.play(request); await flush(); f.timers[0].callback(); assert.equal(f.sessions[0].closes, 1);
  ready(); await flush(); assert.equal(f.sessions[0].plays, 0); assert.equal(f.warned(), 0); f.audio.stop();
});
test('a fresh poll preempts old music; late old callbacks cannot disconnect the new announcement', async t => {
  const f = fixture(t); f.audio.play(request); await flush();
  f.audio.play({ ...request, id: 'poll-two', voiceChannelId: 'other-room' }); await flush();
  assert.equal(f.sessions[0].closes, 1); assert.equal(f.sessions[1].plays, 1);
  f.sessions[0].ended(true); f.timers[0].callback(); assert.equal(f.sessions[1].closes, 0);
  f.audio.stop(); assert.equal(f.sessions[1].closes, 1);
});
test('missing permissions/resources, ready failures, decoder errors and synchronous setup errors are contained', async t => {
  const f = fixture(t);
  f.driver.open = async () => null; f.audio.play(request); await flush(); assert.equal(f.warned(), 1);
  f.driver.open = async () => { throw new Error('private network detail'); }; f.audio.play({ ...request, id: 'two' }); await flush(); assert.equal(f.warned(), 2);
  let closes = 0;
  f.driver.open = async () => ({ ready: Promise.resolve(), play: () => { throw new Error('decoder'); }, close: () => { closes++; } });
  f.audio.play({ ...request, id: 'three' }); await flush(); assert.equal(closes, 1); assert.equal(f.warned(), 3);
  f.driver.open = async () => ({ ready: Promise.reject(new Error('ready timeout')), play: () => assert.fail('unready playback'), close: () => { closes++; } });
  f.audio.play({ ...request, id: 'four' }); await flush(); assert.equal(closes, 2); assert.equal(f.warned(), 4); f.audio.stop();
});
test('shutdown aborts late setup, consumes a rejected readiness promise and never accepts another announcement', async t => {
  const f = fixture(t); let release;
  f.driver.open = () => new Promise(resolve => { release = resolve; });
  f.audio.play(request); f.audio.stop();
  let closed = 0; const ready = Promise.resolve().then(() => { throw new Error('cancelled'); });
  release({ ready, play: () => assert.fail('late playback'), close: () => { closed++; } });
  await flush(); assert.equal(closed, 1); f.audio.play({ ...request, id: 'two' }); assert.equal(f.timers.length, 1);
});
function discordFixture() {
  const connection = new EventEmitter(); connection.state = { status: 'connecting' }; let destroyed = 0, stopped = 0, unsubscribed = 0, played = 0, joined;
  connection.destroy = () => { destroyed++; connection.state.status = 'destroyed'; };
  connection.subscribe = () => ({ unsubscribe: () => { unsubscribed++; } });
  const player = new EventEmitter(); player.stop = () => { stopped++; }; player.play = () => { played++; };
  const voice = { getVoiceConnection: () => undefined, joinVoiceChannel: options => { joined = options; return connection; }, createAudioPlayer: () => player,
    createAudioResource: () => ({}), entersState: async () => {}, NoSubscriberBehavior: { Stop: 'stop' }, StreamType: { OggOpus: 'ogg/opus' },
    VoiceConnectionStatus: { Ready: 'ready', Disconnected: 'disconnected', Destroyed: 'destroyed' }, AudioPlayerStatus: { Idle: 'idle' } };
  const room = { id: 'room', type: ChannelType.GuildVoice, full: false, permissionsFor: () => ({ has: () => true }) };
  const guild = { id: 'guild', available: true, channels: { cache: new Map([['room', room]]) }, members: { me: {} }, voiceAdapterCreator: () => {} };
  const client = Object.assign(new EventEmitter(), { user: { id: 'bot' }, isReady: () => true, guilds: { cache: new Map([['guild', guild]]) } });
  const driver = createDiscordVoiceAnnouncementDriver(client, path.resolve('dist/assets/voting.ogg'), async () => voice);
  return { driver, voice, room, guild, connection, player, client, counts: () => ({ destroyed, stopped, unsubscribed, played }), joined: () => joined };
}
test('Discord audio joins the exact room, self-deafened, and closes on idle/disconnect without receiving voice', async () => {
  const f = discordFixture(); let ended = 0;
  const session = await f.driver.open(request, new AbortController().signal, () => { ended++; });
  await session.ready; session.play();
  assert.equal(f.joined().guildId, 'guild'); assert.equal(f.joined().channelId, 'room'); assert.equal(f.joined().selfDeaf, true); assert.equal(f.joined().selfMute, false);
  f.player.emit('idle'); assert.equal(ended, 1);
  f.connection.emit('stateChange', {}, { status: 'disconnected' }); assert.equal(ended, 2);
  session.close(); session.close(); assert.deepEqual(f.counts(), { destroyed: 1, stopped: 1, unsubscribed: 1, played: 1 });
  await flush();
});
test('a moved or server-muted bot ends its announcement instead of playing into another room', async () => {
  const f = discordFixture(); let ended = 0;
  const session = await f.driver.open(request, new AbortController().signal, () => { ended++; });
  f.client.emit(Events.VoiceStateUpdate, {}, { guild: { id: 'guild' }, id: 'human', channelId: 'elsewhere' }); assert.equal(ended, 0);
  f.client.emit(Events.VoiceStateUpdate, {}, { guild: { id: 'guild' }, id: 'bot', channelId: 'elsewhere' }); assert.equal(ended, 1);
  f.client.emit(Events.VoiceStateUpdate, {}, { guild: { id: 'guild' }, id: 'bot', channelId: 'room', serverMute: true }); assert.equal(ended, 2);
  session.close(); assert.equal(f.client.listenerCount(Events.VoiceStateUpdate), 0);
});
test('Discord audio skips missing rights, full rooms, Stage channels and external connections', async () => {
  for (const permission of [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]) {
    const f = discordFixture(); f.room.permissionsFor = () => ({ has: value => value !== permission });
    const expected = permission === PermissionFlagsBits.ViewChannel ? 'missing-view' : permission === PermissionFlagsBits.Connect ? 'missing-connect' : 'missing-speak';
    await assert.rejects(f.driver.open(request, new AbortController().signal, () => {}), error => error.code === expected); assert.equal(f.joined(), undefined);
  }
  const full = discordFixture(); full.room.full = true; full.room.permissionsFor = () => ({ has: value => value !== PermissionFlagsBits.MoveMembers });
  await assert.rejects(full.driver.open(request, new AbortController().signal, () => {}), error => error.code === 'room-full');
  const stage = discordFixture(); stage.room.type = ChannelType.GuildStageVoice;
  await assert.rejects(stage.driver.open(request, new AbortController().signal, () => {}), error => error.code === 'channel-invalid');
  const occupied = discordFixture(); occupied.voice.getVoiceConnection = () => ({});
  await assert.rejects(occupied.driver.open(request, new AbortController().signal, () => {}), error => error.code === 'connection-in-use'); assert.equal(occupied.counts().destroyed, 0);
});
test('cancellation during lazy loading cannot join later, and cleanup still disconnects after a player stop failure', async () => {
  const f = discordFixture(); const controller = new AbortController(); controller.abort();
  assert.equal(await f.driver.open(request, controller.signal, () => {}), null); assert.equal(f.joined(), undefined);
  const session = await f.driver.open(request, new AbortController().signal, () => {});
  f.player.stop = () => { throw new Error('player teardown'); }; session.close(); assert.equal(f.counts().destroyed, 1); assert.equal(f.counts().unsubscribed, 1);
});
test('missing assets and unavailable voice dependencies report precise safe causes before joining', async () => {
  const f = discordFixture();
  const missing = createDiscordVoiceAnnouncementDriver(f.client, path.resolve('dist/assets/not-there.ogg'), async () => f.voice);
  await assert.rejects(missing.open(request, new AbortController().signal, () => {}), error => error.code === 'audio-file-missing');
  const unavailable = createDiscordVoiceAnnouncementDriver(f.client, path.resolve('dist/assets/voting.ogg'), async () => { throw new Error('private native loader path'); });
  await assert.rejects(unavailable.open(request, new AbortController().signal, () => {}), error => error.code === 'voice-module-unavailable' && !error.message.includes('private'));
  assert.equal(f.joined(), undefined);
});
test('audio diagnostics identify the failed stage without including network tokens or raw errors', async t => {
  const f = fixture(t);
  f.driver.open = async () => { throw new VoicePollAudioError('missing-connect'); };
  f.audio.play(request); await flush();
  f.driver.open = async () => { throw new Error('wss://private/?token=secret'); };
  f.audio.play({ ...request, id: 'two' }); await flush();
  f.driver.open = async () => ({ ready: Promise.reject(new Error('private voice endpoint')), play: () => {}, close: () => {} });
  f.audio.play({ ...request, id: 'three' }); await flush();
  assert.deepEqual(f.failures, ['missing-connect', 'setup-unavailable', 'connection-timeout']);
  assert.doesNotMatch(JSON.stringify(f.failures), /private|token|secret/); f.audio.stop();
});
test('bundled audio decodes as direct Opus packets without an Opus encoder or runtime FFmpeg', async () => {
  const voice = await import('@discordjs/voice');
  const input = createReadStream(path.resolve('dist/assets/voting.ogg'));
  const resource = voice.createAudioResource(input, { inputType: voice.StreamType.OggOpus });
  let packets = 0;
  try { for await (const packet of resource.playStream) { assert.ok(packet.length > 0); packets++; } }
  finally { resource.playStream.destroy(); input.destroy(); }
  assert.ok(packets > 0 && packets <= 751);
});
