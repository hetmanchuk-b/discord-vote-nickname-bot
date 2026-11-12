const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MessageFlags } = require('discord.js');
const command = require('../dist/commands/reputation/reputation-all.js').default;
const { createMemberStore } = require('../dist/reputation/member-store.js');
const { createMemberReputation } = require('../dist/reputation/member-reputation.js');

function fixture(participants = []) {
  const edits = [], deferred = [], replies = [], calls = [];
  const interaction = {
    guildId: 'guild', user: { id: 'caller', bot: false },
    options: { getUser: () => { throw new Error('No user option'); } },
    client: { reputation: { getAll: async guildId => { calls.push(guildId); return participants; } } },
    deferReply: async payload => deferred.push(payload),
    editReply: async payload => edits.push(payload),
    reply: async payload => replies.push(payload),
  };
  return { interaction, edits, deferred, replies, calls };
}

test('reputation-all has no options and is server-only', async () => {
  const data = command.data.toJSON();
  assert.equal(data.name,'reputation-all');
  assert.equal(data.dm_permission,false);
  assert.equal(data.options.length,0);
  const f = fixture(); f.interaction.guildId = null;
  await command.execute(f.interaction);
  assert.equal(f.replies[0].flags,MessageFlags.Ephemeral);
  assert.deepEqual(f.calls,[]);
});

test('reputation-all is one ephemeral list with balances only, without pings or pagination', async () => {
  const participants = [{userId:'111111111111111111',balance:5000},{userId:'222222222222222222',balance:0},{userId:'333333333333333333',balance:-500}];
  const f = fixture(participants);
  await command.execute(f.interaction);
  assert.deepEqual(f.calls,['guild']);
  assert.deepEqual(f.deferred,[{flags:MessageFlags.Ephemeral}]);
  assert.deepEqual(f.edits,[{
    content: participants.map(row=>`<@${row.userId}> — ${row.balance.toLocaleString('uk-UA')}`).join('\n'),
    allowedMentions:{parse:[]},
  }]);
});

test('an empty reputation-all result is private and does not fabricate participants', async () => {
  const f = fixture(); await command.execute(f.interaction);
  assert.equal(f.edits[0].content,'Учасників ще немає.');
  assert.equal(f.deferred[0].flags,MessageFlags.Ephemeral);
});

test('an oversized reputation-all list is attached in full without pagination or truncation', async () => {
  const participants = Array.from({length:200},(_,i)=>({userId:String(100000000000000000n+BigInt(i)),balance:5000-i}));
  const f = fixture(participants); await command.execute(f.interaction);
  const payload = f.edits[0];
  assert.equal(f.edits.length,1);assert.equal(f.deferred[0].flags,MessageFlags.Ephemeral);
  assert.equal(payload.content,undefined);assert.equal(payload.components,undefined);assert.equal(payload.embeds,undefined);
  assert.equal(payload.files.length,1);assert.equal(payload.files[0].name,'reputation-all.txt');
  assert.equal(payload.files[0].attachment.toString('utf8'),participants.map(row=>`<@${row.userId}> — ${row.balance.toLocaleString('uk-UA')}`).join('\n'));
});

test('reputation-all failures stay private and never disclose driver secrets', async t => {
  const logs = t.mock.method(console,'error',()=>{});
  const f = fixture();
  f.interaction.client.reputation.getAll = async () => { throw new Error('postgres://private:secret@host'); };
  await command.execute(f.interaction);
  assert.equal(f.deferred[0].flags,MessageFlags.Ephemeral);
  assert.match(f.edits[0].content,/Не вдалося/);
  assert.doesNotMatch(JSON.stringify([f.edits,logs.mock.calls.map(call=>call.arguments)]),/secret|postgres:/);
});

test('participant storage is guild-scoped, includes paused/unsettled participants, and orders balances deterministically', async () => {
  const rows = [{userId:'user',balance:-5}];
  let request;
  const store = createMemberStore(()=>({reputationMember:{findMany:async args=>{request=args;return rows;}}}));
  assert.deepEqual(await store.getAll('guild'),rows);
  assert.deepEqual(request,{
    where:{guildId:'guild',OR:[{hasParticipated:true},{intervals:{some:{}}}]},
    select:{userId:true,balance:true},
    orderBy:[{balance:'desc'},{userId:'asc'}],
  });
});

test('listing settled balances never accesses or flushes the tracker and propagates failures', async () => {
  const rows = [{userId:'user',balance:7}];
  const calls = [];
  const members = createMemberReputation({
    getTracker:()=>{throw new Error('Listing must be read-only');},
    members:{getAll:async guildId=>{calls.push(guildId);return rows;}},
  });
  assert.deepEqual(await members.getAll('guild'),rows);assert.deepEqual(calls,['guild']);
  const failing = createMemberReputation({getTracker:()=>undefined,members:{getAll:async()=>{throw new Error('unavailable');}}});
  await assert.rejects(failing.getAll('guild'),/unavailable/);
});
