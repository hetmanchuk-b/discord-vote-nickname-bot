const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MessageFlags } = require('discord.js');
const { createMemberCommand } = require('../dist/reputation/member-commands.js');
const { createReputationButtons } = require('../dist/buttons/reputation.js');
const { PublicationPendingError } = require('../dist/reputation/report-errors.js');
const { DeletionConfirmations, DELETE_CONFIRM_ID, DELETE_CANCEL_ID } = require('../dist/reputation/deletion-confirmations.js');

function fixture() {
  const calls = [];
  const replies = [];
  const edits = [];
  const deferred = [];
  const reputation = {
    getBalance: async (...args) => { calls.push(['balance', ...args]); return 42; },
    getToday: async (...args) => {
      calls.push(['today', ...args]);
      return { day: '2026-11-11', eligibleMs: 13 * 60_000, pendingPoints: 1,
        isTracking: false, incomplete: true, trackingAvailable: false };
    },
    setTracking: async (...args) => { calls.push(['tracking', ...args]); return { trackingAvailable: false }; },
    deleteData: async (...args) => { calls.push(['delete', ...args]); },
  };
  const interaction = {
    guildId: 'guild', user: { id: 'caller', bot: false },
    options: { getUser: () => null },
    client: { reputation },
    reply: async payload => { replies.push(payload); },
    deferReply: async payload => { deferred.push(payload); },
    editReply: async payload => { edits.push(payload); return { id: 'message' }; },
  };
  return { calls, replies, edits, deferred, reputation, interaction };
}

for (const action of ['balance', 'today', 'on', 'off', 'rules', 'delete']) {
  test(`${action} command is server-only, including runtime validation`, async () => {
    const f = fixture();
    const command = createMemberCommand(action);
    assert.equal(command.data.toJSON().dm_permission, false);
    f.interaction.guildId = null;
    await command.execute(f.interaction);
    assert.equal(f.replies[0].flags, MessageFlags.Ephemeral);
    assert.deepEqual(f.calls, []);
  });
}

for (const action of ['balance', 'today']) {
  test(`${action} defaults to the caller and responds publicly without pinging`, async () => {
    const f = fixture();
    await createMemberCommand(action).execute(f.interaction);
    assert.deepEqual(f.deferred, [undefined]);
    assert.deepEqual(f.calls[0], [action, 'guild', 'caller']);
    assert.deepEqual(f.edits[0].allowedMentions, { parse: [] });
  });
  test(`${action} can inspect another member through a Discord user option`, async () => {
    const f = fixture();
    f.interaction.options.getUser = () => ({ id: 'other', bot: false });
    await createMemberCommand(action).execute(f.interaction);
    assert.deepEqual(f.calls[0], [action, 'guild', 'other']);
    assert.equal(createMemberCommand(action).data.toJSON().options[0].name, 'user');
  });
}

test('balance display contains only the settled balance, not pending points', async () => {
  const f = fixture();
  await createMemberCommand('balance').execute(f.interaction);
  const embed = f.edits[0].embeds[0].toJSON();
  assert.match(embed.description, /42/);
  assert.match(embed.footer.text, /очікувані бали ще не включено/);
});

test('today displays saved duration, pending points, paused status, and coverage warning', async () => {
  const f = fixture();
  await createMemberCommand('today').execute(f.interaction);
  const embed = f.edits[0].embeds[0].toJSON();
  assert.match(embed.title, /2026-11-11/);
  assert.equal(embed.fields[0].value, '0 год 13 хв 0 с');
  assert.equal(embed.fields[1].value, '+1 балів');
  assert.equal(embed.fields[2].value, 'Tracking paused');
  assert.match(embed.description, /неповні/);
  assert.match(embed.description, /неактивний/);
});

for (const [action, enabled] of [['on', true], ['off', false]]) {
  test(`${action} changes only the caller's preference and confirms privately`, async () => {
    const f = fixture();
    f.interaction.options.getUser = () => { throw new Error('No target option is allowed'); };
    await createMemberCommand(action).execute(f.interaction);
    assert.deepEqual(f.calls, [['tracking', 'guild', 'caller', enabled]]);
    assert.equal(f.deferred[0].flags, MessageFlags.Ephemeral);
    assert.match(f.edits[0].content, /неактивний/);
  });
}

test('rules are ephemeral and do not access the database or tracker', async () => {
  const f = fixture();
  f.interaction.client = {};
  await createMemberCommand('rules').execute(f.interaction);
  assert.equal(f.replies[0].flags, MessageFlags.Ephemeral);
  const text = JSON.stringify(f.replies[0].embeds[0].toJSON());
  for (const rule of ['10', 'Europe/Kyiv', 'AFK', 'Stage', '/reputation-off', '/reputation-delete', 'резервні копії']) {
    assert.ok(text.includes(rule));
  }
});

test('bot accounts are rejected without storage work', async () => {
  const f = fixture();
  f.interaction.options.getUser = () => ({ id: 'bot', bot: true });
  await createMemberCommand('balance').execute(f.interaction);
  assert.equal(f.replies[0].flags, MessageFlags.Ephemeral);
  assert.deepEqual(f.calls, []);
});

test('read/write failures never return fabricated zero balances or log raw driver secrets', async t => {
  const log = t.mock.method(console, 'error', () => {});
  const f = fixture();
  f.reputation.getBalance = async () => { throw new Error('postgres://private:secret@host'); };
  await createMemberCommand('balance').execute(f.interaction);
  assert.match(f.edits[0].content, /Не вдалося/);
  assert.deepEqual(f.edits[0].embeds, []);
  assert.equal(JSON.stringify([...f.edits, ...log.mock.calls.map(call => call.arguments)]).includes('secret'), false);
});

function buttonInteraction(f, customId, userId = 'caller') {
  return {
    guildId: 'guild', user: { id: userId }, message: { id: 'message' }, customId,
    client: f.interaction.client,
    deferUpdate: async () => {},
    reply: f.interaction.reply,
    editReply: f.interaction.editReply,
  };
}

for (const confirm of [true, false]) {
  test(`deletion ${confirm ? 'confirmation' : 'cancellation'} consumes a caller-bound ephemeral prompt once`, async () => {
    const f = fixture();
    const confirmations = new DeletionConfirmations();
    const handlers = createReputationButtons(confirmations);
    await createMemberCommand('delete', confirmations).execute(f.interaction);
    assert.equal(f.deferred[0].flags, MessageFlags.Ephemeral);
    assert.deepEqual(f.calls, []); // Prompt alone does not modify data.
    assert.match(f.edits[0].content, /60 секунд/);
    assert.match(f.edits[0].content, /резервні копії/);
    const id = confirm ? DELETE_CONFIRM_ID : DELETE_CANCEL_ID;
    await handlers[id](buttonInteraction(f, id));
    assert.deepEqual(f.calls, confirm ? [['delete', 'guild', 'caller']] : []);
    await handlers[id](buttonInteraction(f, id));
    assert.equal(f.calls.length, confirm ? 1 : 0);
    assert.match(f.replies.at(-1).content, /використане або прострочене/);
    assert.deepEqual(f.edits.at(-1).components, []);
  });
}

test('another user cannot consume a confirmation or choose a deletion target', async () => {
  const f = fixture();
  const confirmations = new DeletionConfirmations();
  const handlers = createReputationButtons(confirmations);
  await createMemberCommand('delete', confirmations).execute(f.interaction);
  await handlers[DELETE_CONFIRM_ID](buttonInteraction(f, DELETE_CONFIRM_ID, 'attacker'));
  assert.deepEqual(f.calls, []);
  assert.match(f.replies[0].content, /не для вас/);
  await handlers[DELETE_CANCEL_ID](buttonInteraction(f, DELETE_CANCEL_ID));
});

test('expired or post-restart confirmations cannot delete data', async () => {
  const f = fixture();
  const handlers = createReputationButtons(new DeletionConfirmations());
  await handlers[DELETE_CONFIRM_ID](buttonInteraction(f, DELETE_CONFIRM_ID));
  assert.deepEqual(f.calls, []);
  assert.equal(f.replies[0].flags, MessageFlags.Ephemeral);
});

test('in-flight publication asks the owner to retry deletion without claiming erasure', async () => {
  const f = fixture();
  const confirmations = new DeletionConfirmations();
  const handlers = createReputationButtons(confirmations);
  f.reputation.deleteData = async () => { throw new PublicationPendingError(); };
  await createMemberCommand('delete', confirmations).execute(f.interaction);
  await handlers[DELETE_CONFIRM_ID](buttonInteraction(f, DELETE_CONFIRM_ID));
  assert.match(f.edits.at(-1).content, /Дані не видалено/);
  assert.match(f.edits.at(-1).content, /Публікація/);
});

test('an uncertain deletion failure does not claim success and does not permit replay', async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture();
  const confirmations = new DeletionConfirmations();
  const handlers = createReputationButtons(confirmations);
  f.reputation.deleteData = async () => { throw new Error('unknown commit outcome'); };
  await createMemberCommand('delete', confirmations).execute(f.interaction);
  await handlers[DELETE_CONFIRM_ID](buttonInteraction(f, DELETE_CONFIRM_ID));
  assert.match(f.edits.at(-1).content, /Не вдалося підтвердити/);
  assert.deepEqual(f.edits.at(-1).components, []);
  await handlers[DELETE_CONFIRM_ID](buttonInteraction(f, DELETE_CONFIRM_ID));
  assert.match(f.replies.at(-1).content, /використане або прострочене/);
});
