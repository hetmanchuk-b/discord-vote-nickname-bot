import { loadEnvFile } from 'node:process';
import path from 'node:path';

// Resolves to the project root both from src/ and compiled dist/.
export function loadEnvironment(filePath = path.join(__dirname, '../.env')): void {
  try {
    // Existing hosting environment variables take precedence over the file.
    loadEnvFile(filePath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw new Error('Unable to load environment configuration. Check file permissions and format.', { cause: error });
  }
}

loadEnvironment();
