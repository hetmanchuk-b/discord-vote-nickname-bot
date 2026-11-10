import { readFileSync } from 'node:fs';
import path from 'node:path';

interface Config {
  token: string;
  clientId: string;
}

// Load at runtime so credentials are never copied into dist by the compiler.
export function loadConfig(): Config {
  const config: unknown = JSON.parse(
    readFileSync(path.join(__dirname, '../data/config.json'), 'utf8'),
  );
  if (
    typeof config !== 'object' || config === null ||
    !('token' in config) || typeof config.token !== 'string' || !config.token ||
    !('clientId' in config) || typeof config.clientId !== 'string' || !config.clientId
  ) {
    throw new Error('data/config.json must contain non-empty token and clientId strings.');
  }
  return { token: config.token, clientId: config.clientId };
}
