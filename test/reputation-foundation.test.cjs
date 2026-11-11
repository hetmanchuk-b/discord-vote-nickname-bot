const assert = require('node:assert/strict');
const process = require('node:process');
const { test } = require('node:test');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { loadEnvironment } = require('../dist/environment.js');
const { getDatabaseUrl, createReputationDatabase } = require('../dist/reputation/database.js');
const { createReportSettingsStore } = require('../dist/reputation/report-settings.js');
const { createSetReputationReportCommand } = require('../dist/commands/reputation/set-reputation-report.js');

const guildId = '111111111111111111';
const channelId = '222222222222222222';

function setup() {
  const saved = [];
  const replies = [];
  const edits = [];
  const deferred = [];
  const fetched = [];
  const member = { id: 'bot' };
  const channel = {
    id: channelId,
    guildId,
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
  };
  const store = {
    getReportChannelId: async () => null,
    setReportChannelId: async (...args) => { saved.push(args); },
  };
  const interaction = {
    guild: {
      id: guildId,
      channels: { fetch: async id => { fetched.push(id); return channel; } },
      members: { me: member },
    },
    memberPermissions: { has: permission => permission === PermissionFlagsBits.ManageGuild },
    options: { getString: () => channelId },
    reply: async payload => { replies.push(payload); },
    deferReply: async payload => { deferred.push(payload); },
    editReply: async payload => { edits.push(payload); },
  };
  return { store, interaction, channel, saved, replies, edits, deferred, fetched };
}

test('local environment loading is optional and does not override hosting variables', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'votebot-env-'));
  const key = 'VOTEBOT_ENVIRONMENT_TEST';
  const previous = process.env[key];
  try {
    const file = path.join(directory, '.env');
    writeFileSync(file, `${key}=local\n`);
    delete process.env[key];
    loadEnvironment(file);
    assert.equal(process.env[key], 'local');
    process.env[key] = 'hosted';
    loadEnvironment(file);
    assert.equal(process.env[key], 'hosted');
    assert.doesNotThrow(() => loadEnvironment(path.join(directory, 'missing')));
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('database configuration rejects missing or incompatible URLs without leaking values', () => {
  assert.throws(() => getDatabaseUrl({}), /DATABASE_URL is required/);
  for (const value of ['secret-invalid-url', 'https://user:secret@example.invalid', 'prisma+postgres://host/?api_key=secret']) {
    assert.throws(() => getDatabaseUrl({ DATABASE_URL: value }), error => {
      assert.equal(error.message.includes('secret'), false);
      return true;
    });
  }
  assert.equal(getDatabaseUrl({ DATABASE_URL: ' postgres://user:pass@localhost/db ' }), 'postgres://user:pass@localhost/db');
  assert.equal(getDatabaseUrl({ DATABASE_URL: 'postgresql://localhost/db' }), 'postgresql://localhost/db');
});

test('Prisma client construction and disposal do not require a reachable database', async () => {
  const database = createReputationDatabase('postgresql://unused:unused@127.0.0.1:1/unused');
  await database.$disconnect();
});

test('report settings are lazy, guild-scoped, and can replace an existing channel', async () => {
  const rows = new Map();
  const queries = [];
  let connections = 0;
  const settings = createReportSettingsStore(() => {
    connections++;
    return { reputationGuild: {
      findUnique: async query => {
        queries.push(query);
        return rows.get(query.where.guildId) ?? null;
      },
      upsert: async query => {
        queries.push(query);
        const old = rows.get(query.where.guildId);
        rows.set(query.where.guildId, old ? { ...old, ...query.update } : query.create);
      },
    } };
  });
  assert.equal(connections, 0);
  assert.equal(await settings.getReportChannelId(guildId), null);
  await settings.setReportChannelId(guildId, channelId);
  assert.equal(await settings.getReportChannelId(guildId), channelId);
  await settings.setReportChannelId(guildId, '333333333333333333');
  assert.equal(await settings.getReportChannelId(guildId), '333333333333333333');
  assert.equal(await settings.getReportChannelId('444444444444444444'), null);
  assert.deepEqual(queries[1], {
    where: { guildId },
    create: { guildId, reportChannelId: channelId },
    update: { reportChannelId: channelId },
  });
});

test('report-channel command is server-only and requires Manage Server by default', () => {
  const { store } = setup();
  const data = createSetReputationReportCommand(store).data.toJSON();
  assert.equal(data.dm_permission, false);
  assert.equal(data.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
});

test('report-channel command rechecks Manage Server before any channel or database work', async () => {
  const s = setup();
  s.interaction.memberPermissions.has = () => false;
  await createSetReputationReportCommand(s.store).execute(s.interaction);
  assert.equal(s.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(s.saved.length, 0);
  assert.equal(s.fetched.length, 0);
});

test('report-channel command rejects DMs and malformed channel IDs', async () => {
  const dm = setup();
  dm.interaction.guild = null;
  await createSetReputationReportCommand(dm.store).execute(dm.interaction);
  assert.equal(dm.replies[0].flags, MessageFlags.Ephemeral);
  const invalid = setup();
  invalid.interaction.options.getString = () => 'not-a-channel-id';
  await createSetReputationReportCommand(invalid.store).execute(invalid.interaction);
  assert.equal(invalid.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(invalid.saved.length, 0);
  assert.equal(invalid.fetched.length, 0);
});

for (const kind of ['missing', 'foreign', 'voice', 'thread', 'permissions']) {
  test(`report-channel command rejects ${kind} destination`, async () => {
    const s = setup();
    if (kind === 'missing') s.interaction.guild.channels.fetch = async () => null;
    if (kind === 'foreign') s.channel.guildId = '333333333333333333';
    if (kind === 'voice') s.channel.type = ChannelType.GuildVoice;
    if (kind === 'thread') s.channel.type = ChannelType.PublicThread;
    if (kind === 'permissions') s.channel.permissionsFor = () => ({ has: () => false });
    await createSetReputationReportCommand(s.store).execute(s.interaction);
    assert.equal(s.saved.length, 0);
    assert.equal(s.edits.length, 1);
    assert.equal(s.deferred[0].flags, MessageFlags.Ephemeral);
  });
}

test('report-channel command persists the validated destination and confirms privately', async () => {
  const s = setup();
  let permissions;
  s.channel.permissionsFor = () => ({ has: required => { permissions = required; return true; } });
  await createSetReputationReportCommand(s.store).execute(s.interaction);
  assert.deepEqual(s.saved, [[guildId, channelId]]);
  assert.deepEqual(s.deferred, [{ flags: MessageFlags.Ephemeral }]);
  assert.match(s.edits[0], new RegExp(channelId));
  assert.deepEqual(permissions, [
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory,
  ]);
});

test('database failure returns a safe error and never confirms a successful save', async t => {
  const log = t.mock.method(console, 'error', () => {});
  const s = setup();
  s.store.setReportChannelId = async () => { throw new Error('postgres://private:secret@database'); };
  await createSetReputationReportCommand(s.store).execute(s.interaction);
  assert.equal(s.edits.length, 1);
  assert.equal(s.edits[0].includes('✅'), false);
  assert.equal(JSON.stringify([...s.edits, ...log.mock.calls.map(call => call.arguments)]).includes('secret'), false);
});
