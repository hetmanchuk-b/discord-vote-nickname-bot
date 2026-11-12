const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { Prisma } = require('../dist/generated/prisma/client.js');
const { PENALTY_BUTTON_PREFIX, REWARD_BUTTON_PREFIX, voicePollMarker } = require('../dist/reputation/voice-poll-render.js');

test('shared modules and generated Prisma model names are neutral, with no stale build artifacts', () => {
  for (const suffix of ['store','runtime','discord','render','command']) {
    assert.ok(fs.existsSync(path.resolve(`dist/reputation/voice-poll-${suffix}.js`)));
    assert.equal(fs.existsSync(path.resolve(`dist/reputation/voice-penalty-${suffix}.js`)),false);
  }
  assert.ok(fs.existsSync(path.resolve('dist/buttons/voice-poll.js')));
  assert.equal(fs.existsSync(path.resolve('dist/buttons/voice-penalty.js')),false);
  assert.equal(Prisma.ModelName.VoiceReputationPoll,'VoiceReputationPoll');
  assert.equal(Prisma.ModelName.VoiceReputationVote,'VoiceReputationVote');
  assert.equal(Object.hasOwn(Prisma.ModelName,'VoicePenaltyPoll'),false);
  assert.equal(Object.hasOwn(Prisma.ModelName,'VoicePenaltyVote'),false);
});

test('internal renaming keeps both existing button prefixes and message markers unchanged', () => {
  assert.equal(PENALTY_BUTTON_PREFIX,'voice-penalty:');
  assert.equal(REWARD_BUTTON_PREFIX,'voice-reward:');
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal(voicePollMarker(id,false),`VP:${id}:active`);
  assert.equal(voicePollMarker(id,true),`VP:${id}:final`);
});
