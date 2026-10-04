import type { Prisma, PrismaClient } from '@prisma/client';

/** Either the root client or an interactive-transaction client. */
export type Db = PrismaClient | Prisma.TransactionClient;
