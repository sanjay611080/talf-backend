import { Prisma } from '@prisma/client';
import {
  BreakdownEvent,
  Database,
  Inverter,
  ModuleBuild,
  MonthlyData,
  Project,
  StoredUser,
  UserRole,
} from '../types';
import { prisma } from './prisma';
import { seedDatabase } from './seed';

/**
 * Runs a Prisma call with exponential back-off on transient connection errors.
 *
 * Supabase's pgbouncer pooler routinely drops idle connections (so a long-lived
 * process like the 10-minute cron sync occasionally sees "Can't reach database
 * server"). Prisma transparently reconnects on the *next* call, so a short
 * retry is enough to recover without losing the operation.
 *
 * Only retries network-level errors — query bugs, unique-constraint violations,
 * etc. are surfaced immediately.
 */
async function withDbRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientDbError(err)) throw err;
      // 250ms, 750ms, 2.25s, 6.75s — back off but stay under one cron interval.
      const backoffMs = 250 * Math.pow(3, i);
      console.warn(
        `[db] ${label} hit transient error (attempt ${i + 1}/${attempts}): ${
          err instanceof Error ? err.message.split('\n')[0] : String(err)
        }. Retrying in ${backoffMs}ms…`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastErr;
}

function isTransientDbError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  // Prisma surfaces network drops as PrismaClientInitializationError / Rust
  // panics with these signatures.
  return (
    /can't reach database server/i.test(message) ||
    /connection.*(closed|refused|reset|terminated)/i.test(message) ||
    /timed out/i.test(message) ||
    /Engine is not yet connected/i.test(message) ||
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(message) ||
    // Prisma's transient error codes:
    (err as { code?: string }).code === 'P1001' || // can't reach database
    (err as { code?: string }).code === 'P1002' || // timed out
    (err as { code?: string }).code === 'P1017'    // server closed connection
  );
}

/**
 * The backend keeps the whole dataset in an in-memory cache (`database`) for
 * fast synchronous reads. Supabase (via Prisma) is the source of truth: the
 * cache is hydrated from it on startup and written back on every mutation.
 */
let database: Database;

/** Loads the dataset from Supabase, seeding it on a first, empty run. */
export async function initStore(): Promise<void> {
  database = await loadFromDatabase();

  const isEmpty =
    database.users.length === 0 &&
    database.projects.length === 0 &&
    database.moduleBuilds.length === 0;

  if (isEmpty) {
    console.log('[store] Supabase database is empty — seeding initial data.');
    database = seedDatabase();
    await saveDb();
  } else {
    console.log(
      `[store] Loaded ${database.projects.length} project(s), ${database.users.length} user(s), ` +
        `${database.moduleBuilds.length} module build(s) from Supabase.`,
    );
  }
}

async function loadFromDatabase(): Promise<Database> {
  const [userRows, projectRows, moduleBuildRows, credentialsRow, syncedAtRow] = await withDbRetry(
    'loadFromDatabase',
    () =>
      Promise.all([
        prisma.user.findMany(),
        prisma.project.findMany(),
        prisma.moduleBuild.findMany(),
        prisma.solisCredentials.findFirst(),
        prisma.appMeta.findUnique({ where: { key: 'solisSyncedAt' } }),
      ]),
  );

  return {
    users: userRows.map(
      (u): StoredUser => ({
        username: u.username,
        role: u.role as UserRole,
        fullName: u.fullName ?? undefined,
        email: u.email ?? undefined,
        contact: u.contact ?? undefined,
        isActive: u.isActive,
        passwordHash: u.passwordHash,
      }),
    ),
    projects: projectRows.map(
      (p): Project => ({
        projectCode: p.projectCode,
        projectState: p.projectState,
        projectName: p.projectName,
        projectOwner: p.projectOwner,
        dateOfCommissioning: p.dateOfCommissioning,
        tariff: p.tariff,
        plantId: p.plantId ?? undefined,
        lifetimeKWh: p.lifetimeKWh ?? undefined,
        inverters: p.inverters as unknown as Inverter[],
        monthlyData: p.monthlyData as unknown as Record<string, MonthlyData>,
        breakdownEvents: p.breakdownEvents as unknown as BreakdownEvent[],
      }),
    ),
    moduleBuilds: moduleBuildRows.map(
      (m): ModuleBuild => ({
        id: m.id,
        name: m.name,
        wp: m.wp,
        area: m.area,
        degradation: m.degradation as unknown as ModuleBuild['degradation'],
      }),
    ),
    solisCredentials: credentialsRow
      ? { apiId: credentialsRow.apiId, apiSecret: credentialsRow.apiSecret, baseUrl: credentialsRow.baseUrl }
      : undefined,
    solisSyncedAt: syncedAtRow ? Number(syncedAtRow.value) : undefined,
  };
}

/** Synchronous read of the cached dataset. */
export function getDb(): Database {
  return database;
}

/** Persists the whole in-memory dataset to Supabase in one transaction. */
export async function saveDb(): Promise<void> {
  const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

  // Bulk-replace the row-set tables (small dataset, simplest correct option).
  const transactionOps: Prisma.PrismaPromise<unknown>[] = [
    prisma.project.deleteMany(),
    prisma.moduleBuild.deleteMany(),
    prisma.user.deleteMany(),
    prisma.user.createMany({
      data: database.users.map((u) => ({
        username: u.username,
        role: u.role,
        fullName: u.fullName ?? null,
        email: u.email ?? null,
        contact: u.contact ?? null,
        isActive: u.isActive !== false,
        passwordHash: u.passwordHash,
      })),
    }),
    prisma.moduleBuild.createMany({
      data: database.moduleBuilds.map((m) => ({
        id: m.id,
        name: m.name,
        wp: m.wp,
        area: m.area,
        degradation: asJson(m.degradation),
      })),
    }),
    prisma.project.createMany({
      data: database.projects.map((p) => ({
        projectCode: p.projectCode,
        projectState: p.projectState,
        projectName: p.projectName,
        projectOwner: p.projectOwner,
        dateOfCommissioning: p.dateOfCommissioning,
        tariff: p.tariff,
        plantId: p.plantId ?? null,
        lifetimeKWh: p.lifetimeKWh ?? null,
        inverters: asJson(p.inverters),
        monthlyData: asJson(p.monthlyData),
        breakdownEvents: asJson(p.breakdownEvents ?? []),
      })),
    }),
  ];

  // Single-row tables — upsert (handles "row already exists" robustly, unlike
  // a delete+create pair which can collide with the unique key under pgbouncer).
  if (database.solisCredentials) {
    const { apiId, apiSecret, baseUrl } = database.solisCredentials;
    transactionOps.push(
      prisma.solisCredentials.upsert({
        where: { id: 1 },
        create: { id: 1, apiId, apiSecret, baseUrl },
        update: { apiId, apiSecret, baseUrl },
      }),
    );
  } else {
    transactionOps.push(prisma.solisCredentials.deleteMany());
  }

  if (database.solisSyncedAt) {
    const value = String(database.solisSyncedAt);
    transactionOps.push(
      prisma.appMeta.upsert({
        where: { key: 'solisSyncedAt' },
        create: { key: 'solisSyncedAt', value },
        update: { value },
      }),
    );
  } else {
    transactionOps.push(prisma.appMeta.deleteMany({ where: { key: 'solisSyncedAt' } }));
  }

  await withDbRetry('saveDb', () => prisma.$transaction(transactionOps));
}

/**
 * Surgical update: persists ONLY one project's `monthlyData` + `lifetimeKWh`
 * (and the global `solisSyncedAt`). Used by the 10-minute cron so a routine
 * current-month refresh doesn't drag every user, module build and project
 * through a single bulk-replace transaction — which is what was failing under
 * pgbouncer. lifetimeKWh is included because the cron also refreshes Solis's
 * authoritative lifetime counter for the ALL-timeline KPI.
 */
export async function saveProjectMonthlyData(
  projectCode: string,
  monthlyData: Record<string, MonthlyData>,
  solisSyncedAt: number,
  lifetimeKWh?: number,
): Promise<void> {
  const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
  const value = String(solisSyncedAt);

  await withDbRetry('saveProjectMonthlyData', () =>
    prisma.$transaction([
      prisma.project.update({
        where: { projectCode },
        data: {
          monthlyData: asJson(monthlyData),
          ...(lifetimeKWh !== undefined ? { lifetimeKWh } : {}),
        },
      }),
      prisma.appMeta.upsert({
        where: { key: 'solisSyncedAt' },
        create: { key: 'solisSyncedAt', value },
        update: { value },
      }),
    ]),
  );
}
