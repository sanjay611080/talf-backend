import { getDb, saveDb, saveProjectMonthlyData } from '../db/store';
import { Inverter, MonthlyData, ModuleBuild, Project, SolisStation, SolisInverterSummary, SolisSyncStatus } from '../types';
import { getActiveCredentials, getInverterMonth, getInverterYear, listInverters, listStations } from './solisService';
import { logAuditEvent } from './auditHelper';

// Corrects SolisCloud's occasional unit mislabeling (MWh reported at kWh scale).
// Divides down any value exceeding the physical max (kwac × 24h × 31 days).
export function normalizeMonthlyKWh(rawKWh: number, kwac: number): number {
  if (!Number.isFinite(rawKWh) || rawKWh <= 0) return 0;
  if (kwac <= 0) return rawKWh;
  const physicalMax = kwac * 24 * 31; // 100% CF for a 31-day month
  let v = rawKWh;
  while (v > physicalMax) v /= 1000;
  return v;
}

let status: SolisSyncStatus = { state: 'idle', message: 'Not started', totalSteps: 0, doneSteps: 0 };
let running = false;
let nextSyncAt: number | undefined;

export function getSyncStatus(): SolisSyncStatus {
  return { ...status, lastSyncedAt: getDb().solisSyncedAt, nextSyncAt };
}

export function isSyncRunning(): boolean {
  return running;
}

export function setNextSyncAt(timestamp: number | undefined): void {
  nextSyncAt = timestamp;
}

function buildProjectShell(
  station: SolisStation,
  inverters: SolisInverterSummary[],
  prev: Project | undefined,
  defaultBuild: ModuleBuild | undefined,
): Project {
  const prevInvBySn = new Map((prev?.inverters || []).map((i) => [i.solisSn || i.deviceSn || '', i]));
  const totalKwac = inverters.reduce((sum, i) => sum + (i.capacityKW || 0), 0);
  const panelWp = defaultBuild?.wp || 540;
  const invCount = inverters.length;

  return {
    projectCode: station.id,
    projectName: station.name || station.id,
    projectState: prev?.projectState || station.address || '—',
    projectOwner: prev?.projectOwner || 'SolisCloud',
    // SolisCloud timestamps are UTC+8; shift to get the correct calendar date.
    dateOfCommissioning: station.firstGenerationTime
      ? new Date(station.firstGenerationTime + 8 * 3600 * 1000).toISOString().slice(0, 10) + 'T00:00:00.000Z'
      : prev?.dateOfCommissioning || new Date().toISOString(),
    tariff: prev?.tariff || station.pricePerKWh || 0,
    plantId: station.id || undefined,
    // station.totalEnergyKWh is the authoritative lifetime roll-up (includes replaced inverters).
    lifetimeKWh: station.totalEnergyKWh > 0 ? station.totalEnergyKWh : prev?.lifetimeKWh,
    inverters: inverters.map((iv): Inverter => {
      const old = prevInvBySn.get(iv.sn);
      // Prorated share of station capacity for this inverter.
      const share = totalKwac > 0 ? (iv.capacityKW || 0) / totalKwac : 1 / invCount;
      // Prefer admin-set moduleCount; fall back to SolisCloud station.module or derive from DC capacity.
      let moduleCount = old?.moduleCount;
      if (moduleCount === undefined) {
        if (station.moduleCount > 0) {
          moduleCount = Math.round(station.moduleCount * share);
        } else if (station.capacityKW > 0) {
          // moduleCount = stationDCkW × share × 1000 / Wp
          moduleCount = Math.round((station.capacityKW * share * 1000) / panelWp);
        }
      }
      return {
        name: iv.name || iv.sn,
        kwac: iv.capacityKW || old?.kwac || 0,
        deviceSn: iv.sn,
        solisSn: iv.sn,
        moduleCount,
        moduleBuildId: old?.moduleBuildId || defaultBuild?.id,
      };
    }),
    monthlyData: {},
    breakdownEvents: prev?.breakdownEvents || [],
  };
}

// Placeholder monthly POA irradiation for Delhi region (kWh/m²) — replaced when admin enters real values.
const MONTHLY_POA_KWH_M2: Record<number, number> = {
  1: 115, 2: 125, 3: 155, 4: 170, 5: 175, 6: 155,
  7: 130, 8: 125, 9: 135, 10: 145, 11: 120, 12: 108,
};

// DC capacity priority: moduleCount × Wp > station capacity (prorated) > AC nameplate.
function dcCapacityKW(
  inv: Inverter,
  project: Project,
  stationCapacityKW: number,
  buildMap: Map<string, ModuleBuild>,
): number {
  const build = inv.moduleBuildId ? buildMap.get(inv.moduleBuildId) : undefined;
  // DC capacity = moduleCount × Wp / 1000
  const fromModules = ((inv.moduleCount || 0) * (build?.wp || 0)) / 1000;
  if (fromModules > 0) return fromModules;

  if (stationCapacityKW > 0) {
    const totalKwac = project.inverters.reduce((sum, i) => sum + (i.kwac || 0), 0);
    return totalKwac > 0
      ? stationCapacityKW * ((inv.kwac || 0) / totalKwac)
      : stationCapacityKW / project.inverters.length;
  }
  return inv.kwac;
}

function buildMonthlyData(
  project: Project,
  stationCapacityKW: number,
  monthlyExport: Record<string, number[]>,
  monthlyImport: Record<string, number>,
  prev: Project | undefined,
): Record<string, MonthlyData> {
  const buildMap = new Map(getDb().moduleBuilds.map((b) => [b.id, b]));
  const invCount = project.inverters.length;
  const dcCapacity = project.inverters.map((inv) => dcCapacityKW(inv, project, stationCapacityKW, buildMap));

  const result: Record<string, MonthlyData> = {};
  for (const month of Object.keys(monthlyExport)) {
    const prevMonth = prev?.monthlyData?.[month];
    const exportArr = monthlyExport[month];
    const importKWh = Math.round(monthlyImport[month] || 0);

    // Placeholder O&M target: ~93% of actual generation until admin sets real values.
    const omTarget =
      prevMonth?.inverterTargetOMKWh?.length === invCount
        ? prevMonth.inverterTargetOMKWh
        : exportArr.map((e) => Math.round(e * 0.93));

    const monthNum = parseInt(month.split('-')[1], 10);
    const poa = MONTHLY_POA_KWH_M2[monthNum] ?? 140;
    const irradiation =
      prevMonth?.inverterIrradiation?.length === invCount
        ? prevMonth.inverterIrradiation
        : project.inverters.map(() => poa);

    const netActual = exportArr.reduce((sum, v) => sum + v, 0) - importKWh;
    // Placeholder P50: 97% of actual net generation until admin sets real values.
    const p50 = prevMonth?.targetNetKWhP50 || Math.round(netActual * 0.97);

    result[month] = {
      month,
      electricityImportedKWh: importKWh,
      targetNetKWhP50: p50,
      inverterExportKWh: exportArr,
      inverterTargetOMKWh: omTarget,
      inverterIrradiation: irradiation,
      inverterDcCapacityKW: dcCapacity,
    };
  }
  return result;
}

export async function runFullSync(): Promise<void> {
  if (running) return;
  if (!getActiveCredentials()) {
    status = { state: 'error', message: 'SolisCloud credentials are not configured.', totalSteps: 0, doneSteps: 0 };
    return;
  }

  running = true;
  status = { state: 'running', message: 'Fetching stations from SolisCloud…', totalSteps: 0, doneSteps: 0, startedAt: Date.now(), kind: 'full' };

  try {
    const stations = await listStations(1, 100);
    const nowYear = new Date().getFullYear();
    const merged = new Map(getDb().projects.map((p) => [p.projectCode, p]));
    const moduleBuilds = getDb().moduleBuilds;
    const defaultBuild = moduleBuilds.find((b) => b.name === 'Default 540Wp Mono PERC') || moduleBuilds[0];

    const plan: { station: SolisStation; inverters: SolisInverterSummary[]; startYear: number }[] = [];
    for (const station of stations) {
      const inverters = await listInverters(station.id);
      const startYear = station.firstGenerationTime
        ? new Date(station.firstGenerationTime).getFullYear()
        : nowYear;
      plan.push({ station, inverters, startYear });
    }
    status.totalSteps = plan.reduce((sum, p) => sum + p.inverters.length * (nowYear - p.startYear + 1), 0);
    status.message = `Fetching generation history for ${stations.length} stations…`;

    let syncedCount = 0;
    for (const { station, inverters, startYear } of plan) {
      const prev = merged.get(station.id);
      const project = buildProjectShell(station, inverters, prev, defaultBuild);

      const monthlyExport: Record<string, number[]> = {};
      const monthlyImport: Record<string, number> = {};

      for (let idx = 0; idx < inverters.length; idx++) {
        const sn = inverters[idx].sn;
        const kwac = inverters[idx].capacityKW;
        for (let year = startYear; year <= nowYear; year++) {
          try {
            const yearData = sn ? await getInverterYear(sn, year) : [];
            for (const rec of yearData) {
              if (!monthlyExport[rec.month]) {
                monthlyExport[rec.month] = inverters.map(() => 0);
                monthlyImport[rec.month] = 0;
              }
              monthlyExport[rec.month][idx] = Math.round(normalizeMonthlyKWh(rec.exportKWh, kwac));
              monthlyImport[rec.month] += normalizeMonthlyKWh(rec.gridPurchasedKWh, kwac);
            }
          } catch (err) {
            console.error(`[solis-sync] ${station.name} / ${sn} / ${year}:`, err instanceof Error ? err.message : err);
          }
          status.doneSteps++;
        }
      }

      project.monthlyData = buildMonthlyData(project, station.capacityKW, monthlyExport, monthlyImport, prev);
      merged.set(station.id, project);
      syncedCount++;

      // Persist after each station so partial progress survives a crash.
      getDb().projects = [...merged.values()];
      await saveDb();
    }

    getDb().projects = [...merged.values()];
    getDb().solisSyncedAt = Date.now();
    await saveDb();

    const durationSec = Math.round((Date.now() - (status.startedAt || Date.now())) / 1000);
    status = {
      state: 'done',
      message: `Synced ${syncedCount} station(s) from SolisCloud.`,
      totalSteps: status.totalSteps,
      doneSteps: status.totalSteps,
      startedAt: status.startedAt,
      finishedAt: Date.now(),
    };
    logAuditEvent({
      performedBy: 'system',
      action: 'sync',
      entityType: 'sync',
      entityId: 'solis-full',
      description: `Full SolisCloud sync completed — ${syncedCount} station(s) in ${durationSec}s`,
      metadata: { kind: 'full', stationCount: syncedCount, durationSec },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'SolisCloud sync failed.';
    status = {
      state: 'error',
      message: msg,
      totalSteps: status.totalSteps,
      doneSteps: status.doneSteps,
      startedAt: status.startedAt,
      finishedAt: Date.now(),
    };
    logAuditEvent({
      performedBy: 'system',
      action: 'sync',
      entityType: 'sync',
      entityId: 'solis-full',
      description: `Full SolisCloud sync failed: ${msg}`,
      metadata: { kind: 'full', error: msg },
    });
  } finally {
    running = false;
  }
}

// Refreshes current year per inverter; preserves history and admin-entered fields.
export async function runIncrementalSync(): Promise<void> {
  if (running) return;
  if (!getActiveCredentials()) {
    status = { state: 'error', message: 'SolisCloud credentials are not configured.', totalSteps: 0, doneSteps: 0 };
    return;
  }

  running = true;
  const year = new Date().getFullYear();
  const projects = getDb().projects;
  status = {
    state: 'running',
    message: `Refreshing ${year} data for ${projects.length} project(s)...`,
    totalSteps: projects.reduce((sum, p) => sum + p.inverters.length, 0),
    doneSteps: 0,
    startedAt: Date.now(),
  };

  let lifetimeByStationId = new Map<string, number>();
  try {
    const stations = await listStations(1, 100);
    lifetimeByStationId = new Map(
      stations.filter((s) => s.totalEnergyKWh > 0).map((s) => [s.id, s.totalEnergyKWh] as [string, number]),
    );
  } catch (err) {
    console.error('[solis-sync] incremental: failed to refresh lifetime totals:', err instanceof Error ? err.message : err);
  }

  try {
    for (const project of projects) {
      const stationLifetime = project.plantId ? lifetimeByStationId.get(project.plantId) : undefined;
      if (stationLifetime !== undefined) project.lifetimeKWh = stationLifetime;

      const monthlyExport: Record<string, number[]> = {};
      const monthlyImport: Record<string, number> = {};

      for (let idx = 0; idx < project.inverters.length; idx++) {
        const inv = project.inverters[idx];
        const sn = inv.deviceSn || inv.solisSn || inv.psKey || '';
        if (sn) {
          try {
            const yearData = await getInverterYear(sn, year);
            for (const rec of yearData) {
              if (!monthlyExport[rec.month]) {
                monthlyExport[rec.month] = project.inverters.map(() => 0);
                monthlyImport[rec.month] = 0;
              }
              monthlyExport[rec.month][idx] = Math.round(normalizeMonthlyKWh(rec.exportKWh, inv.kwac));
              monthlyImport[rec.month] += normalizeMonthlyKWh(rec.gridPurchasedKWh, inv.kwac);
            }
          } catch (err) {
            console.error('[solis-sync] incremental', project.projectName, sn, err instanceof Error ? err.message : err);
          }
        }
        status.doneSteps++;
      }

      const refreshed = buildMonthlyData(project, 0, monthlyExport, monthlyImport, project);
      project.monthlyData = { ...project.monthlyData, ...refreshed };
      await saveDb();
    }

    getDb().solisSyncedAt = Date.now();
    await saveDb();
    status = {
      state: 'done',
      message: `Refreshed ${year} data for ${projects.length} project(s).`,
      totalSteps: status.totalSteps,
      doneSteps: status.totalSteps,
      startedAt: status.startedAt,
      finishedAt: Date.now(),
      kind: 'incremental',
    };
  } catch (err) {
    status = {
      state: 'error',
      message: err instanceof Error ? err.message : 'Incremental sync failed.',
      totalSteps: status.totalSteps,
      doneSteps: status.doneSteps,
      startedAt: status.startedAt,
      finishedAt: Date.now(),
      kind: 'incremental',
    };
  } finally {
    running = false;
  }
}

// Refreshes only current-month export and DC capacity; never touches admin-editable fields.
export async function runCronSync(): Promise<void> {
  if (running) return;
  if (!getActiveCredentials()) {
    status = { state: 'error', message: 'SolisCloud credentials are not configured.', totalSteps: 0, doneSteps: 0, kind: 'cron' };
    return;
  }

  const projects = getDb().projects.filter((p) => !!p.plantId);
  if (projects.length === 0) return;

  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const totalSteps = projects.reduce((sum, p) => sum + p.inverters.length, 0);

  running = true;
  status = {
    state: 'running',
    message: `Refreshing ${month} generation for ${projects.length} project(s)…`,
    totalSteps,
    doneSteps: 0,
    startedAt: Date.now(),
    kind: 'cron',
  };

  const buildMap = new Map(getDb().moduleBuilds.map((b) => [b.id, b]));

  let lifetimeByStationId = new Map<string, number>();
  try {
    const stations = await listStations(1, 100);
    lifetimeByStationId = new Map(
      stations.filter((s) => s.totalEnergyKWh > 0).map((s) => [s.id, s.totalEnergyKWh] as [string, number]),
    );
  } catch (err) {
    console.error('[solis-cron] failed to refresh lifetime totals:', err instanceof Error ? err.message : err);
  }

  try {
    for (const project of projects) {
      const stationLifetime = project.plantId ? lifetimeByStationId.get(project.plantId) : undefined;
      if (stationLifetime !== undefined) project.lifetimeKWh = stationLifetime;

      const existing = project.monthlyData[month];
      const refreshed: MonthlyData = existing
        ? {
            ...existing,
            inverterExportKWh: [...(existing.inverterExportKWh || [])],
            inverterTargetOMKWh: [...(existing.inverterTargetOMKWh || [])],
            inverterIrradiation: [...(existing.inverterIrradiation || [])],
            inverterDcCapacityKW: [...(existing.inverterDcCapacityKW || [])],
          }
        : {
            month,
            electricityImportedKWh: 0,
            targetNetKWhP50: 0,
            inverterExportKWh: project.inverters.map(() => 0),
            inverterTargetOMKWh: project.inverters.map(() => 0),
            inverterIrradiation: project.inverters.map(() => 0),
            inverterDcCapacityKW: project.inverters.map(() => 0),
          };

      // Ensure arrays stay in sync with the current inverter count.
      const pad = <T,>(arr: T[], fill: T) =>
        arr.length === project.inverters.length
          ? arr
          : [...arr, ...new Array(Math.max(0, project.inverters.length - arr.length)).fill(fill)].slice(0, project.inverters.length);
      refreshed.inverterExportKWh = pad(refreshed.inverterExportKWh, 0);
      refreshed.inverterTargetOMKWh = pad(refreshed.inverterTargetOMKWh, 0);
      refreshed.inverterIrradiation = pad(refreshed.inverterIrradiation, 0);
      refreshed.inverterDcCapacityKW = pad(refreshed.inverterDcCapacityKW, 0);

      for (let idx = 0; idx < project.inverters.length; idx++) {
        const inv = project.inverters[idx];
        const sn = inv.deviceSn || inv.solisSn || inv.psKey || '';
        if (sn) {
          try {
            const monthKWh = await getInverterMonth(sn, month);
            const normalized = Math.round(normalizeMonthlyKWh(monthKWh, inv.kwac));
            // Only advance the reading — never overwrite with a transient API zero.
            if (normalized >= (refreshed.inverterExportKWh[idx] || 0)) {
              refreshed.inverterExportKWh[idx] = normalized;
            }
          } catch (err) {
            console.error('[solis-cron]', project.projectName, sn, err instanceof Error ? err.message : err);
          }
        }
        // DC capacity = moduleCount × Wp / 1000
        refreshed.inverterDcCapacityKW[idx] = ((inv.moduleCount || 0) * (buildMap.get(inv.moduleBuildId || '')?.wp || 0)) / 1000;
        status.doneSteps++;
      }

      project.monthlyData[month] = refreshed;

      try {
        await saveProjectMonthlyData(project.projectCode, project.monthlyData, Date.now(), project.lifetimeKWh);
      } catch (err) {
        console.error('[solis-cron] failed to persist', project.projectName, err instanceof Error ? err.message : err);
      }
    }

    getDb().solisSyncedAt = Date.now();
    status = {
      state: 'done',
      message: `Refreshed ${month} for ${projects.length} project(s).`,
      totalSteps,
      doneSteps: totalSteps,
      startedAt: status.startedAt,
      finishedAt: Date.now(),
      kind: 'cron',
    };
    logAuditEvent({
      performedBy: 'system',
      action: 'sync',
      entityType: 'sync',
      entityId: 'solis-cron',
      description: `Auto-sync (cron) refreshed ${month} for ${projects.length} project(s)`,
      metadata: { kind: 'cron', month, projectCount: projects.length },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Cron sync failed.';
    status = {
      state: 'error',
      message: msg,
      totalSteps: status.totalSteps,
      doneSteps: status.doneSteps,
      startedAt: status.startedAt,
      finishedAt: Date.now(),
      kind: 'cron',
    };
  } finally {
    running = false;
  }
}
