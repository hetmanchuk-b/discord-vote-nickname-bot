const assert = require('node:assert/strict');
const { test } = require('node:test');
const process = require('node:process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../dist/generated/prisma/client.js');
const { createVoicePollStore } = require('../dist/reputation/voice-poll-store.js');
const { renderVoicePoll, voicePollMarker } = require('../dist/reputation/voice-poll-render.js');

const url = process.env.REPUTATION_TEST_DATABASE_URL;
const options = { skip: !url && 'Set REPUTATION_TEST_DATABASE_URL to a disposable migrated database.' };
const guildId = '999999999999999999', target = '111111111111111111', recipient = '222222222222222222';
const initiator = '333333333333333333', voter = '444444444444444444';

// Historical migrations are intentionally unchanged. Rebuild their actual schema,
// upgrade real active/published rows, then exercise the new Prisma interface.
test('neutral rename preserves all poll/vote data and OIDs and resumes both original button protocols', options, async () => {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  const schema = `poll_rename_${randomUUID().replaceAll('-','')}`;
  let committed = false;
  let scoped;
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    const root = path.resolve('prisma/migrations');
    const historical = (await fs.readdir(root)).filter(name => /^\d+_/.test(name) && name <= '20261111080000_voice_rewards').sort();
    assert.equal(historical.length,9);
    for (const name of historical) {
      const sql = await fs.readFile(path.join(root,name,'migration.sql'),'utf8');
      await client.query(sql.replace(/^BEGIN;\r?\n/m,'').replace(/^COMMIT;\r?\n?/m,''));
    }
    await client.query(`INSERT INTO reputation_guilds(guild_id,updated_at) VALUES($1,now())`,[guildId]);
    await client.query(`INSERT INTO reputation_members(guild_id,user_id,balance,has_participated,updated_at)
      VALUES($1,$2,100,true,now()),($1,$3,4980,true,now())`,[guildId,target,recipient]);
    const penalty = randomUUID(), reward = randomUUID(), published = randomUUID(), failed = randomUUID();
    const at = new Date(), ends = new Date(at.getTime()+120000);
    await client.query(`INSERT INTO voice_penalty_polls(id,guild_id,target_id,initiator_id,voice_channel_id,text_channel_id,message_id,amount,kind,status,started_at,ends_at)
      VALUES($1,$3,$4,$6,'666666666666666666','777777777777777777','888888888888888881',50,'penalty','active',$7,$8),
            ($2,$3,$5,$6,'666666666666666666','777777777777777777','888888888888888882',100,'reward','active',$7,$8)`,
    [penalty,reward,guildId,target,recipient,initiator,at,ends]);
    await client.query(`INSERT INTO voice_penalty_polls(id,guild_id,target_id,initiator_id,voice_channel_id,text_channel_id,message_id,amount,kind,status,actual_fine,balance_before,balance_after,closed_at,published_at,no_voter_ids)
      VALUES($1,$3,$4,$5,'666666666666666666','777777777777777777','888888888888888883',50,'reward','succeeded',50,100,150,now(),now(),ARRAY[]::text[]),
            ($2,$3,$4,$5,'666666666666666666','777777777777777777','888888888888888884',10,'penalty','failed',0,NULL,NULL,now(),now(),ARRAY[$6]::text[])`,
    [published,failed,guildId,target,initiator,voter]);
    await client.query(`INSERT INTO voice_penalty_votes(poll_id,user_id,yes,interaction_id)
      VALUES($1,$3,true,'100000000000000001'),($1,$4,false,'100000000000000002'),($2,$3,true,'100000000000000003')`,
    [penalty,reward,initiator,voter]);
    const polls = (await client.query('SELECT * FROM voice_penalty_polls ORDER BY id')).rows;
    const votes = (await client.query('SELECT * FROM voice_penalty_votes ORDER BY poll_id,user_id')).rows;
    const members = (await client.query('SELECT * FROM reputation_members ORDER BY user_id')).rows;
    const oids = (await client.query(`SELECT 'voice_penalty_polls'::regclass::oid AS polls, 'voice_penalty_votes'::regclass::oid AS votes`)).rows[0];
    const migration = await fs.readFile(path.join(root,'20261111090000_neutral_voice_polls','migration.sql'),'utf8');
    await client.query(migration.replace(/^BEGIN;\r?\n/m,'').replace(/^COMMIT;\r?\n?/m,''));
    const after = (await client.query('SELECT * FROM voice_reputation_polls ORDER BY id')).rows;
    assert.deepEqual(after,polls.map(({actual_fine,...row})=>({...row,applied_amount:actual_fine})));
    assert.deepEqual((await client.query('SELECT * FROM voice_reputation_votes ORDER BY poll_id,user_id')).rows,votes);
    assert.deepEqual((await client.query('SELECT * FROM reputation_members ORDER BY user_id')).rows,members);
    assert.deepEqual((await client.query(`SELECT 'voice_reputation_polls'::regclass::oid AS polls, 'voice_reputation_votes'::regclass::oid AS votes`)).rows[0],oids);
    assert.deepEqual((await client.query(`SELECT to_regclass('voice_penalty_polls') AS polls,to_regclass('voice_penalty_votes') AS votes`)).rows[0],{polls:null,votes:null});
    const constraints = (await client.query(`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace=$1::regnamespace`,[schema])).rows;
    const indexes = (await client.query('SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1',[schema])).rows;
    assert.ok(constraints.every(row=>!row.conname.startsWith('voice_penalty_')));
    assert.ok(indexes.every(row=>!row.indexname.startsWith('voice_penalty_')));
    assert.ok(indexes.some(row=>row.indexname==='voice_reputation_polls_publication_retry_idx'));
    const direction = constraints.find(row=>row.conname==='voice_reputation_polls_reward_direction_check');
    assert.match(direction.definition,/applied_amount/);assert.doesNotMatch(direction.definition,/actual_fine/);
    const unique = indexes.find(row=>row.indexname==='voice_reputation_polls_one_active_target_idx');
    assert.match(unique.indexdef,/UNIQUE.*guild_id, target_id/);assert.match(unique.indexdef,/creating.*active/);
    const fk = constraints.find(row=>row.conname==='voice_reputation_votes_poll_id_fkey');
    assert.match(fk.definition,/REFERENCES voice_reputation_polls/);
    await client.query('COMMIT');committed = true;

    scoped = new PrismaClient({ adapter: new PrismaPg({ connectionString:url,max:1 },{schema}), log:[] });
    const store = createVoicePollStore(()=>scoped);
    const original = await store.get(penalty), originalReward = await store.get(reward);
    assert.equal(renderVoicePoll(original).components[0].components[0].data.custom_id,`voice-penalty:${penalty}:yes`);
    assert.equal(renderVoicePoll(originalReward).components[0].components[1].data.custom_id,`voice-reward:${reward}:no`);
    assert.equal(voicePollMarker(penalty,false),`VP:${penalty}:active`);
    await store.vote({id:penalty,guildId,textChannelId:original.textChannelId,messageId:original.messageId,userId:voter,
      kind:'penalty',yes:true,interactionId:'200000000000000001'});
    for (const poll of [original,originalReward]) {
      const end = new Date(Date.now()-100);
      await scoped.voiceReputationPoll.update({where:{id:poll.id},data:{startedAt:new Date(end.getTime()-120000),endsAt:end}});
      const result = await store.finish(poll.id,{at:new Date(),userIds:[initiator,voter]});
      assert.equal(result.status,'succeeded');
      assert.equal(result.appliedAmount,poll.kind==='penalty'?50:20);
    }
    assert.equal((await scoped.reputationMember.findUniqueOrThrow({where:{guildId_userId:{guildId,userId:target}}})).balance,50);
    assert.equal((await scoped.reputationMember.findUniqueOrThrow({where:{guildId_userId:{guildId,userId:recipient}}})).balance,5000);
    assert.equal((await store.finish(reward,null)).appliedAmount,20); // Still idempotent after upgrade.
    assert.equal((await store.get(published)).appliedAmount,50);
    assert.deepEqual((await store.get(failed)).noVoterIds,[voter]);
    assert.equal((await scoped.voiceReputationVote.count()),0);
  } finally {
    try {
      if (scoped) await scoped.$disconnect();
      if (committed) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      else await client.query('ROLLBACK');
    } finally { await client.end(); }
  }
});
