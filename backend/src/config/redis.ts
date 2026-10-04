import { Redis } from 'ioredis';
import { env } from './env.js';

let connection: Redis | null = null;

/** Shared connection. BullMQ requires maxRetriesPerRequest: null. */
export function redis(): Redis {
  connection ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

export async function closeRedis() {
  await connection?.quit();
  connection = null;
}
