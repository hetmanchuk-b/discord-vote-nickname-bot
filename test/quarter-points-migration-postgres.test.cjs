const assert=require('node:assert/strict');
const {test}=require('node:test');
const process=require('node:process');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {Client}=require('pg');
const url=process.env.REPUTATION_TEST_DATABASE_URL;
const options={skip:!url&&'Set REPUTATION_TEST_DATABASE_URL to a disposable database.'};
const tables=['reputation_members','reputation_settlements','reputation_daily_awards','reputation_reports','reputation_report_entries','voice_reputation_polls','voice_reputation_votes','reputation_voice_intervals','reputation_tracking_runs'];
const sqlBody=sql=>sql.replace(/^BEGIN;\r?\n/m,'').replace(/^COMMIT;\r?\n?/m,'');
async function applyMigration(client,sql){
  // Execute inside the surrounding transaction one statement at a time. This
  // also gives PostgreSQL-compatible test servers an unambiguous error boundary.
  for(const statement of sql.split(';').map(part=>part.trim()).filter(Boolean))await client.query(statement);
}
async function snapshot(client){
  const result={};for(const table of tables)result[table]=(await client.query(`SELECT * FROM ${table}`)).rows.sort((a,b)=>
    JSON.stringify([a.guild_id,a.user_id,a.day,a.id,a.report_id,a.position,a.poll_id]).localeCompare(JSON.stringify([b.guild_id,b.user_id,b.day,b.id,b.report_id,b.position,b.poll_id])));
  return result;
}
function normalized(rows){
  return rows.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=='solo_ms'&&key!=='earning_rate')
    .map(([key,value])=>key.endsWith('_units')?[key.slice(0,-6),value===null?null:value/4]:[key,value])));
}

test('quarter migration preserves all financial values, audit, IDs and durations; overflow rolls back and old SQL cannot mutate units',options,async()=>{
  const client=new Client({connectionString:url,connectionTimeoutMillis:5000});
  const schema=`quarter_upgrade_${randomUUID().replaceAll('-','')}`;
  try{
    await client.connect();await client.query('BEGIN');await client.query(`CREATE SCHEMA "${schema}"`);await client.query(`SET LOCAL search_path TO "${schema}"`);
    const root=path.resolve('prisma/migrations');
    const historical=(await fs.readdir(root)).filter(name=>/^\d+_/.test(name)&&name<='20261111100000_voice_poll_reasons').sort();
    assert.equal(historical.length,11);
    for(const name of historical)await client.query(sqlBody(await fs.readFile(path.join(root,name,'migration.sql'),'utf8')));
    const run=randomUUID(),report=randomUUID(),penalty=randomUUID(),reward=randomUUID(),active=randomUUID();
    await client.query("INSERT INTO reputation_guilds(guild_id,updated_at) VALUES('1',now())");
    await client.query("INSERT INTO reputation_members(guild_id,user_id,balance,has_participated,attendance_streak,absence_streak,updated_at) VALUES('1','11',100,true,7,0,now()),('1','22',-500,true,0,8,now()),('1','33',5000,true,17,0,now())");
    await client.query(`INSERT INTO reputation_tracking_runs(id,guild_id,started_at,verified_through) VALUES($1,'1','2026-11-01T00:00:00Z','2026-11-02T00:00:00Z')`,[run]);
    await client.query(`INSERT INTO reputation_voice_intervals(guild_id,user_id,run_id,started_at,ended_at) VALUES('1','11',$1,'2026-11-01T00:00:00Z','2026-11-01T00:10:00Z')`,[run]);
    await client.query("INSERT INTO reputation_settlements(guild_id,day,started_at,ended_at,verified_ms,incomplete,activity_ms,points_awarded) VALUES('1','2026-11-01','2026-10-31T22:00:00Z','2026-11-01T22:00:00Z',86400000,false,600000,-4)");
    await client.query("INSERT INTO reputation_daily_awards(guild_id,user_id,day,eligible_ms,points,balance_after,base_points,attendance_bonus,absence_penalty,attendance_streak,absence_streak,exempt) VALUES('1','11','2026-11-01',600000,1,6000,1,0,0,7,0,true),('1','22','2026-11-01',0,-5,-500,0,0,5,0,8,false)");
    await client.query(`INSERT INTO reputation_reports(id,guild_id,day,status,activity_ms,points_awarded,entry_count,published_at) VALUES($1,'1','2026-11-01','published',600000,1,1,now())`,[report]);
    await client.query(`INSERT INTO reputation_report_entries(report_id,guild_id,user_id,position,eligible_ms,points,balance_after) VALUES($1,'1','11',0,600000,1,6000)`,[report]);
    await client.query(`INSERT INTO voice_reputation_polls(id,guild_id,target_id,initiator_id,voice_channel_id,text_channel_id,amount,kind,status,applied_amount,balance_before,balance_after,published_at,proposal_reason)
      VALUES($1,'1','11','44','55','66',50,'penalty','succeeded',20,100,80,now(),'old fine'),
            ($2,'1','33','44','55','66',100,'reward','succeeded',20,4980,5000,now(),'old reward'),
            ($3,'1','11','44','55','66',10,'penalty','creating',0,NULL,NULL,NULL,'active reservation')`,[penalty,reward,active]);
    await client.query(`INSERT INTO voice_reputation_votes(poll_id,user_id,yes,interaction_id) VALUES($1,'44',true,'200000000000000001')`,[active]);
    const before=await snapshot(client);
    const migration=sqlBody(await fs.readFile(path.join(root,'20261111110000_quarter_points_and_solo_rate','migration.sql'),'utf8'));
    await client.query('SAVEPOINT overflow_guard');
    await client.query('UPDATE reputation_report_entries SET balance_after=2147483647');
    await assert.rejects(applyMigration(client,migration));
    await client.query('ROLLBACK TO SAVEPOINT overflow_guard');
    assert.deepEqual(await snapshot(client),before); // No partial scaling or constraint removal.
    await applyMigration(client,migration);
    const after=await snapshot(client);
    for(const table of tables)assert.deepEqual(normalized(after[table]),before[table]);
    assert.equal(after.reputation_members.find(row=>row.user_id==='11').balance_units,400);
    assert.equal(after.reputation_report_entries[0].balance_after_units,24000); // Never clamp historical snapshots.
    assert.equal(after.voice_reputation_polls.find(row=>row.id===active).amount_units,40);
    assert.ok(after.reputation_voice_intervals.every(row=>row.earning_rate===4));
    assert.ok(after.reputation_daily_awards.every(row=>row.solo_ms===0));
    await client.query('SAVEPOINT legacy_guard');
    await assert.rejects(client.query("UPDATE reputation_members SET balance=50 WHERE user_id='11'"));
    await client.query('ROLLBACK TO SAVEPOINT legacy_guard');
    assert.deepEqual(await snapshot(client),after);
  }finally{try{await client.query('ROLLBACK');}finally{await client.end();}}
});
