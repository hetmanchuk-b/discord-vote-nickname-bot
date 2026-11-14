const assert = require('node:assert/strict');
const { test } = require('node:test');
const process = require('node:process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const url = process.env.REPUTATION_TEST_DATABASE_URL;
const body = sql => sql.replace(/^BEGIN;\r?\n/m, '').replace(/^COMMIT;\r?\n?/m, '');
async function apply(client, sql) {
  for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await client.query(statement);
}
test('review migration atomically upgrades existing cards, preserves metadata/scores/reputation, and rolls back on revision overflow', {
  skip: !url && 'Set REPUTATION_TEST_DATABASE_URL to a disposable database.',
}, async () => {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  const schema = `reviews_upgrade_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.connect(); await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
    const root = path.resolve('prisma/migrations');
    const names = (await fs.readdir(root)).filter(name => /^\d+_/.test(name) && name < '20261111130000_movie_reviews').sort();
    assert.equal(names.length, 13);
    for (const name of names) await client.query(body(await fs.readFile(path.join(root, name, 'migration.sql'), 'utf8')));
    const movieId = randomUUID(), postId = randomUUID();
    await client.query("INSERT INTO reputation_guilds(guild_id,updated_at) VALUES('1',now())");
    await client.query("INSERT INTO reputation_members(guild_id,user_id,balance_units,has_participated,attendance_streak,updated_at) VALUES('1','11',321,true,7,now())");
    await client.query("INSERT INTO movies(id,guild_id,imdb_id,title,external_ratings,revision) VALUES($1,'1','tt3896198','Movie','[]',4)", [movieId]);
    await client.query("INSERT INTO movie_ratings(movie_id,user_id,score,interaction_id) VALUES($1,'11',8,'900000000000000001')", [movieId]);
    await client.query("INSERT INTO movie_posts(id,request_id,movie_id,channel_id,message_id,status,delivered_revision) VALUES($1,'900000000000000002',$2,'22','33','active',4)", [postId,movieId]);
    const identities = async () => (await client.query("SELECT c.relname,c.oid::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r' ORDER BY c.relname")).rows;
    const oldTables = await identities(); assert.equal(oldTables.length, 15);
    const snapshot = async () => { const rows = {}; for (const table of oldTables) rows[table.relname] = (await client.query(`SELECT * FROM "${table.relname}"`)).rows; return rows; };
    const before = await snapshot();
    const migration = body(await fs.readFile(path.join(root, '20261111130000_movie_reviews', 'migration.sql'), 'utf8'));
    await client.query('SAVEPOINT overflow_guard'); await client.query('UPDATE movies SET revision=9223372036854775807');
    await assert.rejects(apply(client, migration)); await client.query('ROLLBACK TO SAVEPOINT overflow_guard');
    assert.deepEqual(await identities(), oldTables); assert.deepEqual(await snapshot(), before);
    await apply(client, migration);
    const afterTables = await identities(); assert.equal(afterTables.length, 16);
    for (const table of oldTables) assert.deepEqual(afterTables.find(after => after.relname === table.relname), table);
    const expected = { ...before, movies: before.movies.map(row => ({ ...row, revision: String(BigInt(row.revision) + 1n) })) };
    assert.deepEqual(await snapshot(), expected);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM movie_reviews')).rows[0].count, 0);
    assert.equal((await client.query('SELECT m.revision>p.delivered_revision AS pending FROM movies m JOIN movie_posts p ON p.movie_id=m.id')).rows[0].pending, true);
  } finally { try { await client.query('ROLLBACK'); } finally { await client.end(); } }
});
