const assert = require('node:assert/strict');
const { test } = require('node:test');
const process = require('node:process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, randomInt } = require('node:crypto');
const { Client } = require('pg');

const url = process.env.REPUTATION_TEST_DATABASE_URL;
const options = { skip: !url && 'Set REPUTATION_TEST_DATABASE_URL to a disposable migrated test database.' };

test('attendance upgrade seeds enrollment/pauses, clamps only live balances, preserves history, and defers policy to next Kyiv day',options,async()=>{
  // All legacy tables live in an isolated transaction-local schema on the
  // explicitly supplied disposable database. No hosted/default URL fallback.
  const client = new Client({connectionString:url,connectionTimeoutMillis:5000});
  const schema = `attendance_upgrade_${randomInt(100000,999999)}`;
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    const root = path.resolve('prisma/migrations');
    const directories = (await fs.readdir(root)).filter(name=>/^\d+_/.test(name) && name <= '20261111050000_attendance_rewards').sort();
    assert.equal(directories.length,6);
    for (const name of directories.slice(0,5)) await client.query(await fs.readFile(path.join(root,name,'migration.sql'),'utf8'));
    await client.query(`INSERT INTO reputation_guilds(guild_id,updated_at,settled_through) VALUES ('1',now(),'2020-01-02T00:00:00Z');
      INSERT INTO reputation_members(guild_id,user_id,balance,is_tracking,updated_at) VALUES
      ('1','11',6000,true,now()),('1','22',0,false,now()),('1','33',0,true,now());`);
    const runId = randomUUID();
    await client.query(`INSERT INTO reputation_tracking_runs(id,guild_id,started_at,verified_through)
      VALUES($1,'1','2020-01-01T00:00:00Z','2020-01-02T00:00:00Z')`,[runId]);
    await client.query(`INSERT INTO reputation_voice_intervals(guild_id,user_id,run_id,started_at,ended_at)
      VALUES('1','11',$1,'2020-01-01T00:00:00Z','2020-01-01T00:10:00Z')`,[runId]);
    await client.query(`INSERT INTO reputation_settlements(guild_id,day,started_at,ended_at,verified_ms,incomplete,activity_ms,points_awarded)
      VALUES('1','2020-01-01','2020-01-01T00:00:00Z','2020-01-02T00:00:00Z',86400000,false,600001,1);
      INSERT INTO reputation_daily_awards(guild_id,user_id,day,eligible_ms,points,balance_after)
      VALUES('1','11','2020-01-01',600000,1,6000),('1','22','2020-01-01',1,0,0);`);
    const reportId = randomUUID();
    await client.query(`INSERT INTO reputation_reports(id,guild_id,day,status,entry_count,activity_ms,points_awarded)
      VALUES($1,'1','2020-01-01','published',1,600000,1)`,[reportId]);
    await client.query(`INSERT INTO reputation_report_entries(report_id,guild_id,user_id,position,eligible_ms,points,balance_after)
      VALUES($1,'1','11',0,600000,1,6000)`,[reportId]);
    const migration = await fs.readFile(path.join(root,directories[5],'migration.sql'),'utf8');
    // The production migration has its own transaction. Keep its exact DDL/data
    // statements inside our outer rollback-only fixture instead of committing it.
    await client.query(migration.replace(/^BEGIN;\r?\n/m,'').replace(/^COMMIT;\r?\n?/m,''));
    const members = (await client.query('SELECT balance,has_participated,attendance_streak,absence_streak FROM reputation_members ORDER BY user_id')).rows;
    assert.deepEqual(members,[
      {balance:5000,has_participated:true,attendance_streak:0,absence_streak:0},
      {balance:0,has_participated:true,attendance_streak:0,absence_streak:0},
      {balance:0,has_participated:false,attendance_streak:0,absence_streak:0},
    ]);
    assert.equal((await client.query(`SELECT attendance_starts_at =
      (((CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Kyiv')::date+1)::timestamp AT TIME ZONE 'Europe/Kyiv') AS next_day
      FROM reputation_guilds`)).rows[0].next_day,true);
    assert.deepEqual((await client.query(`SELECT p.user_id,p.ended_at,p.started_at=CURRENT_TIMESTAMP::timestamptz(3) AS at_migration
      FROM reputation_tracking_pauses p JOIN reputation_guilds g USING(guild_id)`)).rows,[{user_id:'22',ended_at:null,at_migration:true}]);
    assert.deepEqual((await client.query(`SELECT points,base_points,balance_after,exempt FROM reputation_daily_awards WHERE user_id='11'`)).rows[0],
      {points:1,base_points:1,balance_after:6000,exempt:true});
    assert.equal((await client.query('SELECT balance_after FROM reputation_report_entries')).rows[0].balance_after,6000);
    await client.query(`UPDATE reputation_members SET balance=-500 WHERE user_id='22'`);
    await client.query('SAVEPOINT bounds');
    await assert.rejects(client.query(`UPDATE reputation_members SET balance=-501 WHERE user_id='22'`),/reputation_members_balance_check/);
    await client.query('ROLLBACK TO SAVEPOINT bounds');
    await client.query(`INSERT INTO reputation_report_entries(report_id,guild_id,user_id,position,eligible_ms,points,balance_after)
      VALUES($1,'1','22',1,1,5,-495)`,[reportId]);
  } finally {
    try { await client.query('ROLLBACK'); } finally { await client.end(); }
  }
});
