import { CO2_FACTOR, SYSTEM_EFFICIENCY } from '../constants';
import {
  BreakdownEvent,
  BreakdownStats,
  Inverter,
  InverterKPIResult,
  KPIResult,
  ModuleBuild,
  MonthlyData,
  Project,
  TimeRange,
} from '../types';

export function calculateProjectStaticCapacity(project: Project): { totalKWac: number } {
  const totalKWac = (project.inverters || []).reduce((sum, inv) => sum + inv.kwac, 0);
  return { totalKWac };
}

export function filterMonthlyData(monthlyData: Record<string, MonthlyData>, range: TimeRange): MonthlyData[] {
  const sorted = Object.values(monthlyData).sort((a, b) => a.month.localeCompare(b.month));
  if (range === 'ALL') return sorted;
  if (sorted.length === 0) return [];
  if (range === '6M') return sorted.slice(-6);
  if (range === '12M') return sorted.slice(-12);
  return sorted;
}

// Returns actual operational hours/days for a calendar month.
// Clamps start to commissioning date and end to today for partial months.
export function operationalSpanInMonth(
  monthKey: string,
  commissioningDate: Date,
  now: Date = new Date(),
): { hours: number; days: number } {
  const [yearStr, monthStr] = monthKey.split('-');
  const year = parseInt(yearStr, 10);
  const monthIdx = parseInt(monthStr, 10) - 1;

  const monthStartMs = new Date(year, monthIdx, 1).getTime();
  const monthEndMs = new Date(year, monthIdx + 1, 1).getTime();
  const commissioningMs = commissioningDate.getTime();
  const nowMs = now.getTime();

  const opStart = commissioningMs > monthStartMs && commissioningMs < monthEndMs ? commissioningMs : monthStartMs;
  const opEnd = nowMs > monthStartMs && nowMs < monthEndMs ? nowMs : monthEndMs;

  if (opEnd <= opStart) return { hours: 0, days: 0 };

  const ms = opEnd - opStart;
  return { hours: ms / 3_600_000, days: ms / 86_400_000 };
}

export function calculateKPIs(project: Project, timeRange: TimeRange, moduleBuilds: ModuleBuild[]): KPIResult {
  const moduleBuildMap = new Map(moduleBuilds.map((b) => [b.id, b]));
  const { totalKWac } = calculateProjectStaticCapacity(project);

  let totalExport = 0;
  let totalImport = 0;
  let totalTargetP50 = 0;
  let totalTargetOM = 0;
  let totalDays = 0;
  let prDenominator = 0;
  let dcCufDenominator = 0;
  let acCufDenominator = 0;

  const months = filterMonthlyData(project.monthlyData, timeRange);
  const commissioningDate = new Date(project.dateOfCommissioning);
  const now = new Date();

  months.forEach((m) => {
    const { hours, days } = operationalSpanInMonth(m.month, commissioningDate, now);
    totalDays += days;

    const monthlyTotalDcKW = (m.inverterDcCapacityKW || []).reduce((sum, dc) => sum + dc, 0);
    const monthlyTotalExport = (m.inverterExportKWh || []).reduce((sum, exp) => sum + exp, 0);
    const monthlyTotalTargetOM = (m.inverterTargetOMKWh || []).reduce((sum, om) => sum + om, 0);

    totalExport += monthlyTotalExport;
    totalImport += m.electricityImportedKWh || 0;
    totalTargetP50 += m.targetNetKWhP50 || 0;
    totalTargetOM += monthlyTotalTargetOM;

    const monthDate = new Date(m.month + '-02');
    const monthsDiff =
      monthDate.getMonth() - commissioningDate.getMonth() +
      12 * (monthDate.getFullYear() - commissioningDate.getFullYear());

    const monthlyPrDenominator = project.inverters.reduce((sum, inv, index) => {
      const build = inv.moduleBuildId ? moduleBuildMap.get(inv.moduleBuildId) : undefined;
      const irradiation = (m.inverterIrradiation || [])[index] || 0;

      if (build && inv.moduleCount && irradiation > 0) {
        const firstYearDegPerMonth = build.degradation.firstYear / 12;
        const subYearDegPerMonth = build.degradation.subsequentYears / 12;
        let totalDegPercent = 0;

        if (monthsDiff >= 0) {
          if (monthsDiff < 12) {
            totalDegPercent = (monthsDiff + 1) * firstYearDegPerMonth;
          } else {
            totalDegPercent = build.degradation.firstYear + (monthsDiff - 11) * subYearDegPerMonth;
          }
        }

        const degradationFactor = 1 - totalDegPercent / 100;
        // IEC 61724 PR denominator: H_POA × P_DC × (1 − degradation), P_DC = moduleCount × Wp / 1000
        const dcCapacityKW = (inv.moduleCount * build.wp) / 1000;
        return sum + irradiation * dcCapacityKW * degradationFactor;
      }
      return sum;
    }, 0);

    prDenominator += monthlyPrDenominator;
    dcCufDenominator += monthlyTotalDcKW * hours;
    acCufDenominator += totalKWac * hours;
  });

  const netEnergy = totalExport - totalImport;
  const tariff = project.tariff || 0;
  const revenue = netEnergy * tariff;
  const targetRevenue = totalTargetOM * tariff;
  const co2Reduction = (netEnergy / 1000) * CO2_FACTOR; // tCO2 = kWh / 1000 × emission factor

  let latestTotalKWdc = 0;
  if (months.length > 0) {
    const lastMonth = months[months.length - 1];
    latestTotalKWdc = (lastMonth.inverterDcCapacityKW || []).reduce((sum, dc) => sum + dc, 0);
  }

  const yieldVal = latestTotalKWdc > 0 ? netEnergy / latestTotalKWdc : 0;                                        // kWh/kWp
  const averageDailyYield = latestTotalKWdc > 0 && totalDays > 0 ? netEnergy / latestTotalKWdc / totalDays : 0;  // kWh/kWp/day
  const pr    = prDenominator > 0    ? (netEnergy / prDenominator) * 100    : 0; // IEC 61724 PR %
  const cuf   = acCufDenominator > 0 ? (netEnergy / acCufDenominator) * 100 : 0; // AC CUF %
  const dcCuf = dcCufDenominator > 0 ? (netEnergy / dcCufDenominator) * 100 : 0; // DC CUF %

  return {
    totalCapacityKWac: totalKWac,
    totalCapacityKWdc: latestTotalKWdc,
    tariff,
    totalExport,
    totalImport,
    netEnergy,
    revenue,
    targetRevenue,
    yield: yieldVal,
    pr,
    cuf,
    dcCuf,
    co2Reduction,
    targetP50: totalTargetP50,
    targetOM: totalTargetOM,
    totalDays,
    averageDailyYield,
  };
}

export function calculateInverterKPIs(
  project: Project,
  inverter: Inverter,
  inverterIndex: number,
  timeRange: TimeRange,
  moduleBuilds: ModuleBuild[],
): InverterKPIResult {
  const moduleBuildMap = new Map(moduleBuilds.map((b) => [b.id, b]));

  let totalExport = 0;
  let totalTargetOM = 0;
  let totalTheoreticalEnergy = 0;
  let totalDays = 0;
  let prDenominator = 0;
  let dcCufDenominator = 0;
  let acCufDenominator = 0;

  const months = filterMonthlyData(project.monthlyData, timeRange);
  const commissioningDate = new Date(project.dateOfCommissioning);
  const now = new Date();

  months.forEach((m) => {
    const { hours, days } = operationalSpanInMonth(m.month, commissioningDate, now);
    totalDays += days;

    const monthlyDcKW    = (m.inverterDcCapacityKW || [])[inverterIndex] || 0;
    const monthlyExport  = (m.inverterExportKWh    || [])[inverterIndex] || 0;
    const monthlyTargetOM = (m.inverterTargetOMKWh || [])[inverterIndex] || 0;
    const irradiation    = (m.inverterIrradiation  || [])[inverterIndex] || 0;

    totalExport += monthlyExport;
    totalTargetOM += monthlyTargetOM;
    // Theoretical energy = H_POA × DC capacity × system efficiency
    totalTheoreticalEnergy += irradiation * monthlyDcKW * SYSTEM_EFFICIENCY;

    const monthDate = new Date(m.month + '-02');
    const monthsDiff =
      monthDate.getMonth() - commissioningDate.getMonth() +
      12 * (monthDate.getFullYear() - commissioningDate.getFullYear());

    const build = inverter.moduleBuildId ? moduleBuildMap.get(inverter.moduleBuildId) : undefined;

    if (build && inverter.moduleCount && irradiation > 0) {
      const firstYearDegPerMonth = build.degradation.firstYear / 12;
      const subYearDegPerMonth = build.degradation.subsequentYears / 12;
      let totalDegPercent = 0;

      if (monthsDiff >= 0) {
        if (monthsDiff < 12) {
          totalDegPercent = (monthsDiff + 1) * firstYearDegPerMonth;
        } else {
          totalDegPercent = build.degradation.firstYear + (monthsDiff - 11) * subYearDegPerMonth;
        }
      }

      const degradationFactor = 1 - totalDegPercent / 100;
      // IEC 61724 PR denominator: H_POA × P_DC × (1 − degradation), P_DC = moduleCount × Wp / 1000
      const dcCapacityKW = (inverter.moduleCount * build.wp) / 1000;
      prDenominator += irradiation * dcCapacityKW * degradationFactor;
    }

    dcCufDenominator += monthlyDcKW * hours;
    acCufDenominator += inverter.kwac * hours;
  });

  const tariff = project.tariff || 0;
  const revenue = totalExport * tariff;
  const targetRevenue = totalTargetOM * tariff;
  const co2Reduction = (totalExport / 1000) * CO2_FACTOR;

  let latestTotalKWdc = 0;
  if (months.length > 0) {
    const lastMonth = months[months.length - 1];
    latestTotalKWdc = (lastMonth.inverterDcCapacityKW || [])[inverterIndex] || 0;
  }

  const yieldVal = latestTotalKWdc > 0 ? totalExport / latestTotalKWdc : 0;
  const averageDailyYield = latestTotalKWdc > 0 && totalDays > 0 ? totalExport / latestTotalKWdc / totalDays : 0;
  const pr    = prDenominator > 0    ? (totalExport / prDenominator) * 100    : 0;
  const cuf   = acCufDenominator > 0 ? (totalExport / acCufDenominator) * 100 : 0;
  const dcCuf = dcCufDenominator > 0 ? (totalExport / dcCufDenominator) * 100 : 0;

  return {
    totalCapacityKWac: inverter.kwac,
    totalCapacityKWdc: latestTotalKWdc,
    tariff,
    totalExport,
    revenue,
    targetRevenue,
    yield: yieldVal,
    pr,
    cuf,
    dcCuf,
    co2Reduction,
    targetOM: totalTargetOM,
    totalTheoreticalEnergy,
    totalDays,
    averageDailyYield,
  };
}

export function calculateBreakdownStats(
  events: BreakdownEvent[],
  inverterDcCapacity: number,
  periodDays: number,
): BreakdownStats {
  const stats: BreakdownStats = {
    totalBreakdownDurationMinutes: 0,
    totalGenerationLossKwh: 0,
    totalGiiLoss: 0,
    availabilityPercent: 100,
    byReason: {},
  };

  events.forEach((event) => {
    const [startH, startM] = event.startTime.split(':').map(Number);
    const [endH, endM] = event.endTime.split(':').map(Number);
    const durationMinutes = endH * 60 + endM - (startH * 60 + startM);
    if (durationMinutes < 0) return;

    const giiLoss = event.giiAtEnd - event.giiAtStart;
    // Generation loss = GII loss × DC capacity × system efficiency
    const generationLossKwh = giiLoss * inverterDcCapacity * SYSTEM_EFFICIENCY;

    stats.totalBreakdownDurationMinutes += durationMinutes;
    stats.totalGiiLoss += giiLoss;
    stats.totalGenerationLossKwh += generationLossKwh;

    if (!stats.byReason[event.reason]) {
      stats.byReason[event.reason] = { durationMinutes: 0, giiLoss: 0, generationLossKwh: 0, count: 0 };
    }
    const reasonStats = stats.byReason[event.reason]!;
    reasonStats.durationMinutes += durationMinutes;
    reasonStats.giiLoss += giiLoss;
    reasonStats.generationLossKwh += generationLossKwh;
    reasonStats.count += 1;
  });

  const totalPeriodMinutes = periodDays * 24 * 60;
  if (totalPeriodMinutes > 0) {
    // Availability % = (total period − breakdown minutes) / total period × 100
    stats.availabilityPercent = ((totalPeriodMinutes - stats.totalBreakdownDurationMinutes) / totalPeriodMinutes) * 100;
  }

  return stats;
}

const VALID_RANGES: TimeRange[] = ['6M', '12M', 'ALL'];

export function parseTimeRange(raw: unknown): TimeRange {
  return VALID_RANGES.includes(raw as TimeRange) ? (raw as TimeRange) : 'ALL';
}
