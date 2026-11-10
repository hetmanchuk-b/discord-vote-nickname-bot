const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Collection, MessageFlags } = require('discord.js');
const interactionCreate = require('../dist/events/interaction-create.js').default;

function button(customId, state) {
  const replies = [];
  const updates = [];
  const sent = [];
  return {
    isChatInputCommand: () => false,
    isButton: () => true,
    customId,
    message: { id: 'message' },
    client: { shuffleSessions: new Collection(state ? [['message', state]] : []) },
    reply: async response => { replies.push(response); },
    update: async response => { updates.push(response); },
    channel: { isSendable: () => true, send: async payload => { sent.push(payload); } },
    replies, updates, sent,
  };
}

test('unregistered button IDs are logged without running a handler', async t => {
  const log = t.mock.method(console, 'log', () => {});
  for (const id of ['unknown:button', 'toString']) {
    const interaction = button(id);
    await interactionCreate.execute(interaction);
    assert.deepEqual(interaction.replies, []);
    assert.deepEqual(interaction.updates, []);
  }
  assert.equal(log.mock.callCount(), 2);
});

test('other interaction types are ignored', async () => {
  await interactionCreate.execute({
    isChatInputCommand: () => false,
    isButton: () => false,
  });
});

for (const id of ['shuffle:roll', 'shuffle:remove', 'shuffle:create-poll']) {
  test(`${id} rejects a missing session`, async () => {
    const interaction = button(id);
    await interactionCreate.execute(interaction);
    assert.deepEqual(interaction.replies, [{
      content: '❌ Сесію не знайдено', flags: MessageFlags.Ephemeral,
    }]);
    assert.deepEqual(interaction.updates, []);
  });
}

test('rolling an exhausted session leaves the selection unchanged', async () => {
  const state = { availableVariants: [], selectedVariants: [], threadId: 'thread' };
  const interaction = button('shuffle:roll', state);
  await interactionCreate.execute(interaction);
  assert.match(interaction.replies[0].content, /Варіанти закінчилися/);
  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
  assert.deepEqual(state.selectedVariants, []);
  assert.deepEqual(interaction.updates, []);
});

test('roll selection uses reaction weights and removes the selected variant', async t => {
  t.mock.method(Math, 'random', () => 0.75);
  const first = { text: 'First', reactionCount: 0 };
  const second = { text: 'Second', reactionCount: 3 };
  const state = {
    availableVariants: [first, second], selectedVariants: [], threadId: 'thread',
  };
  const interaction = button('shuffle:roll', state);
  await interactionCreate.execute(interaction);
  assert.deepEqual(state.selectedVariants, [second]);
  assert.deepEqual(state.availableVariants, [first]);
  assert.equal(interaction.updates.length, 1);
});

test('poll creation requires at least five finalists and keeps the session', async () => {
  const state = { availableVariants: [], selectedVariants: [], threadId: 'thread' };
  const interaction = button('shuffle:create-poll', state);
  await interactionCreate.execute(interaction);
  assert.match(interaction.replies[0].content, /мінімум 5/);
  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
  assert.deepEqual(interaction.sent, []);
  assert.equal(interaction.client.shuffleSessions.get('message'), state);
});

test('command cooldown prevents execution after dispatch', async () => {
  let executed = false;
  const replies = [];
  await interactionCreate.execute({
    isChatInputCommand: () => true,
    commandName: 'example', user: { id: 'user' },
    client: {
      commands: new Collection([['example', {
        data: { name: 'example' }, cooldown: 3,
        execute: async () => { executed = true; },
      }]]),
      cooldowns: new Collection([['example', new Collection([['user', Date.now()]])]]),
    },
    reply: async response => { replies.push(response); },
  });
  assert.equal(executed, false);
  assert.equal(replies[0].flags, MessageFlags.Ephemeral);
  assert.match(replies[0].content, /cooldown/);
});
