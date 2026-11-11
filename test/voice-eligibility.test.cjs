const assert = require('node:assert/strict');
const { test } = require('node:test');
const process = require('node:process');
const { ChannelType, Collection } = require('discord.js');
const { eligibleVoiceUserIds, getTrackingConfiguration, attachVoiceTracking } = require('../dist/reputation/voice-tracking.js');

const guildId = '111111111111111111';

test('tracking is opt-in and requires an explicit single-server ID', () => {
  assert.deepEqual(getTrackingConfiguration({}), { enabled: false });
  assert.deepEqual(getTrackingConfiguration({ REPUTATION_TRACKING_ENABLED: 'false' }), { enabled: false });
  assert.throws(() => getTrackingConfiguration({ REPUTATION_TRACKING_ENABLED: 'yes' }), /true or false/);
  assert.throws(() => getTrackingConfiguration({ REPUTATION_TRACKING_ENABLED: 'true' }), /REPUTATION_GUILD_ID/);
  assert.deepEqual(getTrackingConfiguration({
    REPUTATION_TRACKING_ENABLED: 'true', REPUTATION_GUILD_ID: guildId,
  }), { enabled: true, guildId });
});

test('disabled runtime creates no Discord listeners, timers, or database connections', async () => {
  const previous = process.env.REPUTATION_TRACKING_ENABLED;
  try {
    process.env.REPUTATION_TRACKING_ENABLED = 'false';
    const runtime = attachVoiceTracking({}); // Any client access would throw.
    assert.equal(runtime.tracker, undefined);
    await runtime.stop();
  } finally {
    if (previous === undefined) delete process.env.REPUTATION_TRACKING_ENABLED;
    else process.env.REPUTATION_TRACKING_ENABLED = previous;
  }
});

test('only humans in normal, non-AFK voice channels are eligible', () => {
  const state = (id, channelId, type, extra = {}) => ({
    id, channelId, channel: channelId ? { type } : null,
    member: { user: { bot: false } }, ...extra,
  });
  const values = [
    state('solo', 'voice', ChannelType.GuildVoice),
    state('muted', 'voice', ChannelType.GuildVoice, { selfMute: true, serverMute: true }),
    state('deafened', 'voice', ChannelType.GuildVoice, { selfDeaf: true, serverDeaf: true }),
    state('afk', 'afk', ChannelType.GuildVoice),
    state('speaker', 'stage', ChannelType.GuildStageVoice, { suppress: false }),
    state('listener', 'stage', ChannelType.GuildStageVoice, { suppress: true }),
    state('bot', 'voice', ChannelType.GuildVoice, { member: { user: { bot: true } } }),
    state('missing-member', 'voice', ChannelType.GuildVoice, { member: null }),
    state('disconnected', null, null),
    state('deleted-channel', 'missing', ChannelType.GuildVoice, { channel: null }),
  ];
  const guild = { afkChannelId: 'afk', voiceStates: { cache: new Collection(values.map(value => [value.id, value])) } };
  assert.deepEqual(eligibleVoiceUserIds(guild), ['solo', 'muted', 'deafened']);
});
