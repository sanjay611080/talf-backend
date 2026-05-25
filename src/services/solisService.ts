import { SOLIS_API_ID, SOLIS_API_SECRET, SOLIS_BASE_URL } from '../config';
import { getDb, saveDb } from '../db/store';
import {
  DailyCurvePoint,
  InverterRealTime,
  ModuleBuild,
  MonthlyData,
  Project,
  SolisCredentials,
  SolisInverterSummary,
  SolisStation,
} from '../types';
import { solisPost } from './solisClient';

export const DEFAULT_SOLIS_BASE_URL = 'https://www.soliscloud.com:13333';

export type CredentialSource = 'environment' | 'database' | 'none';

function envCredentials(): SolisCredentials | undefined {
  if (SOLIS_API_ID && SOLIS_API_SECRET) {
    return { apiId: SOLIS_API_ID, apiSecret: SOLIS_API_SECRET, baseUrl: SOLIS_BASE_URL || DEFAULT_SOLIS_BASE_URL };
  }
  return undefined;
}

export function getStoredCredentials(): SolisCredentials | undefined {
  return getDb().solisCredentials;
}

// Environment variables take precedence over UI-saved credentials.
export function getActiveCredentials(): SolisCredentials | undefined {
  return envCredentials() || getStoredCredentials();
}

export function getCredentialSource(): CredentialSource {
  if (envCredentials()) return 'environment';
  if (getStoredCredentials()) return 'database';
  return 'none';
}

export function isSolisConfigured(): boolean {
  const c = getActiveCredentials();
  return !!(c && c.apiId && c.apiSecret);
}

export async function saveStoredCredentials(input: {
  apiId: string;
  apiSecret: string;
  baseUrl?: string;
}): Promise<SolisCredentials> {
  const creds: SolisCredentials = {
    apiId: input.apiId.trim(),
    apiSecret: input.apiSecret.trim(),
    baseUrl: (input.baseUrl || '').trim() || DEFAULT_SOLIS_BASE_URL,
  };
  getDb().solisCredentials = creds;
  await saveDb();
  return creds;
}

function requireCredentials(): SolisCredentials {
  const c = getActiveCredentials();
  if (!c || !c.apiId || !c.apiSecret) {
    throw new Error('SolisCloud API credentials are not configured. Add them to the .env file or in Settings.');
  }
  return { ...c, baseUrl: c.baseUrl || DEFAULT_SOLIS_BASE_URL };
}

// Normalizes Solis energy/power values to kWh/kW based on the unit string returned in the response.
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toKWh(value: unknown, unit?: string): number {
  const v = num(value);
  switch ((unit || 'kWh').toLowerCase()) {
    case 'wh':  return v / 1000;
    case 'mwh': return v * 1000;
    case 'gwh': return v * 1_000_000;
    default:    return v; // kWh
  }
}

function toKW(value: unknown, unit?: string): number {
  const v = num(value);
  switch ((unit || 'kW').toLowerCase()) {
    case 'w':  return v / 1000;
    case 'mw': return v * 1000;
    case 'gw': return v * 1_000_000;
    default:   return v; // kW
  }
}

export async function testConnection(): Promise<void> {
  await solisPost(requireCredentials(), '/v1/api/userStationList', { pageNo: 1, pageSize: 1 });
}

export async function listStations(pageNo = 1, pageSize = 100): Promise<SolisStation[]> {
  const data = await solisPost<{ page?: { records?: any[] } }>(
    requireCredentials(),
    '/v1/api/userStationList',
    { pageNo, pageSize },
  );
  const records = data?.page?.records || [];
  return records.map((r) => ({
    id: String(r.id),
    name: r.stationName || '',
    capacityKW: num(r.capacity),
    address: r.addr || '',
    dayEnergyKWh: toKWh(r.dayEnergy, r.dayEnergyStr),
    monthEnergyKWh: toKWh(r.monthEnergy, r.monthEnergyStr),
    yearEnergyKWh: toKWh(r.yearEnergy, r.yearEnergyStr),
    totalEnergyKWh: toKWh(r.allEnergy, r.allEnergyStr),
    state: num(r.state),
    pricePerKWh: num(r.price),
    firstGenerationTime: num(r.fisGenerateTime) || num(r.fisPowerTime) || num(r.createDate),
    moduleCount: num(r.module),
  }));
}

export async function listInverters(stationId: string): Promise<SolisInverterSummary[]> {
  const data = await solisPost<{ page?: { records?: any[] } }>(
    requireCredentials(),
    '/v1/api/inverterList',
    { pageNo: 1, pageSize: 100, stationId },
  );
  const records = data?.page?.records || [];
  return records.map((r) => ({
    id: String(r.id),
    sn: r.sn || '',
    collectorSn: r.collectorSn || '',
    stationId: String(r.stationId ?? stationId),
    name: r.name || r.sn || '',
    capacityKW: num(r.power),
    acPowerKW: num(r.pac),
    eTodayKWh: toKWh(r.etoday, r.etodayStr),
    eTotalKWh: toKWh(r.etotal, r.etotalStr),
    state: num(r.state),
  }));
}

export async function getInverterRealTime(sn: string): Promise<InverterRealTime> {
  const d = await solisPost<any>(requireCredentials(), '/v1/api/inverterDetail', { sn });
  // Sum per-string DC power (pow1..pow32, in W) when the aggregated total is absent.
  let dcPowerKW = toKW(d.powTotal, d.powTotalStr) || toKW(d.dcPac, d.dcPacStr);
  if (dcPowerKW <= 0) {
    let stringWatts = 0;
    for (let i = 1; i <= 32; i++) stringWatts += num(d[`pow${i}`]);
    dcPowerKW = stringWatts / 1000;
  }
  return {
    sn: d.sn || sn,
    name: d.name || '',
    state: num(d.state),
    acPowerKW: toKW(d.pac, d.pacStr),
    dcPowerKW,
    eTodayKWh: toKWh(d.eToday, d.eTodayStr),
    eTotalKWh: toKWh(d.eTotal, d.eTotalStr),
    gridFrequencyHz: num(d.fac),
    acVoltage: [num(d.uAc1), num(d.uAc2), num(d.uAc3)],
    temperatureC: num(d.inverterTemperature),
    mppt: [
      { voltage: num(d.uPv1), current: num(d.iPv1) },
      { voltage: num(d.uPv2), current: num(d.iPv2) },
      { voltage: num(d.uPv3), current: num(d.iPv3) },
      { voltage: num(d.uPv4), current: num(d.iPv4) },
    ],
    dataTimestamp: num(d.dataTimestamp) || Date.now(),
  };
}

export async function getInverterDay(sn: string, date: string, timeZone = 8): Promise<DailyCurvePoint[]> {
  const arr = await solisPost<any[]>(requireCredentials(), '/v1/api/inverterDay', {
    sn,
    money: '',
    time: date,
    timeZone,
  });
  return (arr || []).map((p) => ({
    time: p.time || (typeof p.timeStr === 'string' ? p.timeStr.slice(-8) : ''),
    power: toKW(p.pac, p.pacStr),
  }));
}

export async function getInverterYear(
  sn: string,
  year: number,
): Promise<{ month: string; exportKWh: number; gridPurchasedKWh: number }[]> {
  const arr = await solisPost<any[]>(requireCredentials(), '/v1/api/inverterYear', {
    sn,
    money: '',
    year: String(year),
    timeZone: 8,
  });
  return (arr || [])
    .map((r) => ({
      month: typeof r.dateStr === 'string' ? r.dateStr.slice(0, 7) : '',
      exportKWh: toKWh(r.energy, r.energyStr),
      gridPurchasedKWh: toKWh(r.gridPurchasedEnergy, r.gridPurchasedEnergyStr),
    }))
    .filter((r) => /^\d{4}-\d{2}$/.test(r.month));
}

export async function getInverterMonth(sn: string, month: string): Promise<number> {
  const arr = await solisPost<any[]>(requireCredentials(), '/v1/api/inverterMonth', {
    sn,
    money: '',
    month,
  });
  return (arr || []).reduce((sum, day) => sum + toKWh(day.energy, day.energyStr), 0);
}

function resolveInverterSn(inv: Project['inverters'][number]): string {
  return inv.deviceSn || inv.solisSn || inv.psKey || '';
}

// Fetches current-month generation per inverter; preserves admin-entered targets/irradiation.
export async function syncProjectMonth(project: Project, month: string): Promise<MonthlyData> {
  const moduleBuilds: ModuleBuild[] = getDb().moduleBuilds;
  const buildMap = new Map(moduleBuilds.map((b) => [b.id, b]));
  const existing = project.monthlyData[month];
  const inverterCount = project.inverters.length;

  const result: MonthlyData = {
    month,
    electricityImportedKWh: existing?.electricityImportedKWh || 0,
    targetNetKWhP50: existing?.targetNetKWhP50 || 0,
    inverterExportKWh: [],
    inverterTargetOMKWh:
      existing?.inverterTargetOMKWh?.length === inverterCount
        ? [...existing.inverterTargetOMKWh]
        : project.inverters.map(() => 0),
    inverterIrradiation:
      existing?.inverterIrradiation?.length === inverterCount
        ? [...existing.inverterIrradiation]
        : project.inverters.map(() => 0),
    inverterDcCapacityKW: [],
  };

  for (const inv of project.inverters) {
    const sn = resolveInverterSn(inv);
    let exportKWh = 0;
    if (sn) exportKWh = await getInverterMonth(sn, month);
    result.inverterExportKWh.push(Math.round(exportKWh));

    const build = inv.moduleBuildId ? buildMap.get(inv.moduleBuildId) : undefined;
    // DC capacity = moduleCount × Wp / 1000
    const dcCapacity = ((inv.moduleCount || 0) * (build?.wp || 0)) / 1000;
    result.inverterDcCapacityKW.push(dcCapacity);
  }

  return result;
}
