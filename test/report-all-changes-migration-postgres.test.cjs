const assert=require('node:assert/strict');
const {test}=require('node:test');
const process=require('node:process');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {Client}=require('pg');
const url=process.env.REPUTATION_TEST_DATABASE_URL;
const body=sql=>sql.replace(/^BEGIN;\r?\n/m,'').replace(/^COMMIT;\r?\n?/m,'');
test('all-change report migration preserves historical money/pagination semantics and enables signed, checked new snapshots',{
 skip:!url&&'Set REPUTATION_TEST_DATABASE_URL to a disposable database.',
},async()=>{
 const client=new Client({connectionString:url,connectionTimeoutMillis:5000}),schema=`report_changes_${randomUUID().replaceAll('-','')}`;
 try{
  await client.connect();await client.query('BEGIN');await client.query(`CREATE SCHEMA "${schema}"`);await client.query(`SET LOCAL search_path TO "${schema}"`);
  const root=path.resolve('prisma/migrations'),names=(await fs.readdir(root)).filter(name=>/^\d+_/.test(name)&&name<'20261111150000_all_daily_changes').sort();
  assert.equal(names.length,15);
  for(const name of names)await client.query(body(await fs.readFile(path.join(root,name,'migration.sql'),'utf8')));
  const reportId=randomUUID();
  await client.query("INSERT INTO reputation_guilds(guild_id,updated_at) VALUES('1',now())");
  await client.query("INSERT INTO reputation_members(guild_id,user_id,balance_units,has_participated,updated_at) VALUES('1','11',321,true,now())");
  await client.query("INSERT INTO reputation_settlements(guild_id,day,started_at,ended_at,verified_ms,incomplete,activity_ms,points_awarded_units) VALUES('1','2026-11-11','2026-11-10T22:00:00Z','2026-11-11T22:00:00Z',86400000,false,600000,4),('1','2026-11-12','2026-11-11T22:00:00Z','2026-11-12T22:00:00Z',86400000,false,0,-20)");
  await client.query("INSERT INTO reputation_reports(id,guild_id,day,status,entry_count,points_awarded_units,published_at) VALUES($1,'1','2026-11-11','published',1,4,now())",[reportId]);
  await client.query("INSERT INTO reputation_report_entries(report_id,guild_id,user_id,position,eligible_ms,solo_ms,points_units,balance_after_units) VALUES($1,'1','11',0,600000,100000,4,321)",[reportId]);
  const identities=async()=>(await client.query("SELECT c.relname,c.oid::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r' ORDER BY c.relname")).rows;
  const tables=await identities();assert.equal(tables.length,16);
  const snapshot=async()=>{const result={};for(const table of tables){
   const value=table.relname==='reputation_reports'?"(to_jsonb(t)-'page_size'-'format_version')":table.relname==='reputation_report_entries'?"(to_jsonb(t)-'daily_points_units'-'vote_rewards_units'-'vote_penalties_units'-'reward_vote_count'-'penalty_vote_count')":'to_jsonb(t)';
   result[table.relname]=(await client.query(`SELECT ${value}::text AS row FROM "${table.relname}" t ORDER BY ${value}::text`)).rows;
  }return result;};
  const before=await snapshot();
  await client.query(body(await fs.readFile(path.join(root,'20261111150000_all_daily_changes','migration.sql'),'utf8')));
  assert.deepEqual(await identities(),tables);assert.deepEqual(await snapshot(),before);
  assert.deepEqual((await client.query('SELECT page_size,format_version FROM reputation_reports')).rows,[{page_size:10,format_version:1}]);
  assert.equal((await client.query('SELECT daily_points_units FROM reputation_report_entries')).rows[0].daily_points_units,null);
  const next=randomUUID();
  await client.query("INSERT INTO reputation_reports(id,guild_id,day,points_awarded_units,entry_count) VALUES($1,'1','2026-11-12',-20,1)",[next]);
  assert.deepEqual((await client.query('SELECT page_size,format_version FROM reputation_reports WHERE id=$1',[next])).rows,[{page_size:15,format_version:2}]);
  await client.query("INSERT INTO reputation_report_entries(report_id,guild_id,user_id,position,eligible_ms,points_units,balance_after_units,daily_points_units,vote_rewards_units,vote_penalties_units,reward_vote_count,penalty_vote_count) VALUES($1,'1','11',0,0,-20,301,-20,0,0,0,0)",[next]);
  await client.query('UPDATE reputation_report_entries SET points_units=0,vote_rewards_units=40,vote_penalties_units=20,reward_vote_count=1,penalty_vote_count=1 WHERE report_id=$1',[next]);
  for(const sql of ['UPDATE reputation_report_entries SET points_units=1 WHERE report_id=$1','UPDATE reputation_reports SET page_size=7 WHERE id=$1']){
   await client.query('SAVEPOINT invalid_change');await assert.rejects(client.query(sql,[next]));await client.query('ROLLBACK TO SAVEPOINT invalid_change');
  }
 }finally{try{await client.query('ROLLBACK');}finally{await client.end();}}
});
