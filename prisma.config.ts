import process from 'node:process';
import { defineConfig } from 'prisma/config';
import './src/environment';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Generation/validation do not need a connection. Migrate deploy requires one.
    // Use a direct endpoint for migrations if the runtime URL is pooled.
    url: process.env.DIRECT_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || '',
  },
});
