const assert = require('node:assert/strict');
const { test } = require('node:test');
const process = require('node:process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const url = process.env.REPUTATION_TEST_DATABASE_URL;
test('movie migration only adds independent tables and preserves existing reputation rows and table identities', {
  skip: !url && 'Set REPUTATION_TEST_DATABASE_URL to a disposable database.',
}, async () => {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  const schema = `movies_upgrade_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.connect(); await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
    const root = path.resolve('prisma/migrations');
    const names = (await fs.readdir(root)).filter(name => /^\d+_/.test(name) && name < '20261111120000_movie_ratings').sort();
    assert.equal(names.length, 12);
    for (const name of names) {
      const sql = (await fs.readFile(path.join(root, name, 'migration.sql'), 'utf8')).replace(/^BEGIN;\r?\n/m, '').replace(/^COMMIT;\r?\n?/m, '');
      await client.query(sql);
    }
    await client.query("INSERT INTO reputation_guilds(guild_id,updated_at) VALUES('1',now())");
    await client.query("INSERT INTO reputation_members(guild_id,user_id,balance_units,has_participated,attendance_streak,absence_streak,updated_at) VALUES('1','11',377,true,7,0,now())");
    const identities = async () => (await client.query("SELECT c.relname,c.oid::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r' ORDER BY c.relname")).rows;
    const previousTables = await identities(); assert.equal(previousTables.length, 12);
    const before = {};
    for (const { relname } of previousTables) before[relname] = (await client.query(`SELECT * FROM "${relname}"`)).rows;
    await client.query(await fs.readFile(path.join(root, '20261111120000_movie_ratings', 'migration.sql'), 'utf8'));
    const afterTables = await identities(); assert.equal(afterTables.length, 15);
    for (const identity of previousTables) {
      assert.deepEqual(afterTables.find(table => table.relname === identity.relname), identity);
      assert.deepEqual((await client.query(`SELECT * FROM "${identity.relname}"`)).rows, before[identity.relname]);
    }
    assert.deepEqual(afterTables.filter(table => !previousTables.some(previous => previous.relname === table.relname)).map(table => table.relname), ['movie_posts', 'movie_ratings', 'movies']);
    const references = (await client.query("SELECT c.confrelid::regclass::text AS parent FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=current_schema() AND t.relname IN ('movies','movie_ratings','movie_posts') AND c.contype='f'")).rows;
    assert.ok(references.every(row => row.parent === 'movies')); // No participation/financial identity dependency.
  } finally { try { await client.query('ROLLBACK'); } finally { await client.end(); } }
});
