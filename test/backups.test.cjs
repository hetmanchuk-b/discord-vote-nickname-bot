const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Buffer } = require('node:buffer');
const { randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const process = require('node:process');
const { encryptionKey, encryptArchive, decryptArchive } = require('../scripts/backup-crypto.cjs');
const { readBackupConfig, pgEnvironment, retentionCandidates, ownedObject, runBackup, verifyBackup } = require('../scripts/backup.cjs');

const keyValue = randomBytes(32).toString('base64');
const environment = {
  DATABASE_URL: 'postgresql://backup:private%40password@db.example.invalid:5432/postgres?sslmode=require',
  S3_ENDPOINT: 'https://storage.example.invalid', S3_BUCKET: 'private-bucket',
  S3_ACCESS_KEY_ID: 'fake-access', S3_SECRET_ACCESS_KEY: 'fake-secret', BACKUP_ENCRYPTION_KEY: keyValue,
};
const oldKey = index => `votebot/postgres/backup-202610${String(index).padStart(2, '0')}T021700000Z-11111111-1111-4111-8111-111111111111.pgdump.enc`;

function storageFixture() {
  const objects = new Map();
  const calls = [];
  const directories = new Set();
  let corrupt = false;
  let exportFailure = false;
  const run = async (command, args, options) => {
    calls.push({ command, args, environment: options.env });
    if (command === 'pg_dump') {
      if (args.includes('--version')) return { stdout: 'pg_dump (PostgreSQL) 17.6', stderr: '' };
      if (exportFailure) throw new Error('private provider details');
      const file = args[args.indexOf('--file') + 1];
      directories.add(path.dirname(file));
      await fs.writeFile(file, 'PGDMP\nprivate reputation data that must never be uploaded as plaintext');
      return { stdout: '', stderr: '' };
    }
    if (command === 'pg_restore') {
      assert.equal(args[0], '--list');
      const bytes = await fs.readFile(args[1]);
      assert.equal(bytes.subarray(0, 5).toString(), 'PGDMP');
      return { stdout: '; archive catalog', stderr: '' };
    }
    assert.equal(command, 'aws');
    const operation = args[args.indexOf('s3api') + 1];
    const value = flag => args[args.indexOf(flag) + 1];
    if (operation === 'put-object') {
      assert.equal(value('--if-none-match'), '*');
      const bytes = await fs.readFile(value('--body'));
      assert.equal(bytes.includes(Buffer.from('private reputation data')), false);
      const metadata = Object.fromEntries(value('--metadata').split(',').map(pair => pair.split('=')));
      objects.set(value('--key'), { bytes, metadata });
      return { stdout: '{}', stderr: '' };
    }
    if (operation === 'get-object') {
      const object = objects.get(value('--key'));
      if (!object) throw new Error('not found');
      const bytes = Buffer.from(object.bytes);
      if (corrupt) bytes[bytes.length - 1] ^= 1;
      await fs.writeFile(args[args.indexOf('--key') + 2], bytes);
      return { stdout: JSON.stringify({ Metadata: object.metadata }), stderr: '' };
    }
    if (operation === 'list-objects-v2') {
      return { stdout: JSON.stringify({ Contents: [...objects.keys()].map(Key => ({ Key })) }), stderr: '' };
    }
    if (operation === 'delete-objects') {
      const manifest = JSON.parse(await fs.readFile(value('--delete').slice('file://'.length), 'utf8'));
      for (const { Key } of manifest.Objects) objects.delete(Key);
      return { stdout: '{}', stderr: '' };
    }
    throw new Error('Unexpected storage operation');
  };
  return { objects, calls, directories, run,
    corrupt(value = true) { corrupt = value; }, failExport() { exportFailure = true; },
  };
}

async function cryptoFixture(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'votebot-crypto-test-'));
  try { await callback(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

for (const plaintext of ['', 'PGDMP\nprivate data', 'a'.repeat(150000)]) {
  test(`AES-GCM authenticates a streaming archive (${plaintext.length} bytes)`, async () => {
    await cryptoFixture(async directory => {
      const source = path.join(directory, 'source.dump');
      const encrypted = path.join(directory, 'backup.enc');
      const restored = path.join(directory, 'restored.dump');
      await fs.writeFile(source, plaintext);
      const key = encryptionKey(keyValue);
      await encryptArchive(source, encrypted, key);
      await decryptArchive(encrypted, restored, key);
      assert.equal(await fs.readFile(restored, 'utf8'), plaintext);
      if (process.platform !== 'win32') assert.equal((await fs.stat(restored)).mode & 0o777, 0o600);
    });
  });
}

test('tampering or a wrong encryption key exposes no final plaintext and leaves no temporary decryption files', async () => {
  await cryptoFixture(async directory => {
    const source = path.join(directory, 'source.dump');
    const encrypted = path.join(directory, 'backup.enc');
    const output = path.join(directory, 'output.dump');
    await fs.writeFile(source, 'sensitive archive');
    await encryptArchive(source, encrypted, encryptionKey(keyValue));
    await assert.rejects(decryptArchive(encrypted, output, randomBytes(32)), /authenticate/);
    const bytes = await fs.readFile(encrypted);
    bytes[bytes.length - 1] ^= 1;
    await fs.writeFile(encrypted, bytes);
    await assert.rejects(decryptArchive(encrypted, output, encryptionKey(keyValue)), /authenticate/);
    await assert.rejects(fs.access(output));
    assert.deepEqual((await fs.readdir(directory)).sort(), ['backup.enc', 'source.dump']);
  });
});

test('encryption and decryption never overwrite an existing destination', async () => {
  await cryptoFixture(async directory => {
    const input = path.join(directory, 'input');
    const encrypted = path.join(directory, 'archive.enc');
    const output = path.join(directory, 'existing');
    await fs.writeFile(input, 'new');
    await fs.writeFile(output, 'keep');
    await encryptArchive(input, encrypted, encryptionKey(keyValue));
    await assert.rejects(encryptArchive(input, encrypted, encryptionKey(keyValue)));
    await assert.rejects(decryptArchive(encrypted, output, encryptionKey(keyValue)));
    assert.equal(await fs.readFile(output, 'utf8'), 'keep');
  });
});

test('configuration validation is offline, requires encryption, and defaults to no retention deletion', () => {
  const config = readBackupConfig(environment);
  assert.equal(config.prune, false);
  assert.equal(config.keep, 7);
  assert.equal(config.prefix, 'votebot/postgres/');
  assert.equal(config.pg.PGPASSWORD, 'private@password');
  assert.throws(() => readBackupConfig({ ...environment, BACKUP_ENCRYPTION_KEY: '' }), /BACKUP_ENCRYPTION_KEY/);
  assert.throws(() => encryptionKey('not-a-key'));
  assert.throws(() => readBackupConfig({ ...environment, S3_ENDPOINT: 'http://storage.invalid' }), /HTTPS/);
  assert.throws(() => readBackupConfig({ ...environment, BACKUP_PREFIX: '../' }), /BACKUP_PREFIX/);
  assert.throws(() => readBackupConfig({ ...environment, BACKUP_PRUNE_ENABLED: 'yes' }), /true or false/);
  assert.equal(readBackupConfig({ ...environment, DATABASE_URL: undefined }, false).pg, undefined);
});

test('direct database credentials use environment variables, require remote TLS, and reject proxy URLs', () => {
  assert.throws(() => pgEnvironment('prisma+postgres://host/?api_key=private'));
  assert.throws(() => pgEnvironment('postgres://user:pass@db.invalid/db?sslmode=disable'), /TLS/);
  assert.throws(() => pgEnvironment('postgres://user@db.invalid/db'), /password/);
  assert.equal(pgEnvironment('postgres://user:pass@localhost/test?sslmode=disable').PGSSLMODE, 'disable');
  const config = readBackupConfig({ ...environment, DIRECT_DATABASE_URL: 'postgres://direct:p@db.invalid/other' });
  assert.equal(config.pg.PGUSER, 'direct');
  assert.equal(config.pg.PGDATABASE, 'other');
});

test('backup uploads only authenticated ciphertext, verifies a download/catalog, and cleans up plaintext', async () => {
  const f = storageFixture();
  const config = readBackupConfig(environment);
  const result = await runBackup(config, { run: f.run, now: () => new Date('2026-11-11T02:17:00Z') });
  assert.equal(result.verified, true);
  assert.equal(f.objects.size, 1);
  assert.equal(result.removed, 0);
  assert.ok(ownedObject(config, result.key));
  assert.equal(f.calls.filter(call => call.command === 'pg_restore').length, 2);
  assert.equal(f.calls.some(call => call.args.includes('list-objects-v2')), false);
  assert.equal(f.calls.some(call => JSON.stringify(call.args).includes('private@password')), false);
  assert.equal(f.calls.some(call => JSON.stringify(call.args).includes('fake-secret')), false);
  assert.ok(config.key.equals(Buffer.from(keyValue, 'base64'))); // A run must not corrupt a reusable caller configuration.
  for (const directory of f.directories) await assert.rejects(fs.access(directory));
  await verifyBackup(config, result.key, { run: f.run }); // Reusing config must not switch to a zeroed key.
  assert.ok(f.calls.every(call => call.environment.BACKUP_ENCRYPTION_KEY === undefined));
  assert.ok(f.calls.every(call => call.environment.DATABASE_URL === undefined));
});

test('Docker exports pass passwords only through explicit environment names and map private files correctly', async () => {
  const f = storageFixture();
  const containers = [];
  const run = async (command, args, options) => {
    if (command !== 'docker') return f.run(command, args, options);
    containers.push(args);
    const mount = args[args.indexOf('--mount') + 1];
    const directory = mount.slice('type=bind,src='.length, -',dst=/backup'.length);
    const index = args.indexOf('postgres:17');
    const tool = args[index + 1];
    const translated = args.slice(index + 2).map(value => value.startsWith('/backup/') ? path.join(directory, value.slice('/backup/'.length)) : value);
    return f.run(tool, translated, options);
  };
  await runBackup(readBackupConfig({ ...environment, BACKUP_USE_DOCKER: 'true' }), { run });
  assert.ok(containers.length >= 3);
  assert.ok(containers.some(args => args.includes('PGPASSWORD')));
  assert.ok(containers.every(args => !JSON.stringify(args).includes('private@password')));
  assert.ok(containers.every(args => !args.includes('S3_SECRET_ACCESS_KEY')));
});

test('failed read-back verification never lists or deletes old backups', async () => {
  const f = storageFixture();
  f.objects.set(oldKey(1), { bytes: Buffer.from('old'), metadata: {} });
  f.corrupt();
  await assert.rejects(runBackup(readBackupConfig({ ...environment, BACKUP_PRUNE_ENABLED: 'true' }), {
    run: f.run, now: () => new Date('2026-11-11T02:17:00Z'),
  }), /remote verification/);
  assert.equal(f.calls.some(call => call.args.includes('list-objects-v2') || call.args.includes('delete-objects')), false);
  assert.ok(f.objects.has(oldKey(1)));
  for (const directory of f.directories) await assert.rejects(fs.access(directory));
});

test('opt-in retention keeps the latest verified archives and never touches other objects or prefixes', async () => {
  const f = storageFixture();
  for (let index = 1; index <= 4; index++) f.objects.set(oldKey(index), { bytes: Buffer.from('old'), metadata: {} });
  f.objects.set('images/avatar.png', { bytes: Buffer.from('keep'), metadata: {} });
  f.objects.set('votebot/postgres/not-a-managed-backup.txt', { bytes: Buffer.from('keep'), metadata: {} });
  const result = await runBackup(readBackupConfig({ ...environment, BACKUP_PRUNE_ENABLED: 'true', BACKUP_KEEP_COUNT: '2' }), {
    run: f.run, now: () => new Date('2026-11-11T02:17:00Z'),
  });
  assert.equal(result.removed, 3);
  assert.ok(f.objects.has(result.key));
  assert.ok(f.objects.has(oldKey(4)));
  assert.ok(f.objects.has('images/avatar.png'));
  assert.ok(f.objects.has('votebot/postgres/not-a-managed-backup.txt'));
  const deletion = f.calls.findIndex(call => call.args.includes('delete-objects'));
  const verification = f.calls.findLastIndex(call => call.command === 'pg_restore');
  assert.ok(deletion > verification);
});

test('retention refuses unexpected clock ordering instead of deleting the just-created backup', () => {
  const config = readBackupConfig(environment);
  assert.throws(() => retentionCandidates(config, [{ Key: oldKey(2) }, { Key: oldKey(1) }], oldKey(1)), /ordering/);
  assert.deepEqual(retentionCandidates({ ...config, keep: 1 }, [{ Key: oldKey(2) }, { Key: oldKey(1) }], oldKey(2)), [oldKey(1)]);
});

test('an export failure makes no bucket requests and never runs retention', async () => {
  const f = storageFixture(); f.failExport();
  await assert.rejects(runBackup(readBackupConfig(environment), { run: f.run }), /export/);
  assert.equal(f.calls.some(call => call.command === 'aws'), false);
});

test('the CLI configuration check works without external tools and never prints credential values', async () => {
  const execute = promisify(execFile);
  const env = { ...process.env, ...environment, BACKUP_DATABASE_URL: environment.DATABASE_URL,
    BACKUP_PREFIX: 'votebot/postgres/', BACKUP_KEEP_COUNT: '7', BACKUP_PRUNE_ENABLED: 'false', S3_REGION: 'us-east-1' };
  const script = path.join(__dirname, '../scripts/backup.cjs');
  const valid = await execute(process.execPath, [script, '--check'], { env });
  assert.match(valid.stdout, /No database or bucket requests/);
  try {
    await execute(process.execPath, [script, '--check'], { env: { ...env, S3_ENDPOINT: 'https://private:never-print-this@storage.invalid' } });
    assert.fail('Invalid endpoint must fail');
  } catch (error) {
    assert.equal(String(error.stdout ?? '').includes('never-print-this'), false);
    assert.equal(String(error.stderr ?? '').includes('never-print-this'), false);
    assert.match(error.stderr, /configuration/);
  }
});

test('the workflow is manually runnable, schedule-gated, least-privilege, and does not publish database artifacts', async () => {
  const workflow = await fs.readFile(path.join(__dirname, '../.github/workflows/database-backup.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /BACKUPS_SCHEDULE_ENABLED == 'true'/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.equal(workflow.includes('pull_request'), false);
  assert.equal(workflow.includes('upload-artifact'), false);
  assert.equal(workflow.includes('npm install'), false);
  assert.equal((workflow.match(/uses: actions\/[a-z-]+@[0-9a-f]{40}/g) ?? []).length, 2);
});
