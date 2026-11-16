const assert = require('node:assert/strict');
const { test } = require('node:test');
const process = require('node:process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const url = process.env.REPUTATION_TEST_DATABASE_URL;
const body = sql => sql.replace(/^BEGIN;\r?\n/m, '').replace(/^COMMIT;\r?\n?/m, '');
test('report solo migration preserves every historical value and leaves uncaptured solo detail unknown, even with retained daily data', {
  skip: !url && 'Set REPUTATION_TEST_DATABASE_URL to a disposable database.',
}, async () => {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  const schema = `report_solo_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.connect(); await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
    const root = path.resolve('prisma/migrations');
    const names = (await fs.readdir(root)).filter(name => /^\d+_/.test(name) && name < '20261111140000_report_solo_time').sort();
    assert.equal(names.length, 14);
    for (const name of names) await client.query(body(await fs.readFile(path.join(root, name, 'migration.sql'), 'utf8')));
    const reportId = randomUUID();
    await client.query("INSERT INTO reputation_guilds(guild_id,updated_at) VALUES('1',now())");
    await client.query("INSERT INTO reputation_members(guild_id,user_id,balance_units,has_participated,attendance_streak,updated_at) VALUES('1','11',321,true,7,now())");
    await client.query("INSERT INTO reputation_settlements(guild_id,day,started_at,ended_at,verified_ms,incomplete,activity_ms,points_awarded_units) VALUES('1','2026-11-11','2026-11-10T22:00:00Z','2026-11-11T22:00:00Z',86400000,false,1200000,4)");
    await client.query("INSERT INTO reputation_daily_awards(guild_id,user_id,day,eligible_ms,solo_ms,points_units,balance_after_units) VALUES('1','11','2026-11-11',1200000,755000,4,321)");
    await client.query("INSERT INTO reputation_reports(id,guild_id,day,status,entry_count,published_at) VALUES($1,'1','2026-11-11','published',1,now())", [reportId]);
    await client.query("INSERT INTO reputation_report_entries(report_id,guild_id,user_id,position,eligible_ms,points_units,balance_after_units) VALUES($1,'1','11',0,1200000,4,321)", [reportId]);
    const identities = async () => (await client.query("SELECT c.relname,c.oid::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r' ORDER BY c.relname")).rows;
    const tables = await identities(); assert.equal(tables.length, 16);
    const snapshot = async () => {
      const result = {};
      for (const table of tables) {
        const value = table.relname === 'reputation_report_entries' ? "(to_jsonb(t)-'solo_ms')" : 'to_jsonb(t)';
        result[table.relname] = (await client.query(`SELECT ${value}::text AS row FROM "${table.relname}" t ORDER BY ${value}::text`)).rows;
      }
      return result;
    };
    const before = await snapshot();
    await client.query(body(await fs.readFile(path.join(root, '20261111140000_report_solo_time', 'migration.sql'), 'utf8')));
    assert.deepEqual(await identities(), tables); assert.deepEqual(await snapshot(), before);
    assert.equal((await client.query('SELECT solo_ms FROM reputation_report_entries')).rows[0].solo_ms, null);
    await client.query('UPDATE reputation_report_entries SET solo_ms=755000');
    assert.equal((await client.query('SELECT solo_ms FROM reputation_report_entries')).rows[0].solo_ms, 755000);
    for (const invalid of [-1, 1200001]) {
      await client.query('SAVEPOINT duration_guard');
      await assert.rejects(client.query('UPDATE reputation_report_entries SET solo_ms=$1', [invalid]));
      await client.query('ROLLBACK TO SAVEPOINT duration_guard');
    }
  } finally { try { await client.query('ROLLBACK'); } finally { await client.end(); } }
});
