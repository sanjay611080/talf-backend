import { PrismaClient } from '@prisma/client';

/** Single shared Prisma client for the whole backend process. */
export const prisma = new PrismaClient();
