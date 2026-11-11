const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { Buffer } = require('node:buffer');
const { createReadStream, createWriteStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const process = require('node:process');
const { pipeline } = require('node:stream/promises');

const MAGIC = Buffer.from('VOTEBOT_BACKUP_V1\n', 'ascii');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function encryptionKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error('BACKUP_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new Error('BACKUP_ENCRYPTION_KEY must be a canonical base64-encoded 32-byte key.');
  }
  return key;
}

async function encryptArchive(input, output, key) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  let created = false;
  try {
    await fs.writeFile(output, Buffer.concat([MAGIC, iv]), { flag: 'wx', mode: 0o600 });
    created = true;
    await pipeline(createReadStream(input), cipher, createWriteStream(output, { flags: 'a', mode: 0o600 }));
    await fs.appendFile(output, cipher.getAuthTag());
  } catch (error) {
    if (created) await fs.rm(output, { force: true });
    throw new Error('Could not encrypt the archive.', { cause: error });
  }
}

async function decryptArchive(input, output, key) {
  // Authenticate before exposing the final plaintext path. A failed decryption
  // removes its temporary output and never overwrites an existing destination.
  const directory = await fs.mkdtemp(path.join(path.dirname(output), '.votebot-decrypt-'));
  const temporary = path.join(directory, 'archive.dump');
  try {
    const handle = await fs.open(input, 'r');
    let size;
    const header = Buffer.alloc(MAGIC.length + IV_LENGTH);
    const tag = Buffer.alloc(TAG_LENGTH);
    try {
      size = (await handle.stat()).size;
      if (size < header.length + TAG_LENGTH) throw new Error('Invalid encrypted archive.');
      await handle.read(header, 0, header.length, 0);
      await handle.read(tag, 0, tag.length, size - TAG_LENGTH);
    } finally { await handle.close(); }
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Unsupported backup format.');
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length));
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    if (size === header.length + TAG_LENGTH) {
      await fs.writeFile(temporary, decipher.final(), { flag: 'wx', mode: 0o600 });
    } else {
      await pipeline(
        createReadStream(input, { start: header.length, end: size - TAG_LENGTH - 1 }),
        decipher, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      );
    }
    await fs.copyFile(temporary, output, require('node:fs').constants.COPYFILE_EXCL);
    await fs.chmod(output, 0o600);
  } catch (error) {
    throw new Error('Could not authenticate/decrypt the archive; check the key and file.', { cause: error });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

module.exports = { encryptionKey, encryptArchive, decryptArchive };

if (require.main === module) {
  (async () => {
    try { process.loadEnvFile(path.join(__dirname, '../.env')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const [operation, input, output] = process.argv.slice(2);
    if (operation !== 'decrypt' || !input || !output || process.argv.length !== 5) throw new Error('Usage: decrypt INPUT.enc OUTPUT.dump');
    await decryptArchive(input, output, encryptionKey(process.env.BACKUP_ENCRYPTION_KEY));
    console.log('Archive authenticated and decrypted. Keep the plaintext private and remove it after use.');
  })().catch(() => {
    console.error('Decryption failed. Check paths, key, archive integrity, and that the output does not already exist.');
    process.exitCode = 1;
  });
}
