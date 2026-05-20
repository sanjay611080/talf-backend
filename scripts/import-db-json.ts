/**
 * One-time migration: load the existing data/db.json into Supabase, replacing
 * whatever is currently in the database. Run with:  npx tsx scripts/import-db-json.ts
 */
import fs from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/db/prisma';

const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

(async () => {
  const dbJsonPath = path.join(__dirname, '..', 'data', 'db.json');
  if (!fs.existsSync(dbJsonPath)) {
    console.error('data/db.json not found — nothing to import.');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(dbJsonPath, 'utf8'));
  const users = data.users || [];
  const projects = data.projects || [];
  const moduleBuilds = data.moduleBuilds || [];

  console.log(
    `Read db.json — ${projects.length} project(s), ${users.length} user(s), ${moduleBuilds.length} module build(s).`,
  );

  await prisma.$transaction([
    prisma.appMeta.deleteMany(),
    prisma.solisCredentials.deleteMany(),
    prisma.project.deleteMany(),
    prisma.moduleBuild.deleteMany(),
    prisma.user.deleteMany(),
    prisma.user.createMany({
      data: users.map((u: any) => ({
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
      data: moduleBuilds.map((m: any) => ({
        id: m.id,
        name: m.name,
        wp: m.wp,
        area: m.area,
        degradation: asJson(m.degradation),
      })),
    }),
    prisma.project.createMany({
      data: projects.map((p: any) => ({
        projectCode: p.projectCode,
        projectState: p.projectState,
        projectName: p.projectName,
        projectOwner: p.projectOwner,
        dateOfCommissioning: p.dateOfCommissioning,
        tariff: p.tariff,
        plantId: p.plantId != null ? String(p.plantId) : null,
        inverters: asJson(p.inverters ?? []),
        monthlyData: asJson(p.monthlyData ?? {}),
        breakdownEvents: asJson(p.breakdownEvents ?? []),
      })),
    }),
    ...(data.solisCredentials
      ? [
          prisma.solisCredentials.create({
            data: {
              id: 1,
              apiId: data.solisCredentials.apiId,
              apiSecret: data.solisCredentials.apiSecret,
              baseUrl: data.solisCredentials.baseUrl,
            },
          }),
        ]
      : []),
    ...(data.solisSyncedAt
      ? [prisma.appMeta.create({ data: { key: 'solisSyncedAt', value: String(data.solisSyncedAt) } })]
      : []),
  ]);

  const counts = {
    users: await prisma.user.count(),
    projects: await prisma.project.count(),
    moduleBuilds: await prisma.moduleBuild.count(),
  };
  console.log('Imported into Supabase:', JSON.stringify(counts));
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('Import failed:', e);
  await prisma.$disconnect();
  process.exit(1);
});
