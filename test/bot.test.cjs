const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Collection, MessageFlags } = require('discord.js');
const { loadCommands } = require('../dist/load-commands.js');
const getUniqueVariants = require('../dist/utils/get-unique-variants.js').default;
const groupMessages = require('../dist/utils/group-messages.js').default;
const shuffle = require('../dist/utils/shuffle.js').default;
const fetchAllVariants = require('../dist/utils/fetch-all-variants.js').default;
const fetchWithReactions = require('../dist/utils/fetch-all-variants-with-reactions.js').default;
const { buildButtons, renderContent } = require('../dist/utils/shuffle-session.js');
const interactionCreate = require('../dist/events/interaction-create.js').default;

const variant = (text, reactionCount = 0) => ({ text, reactionCount });

test('all nineteen compiled commands load and serialize for deployment', () => {
  const commands = loadCommands();
  assert.deepEqual([...commands.keys()].sort(), [
    'archive', 'dw', 'movie', 'nickname-end', 'nickname-manage-result',
    'nickname-start', 'nickname-variants', 'nickname-variants-by',
    'reputation', 'reputation-all', 'reputation-delete', 'reputation-off', 'reputation-on', 'reputation-rules',
    'set-reputation-report', 'voice-penalty', 'voice-reward', 'voice-today', 'yok',
  ]);
  for (const [name, command] of commands) {
    assert.equal(command.data.toJSON().name, name);
    assert.equal(typeof command.execute, 'function');
  }
});

test('deduplication normalizes case and whitespace, retaining the most reactions', () => {
  const messages = [
    { message: { content: ' Cool   Name ' }, reactionCount: 1 },
    { message: { content: 'cool name' }, reactionCount: 4 },
    { message: { content: 'Other' }, reactionCount: 0 },
    { message: { content: '  ' }, reactionCount: 10 },
  ];
  assert.deepEqual(getUniqueVariants(messages), [variant('cool name', 4), variant('Other')]);
});

test('messages are grouped by display name with username fallback', () => {
  assert.deepEqual([...groupMessages([
    { member: { displayName: 'Alex' }, author: { username: 'a' }, content: 'One' },
    { member: { displayName: 'Alex' }, author: { username: 'a' }, content: 'Two' },
    { member: null, author: { username: 'Sam' }, content: 'Three' },
  ])], [['Alex', ['One', 'Two']], ['Sam', ['Three']]]);
});

test('shuffle preserves values and mutates the supplied array', () => {
  const input = [1, 2, 3, 4];
  assert.equal(shuffle(input), input);
  assert.deepEqual([...input].sort(), [1, 2, 3, 4]);
  assert.deepEqual(shuffle([]), []);
});

test('selection buttons reflect finalist and availability limits', () => {
  const ids = (selected, available) => buildButtons(selected, available)[0]
    .toJSON().components.map(button => button.custom_id);
  assert.deepEqual(ids(0, 8), ['shuffle:roll']);
  assert.deepEqual(ids(5, 3), ['shuffle:roll', 'shuffle:remove', 'shuffle:create-poll']);
  assert.deepEqual(ids(10, 3), ['shuffle:remove', 'shuffle:create-poll']);
  assert.deepEqual(ids(1, 0), ['shuffle:remove']);
  assert.match(renderContent([variant('Name', 2)]), /1\. Name \(2 👍\)/);
});

test('message fetchers paginate, filter non-suggestions, and count reactions', async () => {
  const message = (id, content, bot = false) => ({
    id, content, author: { bot }, system: false,
    reactions: { cache: new Collection([['a', { count: 2 }], ['b', { count: 3 }]]) },
  });
  const newer = message('3', 'New');
  const older = message('1', 'Old');
  const makeThread = () => {
    let page = 0;
    return { messages: { fetch: async options => {
      if (page++ === 0) {
        assert.equal(options.before, undefined);
        return new Collection([['3', newer], ['2', message('2', 'bot', true)]]);
      }
      if (page === 2) {
        assert.equal(options.before, '2');
        return new Collection([['1', older], ['0', message('0', ' ')]]);
      }
      return new Collection();
    } } };
  };
  assert.deepEqual(await fetchAllVariants(makeThread()), [older, newer]);
  assert.deepEqual(await fetchWithReactions(makeThread()), [
    { message: older, reactionCount: 5 }, { message: newer, reactionCount: 5 },
  ]);
});

test('async command failures reach the interaction error handler', async t => {
  t.mock.method(console, 'error', () => {});
  const replies = [];
  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'failing', user: { id: 'user' },
    client: {
      commands: new Collection([['failing', {
        data: { name: 'failing' }, cooldown: 0,
        execute: async () => { throw new Error('test failure'); },
      }]]),
      cooldowns: new Collection(),
    },
    reply: async response => { replies.push(response); },
  };
  await interactionCreate.execute(interaction);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].flags, MessageFlags.Ephemeral);
  assert.match(replies[0].content, /error while executing/);
});

test('shuffle buttons select, remove, and publish a poll', async () => {
  const state = {
    availableVariants: [variant('One', 2)], selectedVariants: [], threadId: 'thread',
  };
  const sessions = new Collection([['message', state]]);
  const sent = [];
  const interaction = {
    isChatInputCommand: () => false, isButton: () => true,
    customId: 'shuffle:roll', message: { id: 'message' },
    client: { shuffleSessions: sessions },
    update: async () => {},
    channel: { isSendable: () => true, send: async payload => { sent.push(payload); } },
  };
  await interactionCreate.execute(interaction);
  assert.deepEqual(state.selectedVariants, [variant('One', 2)]);
  assert.equal(state.availableVariants.length, 0);
  interaction.customId = 'shuffle:remove';
  await interactionCreate.execute(interaction);
  assert.equal(state.selectedVariants.length, 0);
  assert.deepEqual(state.availableVariants, [variant('One', 2)]);
  state.selectedVariants = ['A', 'B', 'C', 'D', 'E'].map(text => variant(text));
  interaction.customId = 'shuffle:create-poll';
  await interactionCreate.execute(interaction);
  assert.equal(sent[0].poll.duration, 24);
  assert.equal(sent[0].poll.answers.length, 5);
  assert.equal(sessions.has('message'), false);
});
