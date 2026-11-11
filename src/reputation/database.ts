import '../environment.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export function getDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const connectionString = environment.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to use reputation storage.');
  }

  let protocol: string;
  try {
    protocol = new URL(connectionString).protocol;
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection string.');
  }
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use postgres:// or postgresql:// for the PostgreSQL adapter.');
  }
  return connectionString;
}

// No connection is made during command discovery, deployment, or client construction.
// A small lazy pool keeps existing commands usable without a reputation database.
export function createReputationDatabase(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({
    connectionString,
    max: 3,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    query_timeout: 12_000,
    application_name: 'votebot-reputation',
  });
  return new PrismaClient({ adapter, log: [] });
}

let database: PrismaClient | undefined;

export function getReputationDatabase(): PrismaClient {
  database ??= createReputationDatabase(getDatabaseUrl());
  return database;
}

export async function disconnectReputationDatabase(): Promise<void> {
  if (!database) return;
  const current = database;
  database = undefined;
  await current.$disconnect();
}
