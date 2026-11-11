const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { setImmediate } = require('node:timers/promises');
const process = require('node:process');
const { Events, Collection, ChannelType } = require('discord.js');
const storeModule = require('../dist/reputation/tracking-store.js');
const settlementModule = require('../dist/reputation/settlement-store.js');
const { attachVoiceTracking } = require('../dist/reputation/voice-tracking.js');

const guildId = '111111111111111111';

test('Discord runtime checkpoints only its configured server and suspends across gateway loss', async t => {
  const previousFlag = process.env.REPUTATION_TRACKING_ENABLED;
  const previousGuild = process.env.REPUTATION_GUILD_ID;
  const calls = { opened: 0, checkpoints: 0, closed: 0 };
  const timers = [];
  t.mock.method(console, 'warn', () => {});
  t.mock.method(settlementModule, 'createSettlementStore', () => ({ settleNextClosedDay: async () => null }));
  t.mock.method(storeModule, 'createTrackingStore', () => ({
    openRun: async () => ({ runId: `run-${++calls.opened}`, pausedUserIds: [] }),
    checkpoint: async () => { calls.checkpoints++; },
    closeRun: async () => { calls.closed++; },
    setTracking: async () => {},
  }));
  t.mock.method(globalThis, 'setInterval', (callback, interval) => {
    timers.push({ callback, interval });
    return { unref() {} };
  });
  t.mock.method(globalThis, 'clearInterval', () => {});
  let runtime;
  try {
    process.env.REPUTATION_TRACKING_ENABLED = 'true';
    process.env.REPUTATION_GUILD_ID = guildId;
    const client = new EventEmitter();
    client.isReady = () => true;
    const guild = { id: guildId, available: true, shardId: 0, afkChannelId: null,
      voiceStates: { cache: new Collection() } };
    client.guilds = { cache: new Collection([[guildId, guild]]) };
    runtime = attachVoiceTracking(client);
    await setImmediate();
    assert.equal(calls.opened, 1);
    assert.equal(runtime.tracker.status, 'tracking');
    assert.equal(timers[0].interval, 5 * 60_000);
    const startupCheckpoints = calls.checkpoints;

    client.emit(Events.VoiceStateUpdate, { guild: { id: 'other' } }, { guild: { id: 'other' } });
    await setImmediate();
    assert.equal(calls.checkpoints, startupCheckpoints);
    guild.voiceStates.cache.set('human', {
      id: 'human', member: { user: { bot: false } }, channelId: 'voice',
      channel: { type: ChannelType.GuildVoice },
    });
    client.emit(Events.VoiceStateUpdate, { guild }, { guild });
    await setImmediate();
    assert.equal(calls.checkpoints, startupCheckpoints + 1);
    timers[0].callback();
    await setImmediate();
    assert.equal(calls.checkpoints, startupCheckpoints + 2);

    client.emit(Events.ShardDisconnect, {}, 0);
    await setImmediate();
    assert.equal(runtime.tracker.status, 'suspended');
    timers[0].callback();
    await setImmediate();
    assert.equal(calls.checkpoints, startupCheckpoints + 2);
    client.emit(Events.ShardResume, 0);
    await setImmediate();
    assert.equal(calls.opened, 2);
    assert.equal(runtime.tracker.status, 'tracking');

    await runtime.stop();
    const lastCount = calls.checkpoints;
    timers[0].callback();
    client.emit(Events.ShardResume, 0);
    await setImmediate();
    assert.equal(calls.checkpoints, lastCount);
    assert.equal(calls.opened, 2);
    assert.equal(client.listenerCount(Events.VoiceStateUpdate), 0);
    assert.equal(client.listenerCount(Events.ShardResume), 0);
  } finally {
    if (runtime) await runtime.stop();
    if (previousFlag === undefined) delete process.env.REPUTATION_TRACKING_ENABLED;
    else process.env.REPUTATION_TRACKING_ENABLED = previousFlag;
    if (previousGuild === undefined) delete process.env.REPUTATION_GUILD_ID;
    else process.env.REPUTATION_GUILD_ID = previousGuild;
  }
});
