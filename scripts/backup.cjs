const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { URL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const { Buffer } = require('node:buffer');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const process = require('node:process');
const { encryptionKey, encryptArchive, decryptArchive } = require('./backup-crypto.cjs');

const exec = promisify(execFile);
const FORMAT = 'votebot-aes256gcm-v1';
class BackupFailure extends Error {
  constructor(stage, cause) {
    super(`Backup failed during ${stage}.`, { cause });
    this.stage = stage;
  }
}

const PG_VARIABLES = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE', 'PGCONNECT_TIMEOUT', 'PGPASSFILE', 'PGSSLROOTCERT'];

function required(environment, key) {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
}
function boolean(environment, key, fallback = false) {
  const value = environment[key]?.trim() ?? String(fallback);
  if (value !== 'true' && value !== 'false') throw new Error(`${key} must be true or false.`);
  return value === 'true';
}

function pgEnvironment(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Use a direct PostgreSQL backup connection string.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || url.hash) {
    throw new Error('Use a direct PostgreSQL backup connection string.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const local = ['localhost', '127.0.0.1', '::1'].includes(host);
  if (!local && !url.password) throw new Error('The hosted database backup connection requires a password.');
  const ssl = url.searchParams.get('sslmode') ?? 'require';
  if (!['require', 'verify-full', 'verify-ca', ...(local ? ['disable'] : [])].includes(ssl)) {
    throw new Error('Remote backup connections must require TLS.');
  }
  // These require certificate files not mounted by this workflow; don't silently
  // ignore them. Provide such connections through a separately reviewed setup.
  if (['sslcert', 'sslkey', 'sslrootcert', 'service', 'host'].some(key => url.searchParams.has(key))) {
    throw new Error('Unsupported PostgreSQL backup connection options.');
  }
  return {
    PGHOST: host, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)) || 'postgres',
    PGSSLMODE: ssl, PGCONNECT_TIMEOUT: '10', PGPASSFILE: '/dev/null',
    ...(ssl === 'verify-full' ? { PGSSLROOTCERT: 'system' } : {}),
  };
}

function readBackupConfig(environment = process.env, needsDatabase = true) {
  const endpoint = new URL(required(environment, 'S3_ENDPOINT'));
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('S3_ENDPOINT must be an HTTPS endpoint without credentials or query parameters.');
  }
  const prefix = environment.BACKUP_PREFIX?.trim() || 'votebot/postgres/';
  if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{0,100}\/$/.test(prefix) || prefix.includes('//')) {
    throw new Error('BACKUP_PREFIX must be a dedicated safe path ending in /.');
  }
  const region = environment.S3_REGION?.trim() || 'us-east-1';
  if (!/^[a-z0-9-]{1,40}$/.test(region)) throw new Error('Invalid S3_REGION.');
  const keep = Number(environment.BACKUP_KEEP_COUNT || '7');
  if (!Number.isInteger(keep) || keep < 1 || keep > 3650) throw new Error('BACKUP_KEEP_COUNT must be between 1 and 3650.');
  const config = {
    endpoint: endpoint.toString().replace(/\/$/, ''), prefix, region, keep,
    bucket: required(environment, 'S3_BUCKET'), accessKey: required(environment, 'S3_ACCESS_KEY_ID'),
    secretKey: required(environment, 'S3_SECRET_ACCESS_KEY'),
    key: encryptionKey(required(environment, 'BACKUP_ENCRYPTION_KEY')),
    prune: boolean(environment, 'BACKUP_PRUNE_ENABLED'), useDocker: boolean(environment, 'BACKUP_USE_DOCKER'),
  };
  if (needsDatabase) config.pg = pgEnvironment(
    environment.BACKUP_DATABASE_URL?.trim() || environment.DIRECT_DATABASE_URL?.trim() || required(environment, 'DATABASE_URL'),
  );
  return config;
}

function ownedObject(config, key) {
  if (typeof key !== 'string' || !key.startsWith(config.prefix)) return false;
  return /^backup-\d{8}T\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pgdump\.enc$/.test(key.slice(config.prefix.length));
}

function retentionCandidates(config, objects, newestKey) {
  const keys = [...new Set(objects.map(object => object.Key).filter(key => ownedObject(config, key)))].sort().reverse();
  if (keys[0] !== newestKey) throw new Error('Backup ordering is unexpected; retention was not applied.');
  return keys.slice(config.keep); // Count archives, not calendar days; manual runs count too.
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function execute(command, args, options) {
  return exec(command, args, { ...options, timeout: 10 * 60_000, maxBuffer: 20 * 1024 * 1024, windowsHide: true });
}

function toolEnvironment() {
  // Do not give pg_dump/AWS CLI the encryption key, bot token, raw database URL,
  // or unrelated process secrets. Preserve only OS/tool/network configuration.
  const names = [
    'PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'all_proxy',
    'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
  ];
  return Object.fromEntries(names.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
}

function tools(config, directory, run = execute) {
  const pgPath = name => config.useDocker ? `/backup/${name}` : path.join(directory, name);
  async function pg(tool, args) {
    const env = toolEnvironment();
    Object.assign(env, config.pg ?? {});
    if (!config.useDocker && process.platform === 'win32') env.PGPASSFILE = 'NUL';
    if (!config.useDocker) return run(tool, args, { env });
    const user = typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
    const variables = config.pg ? PG_VARIABLES.filter(name => env[name] !== undefined).flatMap(name => ['--env', name]) : [];
    return run('docker', [
      'run', '--rm', ...user, '--env', 'HOME=/tmp', ...variables,
      '--mount', `type=bind,src=${directory},dst=/backup`, 'postgres:17', tool, ...args,
    ], { env });
  }
  async function aws(args) {
    const env = toolEnvironment();
    Object.assign(env, {
      AWS_ACCESS_KEY_ID: config.accessKey, AWS_SECRET_ACCESS_KEY: config.secretKey,
      AWS_CONFIG_FILE: path.join(directory, 'aws-config'), AWS_SHARED_CREDENTIALS_FILE: path.join(directory, 'unused-credentials'),
      AWS_REGION: config.region, AWS_DEFAULT_REGION: config.region, AWS_EC2_METADATA_DISABLED: 'true',
      AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required', AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
      AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off',
    });
    return run('aws', ['--endpoint-url', config.endpoint, '--region', config.region, '--no-cli-pager', 's3api', ...args], { env });
  }
  return { pg, aws, pgPath };
}

async function prepareDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'votebot-backup-'));
  try {
    await fs.chmod(directory, 0o700);
    await fs.writeFile(path.join(directory, 'aws-config'), '[default]\ns3 =\n    addressing_style = path\n', { mode: 0o600 });
    return directory;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function verifyRemote(config, key, directory, cli) {
  if (!ownedObject(config, key)) throw new Error('Only an owned backup key may be verified.');
  const encrypted = path.join(directory, 'download.enc');
  const archive = path.join(directory, 'verified.dump');
  const response = await cli.aws(['get-object', '--bucket', config.bucket, '--key', key, encrypted, '--output', 'json']);
  const metadata = JSON.parse(response.stdout).Metadata;
  if (metadata?.format !== FORMAT || !/^[a-f0-9]{64}$/.test(metadata?.sha256 ?? '') ||
      await hashFile(encrypted) !== metadata.sha256) throw new Error('Remote backup checksum verification failed.');
  await decryptArchive(encrypted, archive, config.key);
  await cli.pg('pg_restore', ['--list', cli.pgPath('verified.dump')]);
}

async function runBackup(configuration, { run = execute, now = () => new Date() } = {}) {
  const config = { ...configuration, key: Buffer.from(configuration.key) };
  const directory = await prepareDirectory();
  const cli = tools(config, directory, run);
  let stage = 'export';
  try {
    const version = await cli.pg('pg_dump', ['--version']);
    if (Number(/PostgreSQL\)\s+(\d+)/.exec(version.stdout)?.[1] ?? 0) !== 17) throw new Error('Use pg_dump 17 so archives remain compatible with the workflow restore tool.');
    await cli.pg('pg_dump', [
      '--format=custom', '--schema=public', '--no-owner', '--no-privileges', '--lock-wait-timeout=10000',
      '--file', cli.pgPath('database.dump'),
    ]);
    await fs.chmod(path.join(directory, 'database.dump'), 0o600);
    if (!(await fs.stat(path.join(directory, 'database.dump'))).size) throw new Error('Empty dump.');
    await cli.pg('pg_restore', ['--list', cli.pgPath('database.dump')]);
    stage = 'encryption';
    const encrypted = path.join(directory, 'backup.enc');
    await encryptArchive(path.join(directory, 'database.dump'), encrypted, config.key);
    await fs.rm(path.join(directory, 'database.dump')); // Keep plaintext only as long as needed.
    const sha256 = await hashFile(encrypted);
    const stamp = now().toISOString().replace(/[-:.]/g, '');
    const key = `${config.prefix}backup-${stamp}-${randomUUID()}.pgdump.enc`;
    stage = 'upload';
    await cli.aws([
      'put-object', '--bucket', config.bucket, '--key', key, '--body', encrypted,
      '--content-type', 'application/octet-stream', '--metadata', `sha256=${sha256},format=${FORMAT}`, '--if-none-match', '*',
    ]);
    stage = 'remote verification';
    await verifyRemote(config, key, directory, cli);
    let removed = 0;
    if (config.prune) {
      stage = 'retention';
      const listing = JSON.parse((await cli.aws(['list-objects-v2', '--bucket', config.bucket, '--prefix', config.prefix, '--output', 'json'])).stdout);
      const candidates = retentionCandidates(config, listing.Contents ?? [], key);
      for (let offset = 0; offset < candidates.length; offset += 1000) {
        const keys = candidates.slice(offset, offset + 1000);
        const manifest = path.join(directory, 'delete.json');
        await fs.writeFile(manifest, JSON.stringify({ Objects: keys.map(Key => ({ Key })), Quiet: true }), { mode: 0o600 });
        const deleted = JSON.parse((await cli.aws(['delete-objects', '--bucket', config.bucket, '--delete', `file://${manifest}`, '--output', 'json'])).stdout);
        if (deleted.Errors?.length) throw new Error('Some retained objects could not be removed.');
        removed += keys.length;
      }
    }
    return { verified: true, removed, key };
  } catch (error) {
    throw new BackupFailure(stage, error);
  } finally {
    config.key.fill(0);
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function verifyBackup(configuration, key, { run = execute } = {}) {
  const config = { ...configuration, key: Buffer.from(configuration.key) };
  const directory = await prepareDirectory();
  try { await verifyRemote(config, key, directory, tools(config, directory, run)); }
  catch (error) { throw new BackupFailure('stored verification', error); }
  finally { config.key.fill(0); await fs.rm(directory, { recursive: true, force: true }); }
}

module.exports = { readBackupConfig, pgEnvironment, ownedObject, retentionCandidates, hashFile, runBackup, verifyBackup };

if (require.main === module) {
  (async () => {
    try { process.loadEnvFile(path.join(__dirname, '../.env')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const mode = process.argv[2];
    if (!['--check', '--backup', '--verify'].includes(mode) || process.argv.length !== 3) throw new Error('Choose --check, --backup, or --verify.');
    const config = readBackupConfig(process.env, mode !== '--verify');
    if (mode === '--check') {
      config.key.fill(0);
      console.log('Backup configuration is valid. No database or bucket requests were made.');
    } else if (mode === '--backup') {
      const result = await runBackup(config);
      console.log(`Encrypted backup uploaded and verified. Retention removed ${result.removed} owned archive(s).`);
    } else {
      await verifyBackup(config, required(process.env, 'BACKUP_VERIFY_KEY'));
      console.log('Stored backup checksum, authentication, and archive catalog verified. No database restore was performed.');
    }
  })().catch(error => {
    // Only this fixed stage label is safe to print. Never print child stderr,
    // URLs, decoded passwords, object contents, or exception causes.
    const stage = error instanceof BackupFailure ? error.stage : 'configuration';
    console.error(`Backup failed during ${stage}. Check configuration, tools, access, and BACKUPS.md. No credentials have been logged.`);
    process.exitCode = 1;
  });
}
