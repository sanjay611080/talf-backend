/**
 * Reads every project from Supabase and prints the total installed DC capacity.
 *
 *   DC capacity per inverter (kWdc) = moduleCount × moduleBuild.wp / 1000
 *   Total                          = Σ over all inverters in all projects
 *
 * Run with:  npx tsx scripts/total-dc-capacity.ts
 */
import { PrismaClient } from '@prisma/client';

type Inverter = {
  name: string;
  kwac: number;
  moduleCount?: number;
  moduleBuildId?: string;
};

type ModuleBuild = {
  id: string;
  wp: number;
};

async function main() {
  const prisma = new PrismaClient();
  try {
    const [projectRows, buildRows] = await Promise.all([
      prisma.project.findMany(),
      prisma.moduleBuild.findMany(),
    ]);

    const buildMap = new Map<string, ModuleBuild>(
      buildRows.map((b) => [b.id, { id: b.id, wp: b.wp }]),
    );

    let grandTotalKWdc = 0;
    let grandTotalKWac = 0;
    let totalInverters = 0;
    let inverterssWithoutBuild = 0;

    type Row = { project: string; kWdc: number; kWac: number; inverters: number };
    const rows: Row[] = [];

    for (const p of projectRows) {
      const inverters = (p.inverters as unknown as Inverter[]) || [];
      let kWdc = 0;
      let kWac = 0;
      for (const inv of inverters) {
        kWac += inv.kwac || 0;
        const build = inv.moduleBuildId ? buildMap.get(inv.moduleBuildId) : undefined;
        const wp = build?.wp || 0;
        const count = inv.moduleCount || 0;
        kWdc += (count * wp) / 1000;
        if (!build) inverterssWithoutBuild++;
      }
      rows.push({ project: p.projectName, kWdc, kWac, inverters: inverters.length });
      grandTotalKWdc += kWdc;
      grandTotalKWac += kWac;
      totalInverters += inverters.length;
    }

    rows.sort((a, b) => b.kWdc - a.kWdc);

    console.log('\n=== Installed DC capacity per project ===\n');
    console.log('  kWdc    | kWac    | Inv | Project');
    console.log('  --------+---------+-----+---------------------------');
    for (const r of rows) {
      console.log(
        `  ${r.kWdc.toFixed(2).padStart(7)} | ${r.kWac.toFixed(2).padStart(7)} | ${String(r.inverters).padStart(3)} | ${r.project}`,
      );
    }

    console.log('\n=== Totals ===');
    console.log(`  Projects:                ${projectRows.length}`);
    console.log(`  Inverters:               ${totalInverters}`);
    console.log(`  Total installed DC:      ${grandTotalKWdc.toFixed(2)} kWdc  (${(grandTotalKWdc / 1000).toFixed(3)} MWdc)`);
    console.log(`  Total installed AC:      ${grandTotalKWac.toFixed(2)} kWac  (${(grandTotalKWac / 1000).toFixed(3)} MWac)`);
    console.log(`  DC / AC ratio:           ${grandTotalKWac > 0 ? (grandTotalKWdc / grandTotalKWac).toFixed(3) : '—'}`);
    if (inverterssWithoutBuild > 0) {
      console.log(
        `\n  Note: ${inverterssWithoutBuild} inverter(s) had no moduleBuildId — those contribute 0 to DC capacity.`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
