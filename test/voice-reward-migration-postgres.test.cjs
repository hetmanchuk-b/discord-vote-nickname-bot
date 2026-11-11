const assert=require('node:assert/strict');
const {test}=require('node:test');
const process=require('node:process');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomInt,randomUUID}=require('node:crypto');
const {Client}=require('pg');
const url=process.env.REPUTATION_TEST_DATABASE_URL;
const options={skip:!url&&'Set REPUTATION_TEST_DATABASE_URL to a disposable migrated database.'};

test('reward upgrade preserves existing penalty reservations and published deduction history',options,async()=>{
  const client=new Client({connectionString:url,connectionTimeoutMillis:5000});
  const schema=`reward_upgrade_${randomInt(100000,999999)}`;
  try{
    await client.connect();await client.query('BEGIN');await client.query(`CREATE SCHEMA "${schema}"`);await client.query(`SET LOCAL search_path TO "${schema}"`);
    const root=path.resolve('prisma/migrations');const names=(await fs.readdir(root)).filter(name=>/^\d+_/.test(name)&&name<='20261111070000_voice_penalties').sort();
    assert.equal(names.length,8);
    for(const name of names){const sql=await fs.readFile(path.join(root,name,'migration.sql'),'utf8');await client.query(sql.replace(/^BEGIN;\r?\n/m,'').replace(/^COMMIT;\r?\n?/m,''));}
    await client.query(`INSERT INTO reputation_guilds(guild_id,updated_at) VALUES('1',now())`);
    await client.query(`INSERT INTO voice_penalty_polls(id,guild_id,target_id,initiator_id,voice_channel_id,text_channel_id,amount,status,actual_fine,balance_after,published_at)
      VALUES($1,'1','11','22','33','44',50,'succeeded',50,50,now()),($2,'1','11','22','33','44',100,'creating',0,NULL,NULL)`,[randomUUID(),randomUUID()]);
    const before=(await client.query('SELECT id,status,amount,actual_fine,balance_after,published_at FROM voice_penalty_polls ORDER BY id')).rows;
    const migration=await fs.readFile(path.join(root,'20261111080000_voice_rewards','migration.sql'),'utf8');
    await client.query(migration.replace(/^BEGIN;\r?\n/m,'').replace(/^COMMIT;\r?\n?/m,''));
    assert.deepEqual((await client.query('SELECT id,status,amount,actual_fine,balance_after,published_at FROM voice_penalty_polls ORDER BY id')).rows,before);
    assert.ok((await client.query('SELECT kind FROM voice_penalty_polls')).rows.every(row=>row.kind==='penalty'));
    await client.query('SAVEPOINT kind_guard');
    await assert.rejects(client.query(`UPDATE voice_penalty_polls SET kind='invalid'`));
    await client.query('ROLLBACK TO SAVEPOINT kind_guard');
    const index=(await client.query(`SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='voice_penalty_polls_one_active_target_idx'`,[schema])).rows[0].indexdef;
    assert.match(index,/guild_id, target_id/);assert.doesNotMatch(index,/kind/);
  }finally{try{await client.query('ROLLBACK');}finally{await client.end();}}
});
