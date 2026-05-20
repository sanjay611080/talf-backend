export type UserRole = 'admin' | 'operations' | 'viewer';

export interface User {
  username: string;
  role: UserRole;
  fullName?: string;
  email?: string;
  contact?: string;
  isActive?: boolean;
}

/** Server-side user record. The password hash never leaves the backend. */
export interface StoredUser extends User {
  passwordHash: string;
}

export interface ModuleBuild {
  id: string;
  name: string;
  wp: number;
  area: number;
  degradation: {
    firstYear: number;
    subsequentYears: number;
  };
}

export interface Inverter {
  name: string;
  kwac: number;
  solisSn?: string;
  deviceSn?: string;
  psKey?: string;
  moduleCount?: number;
  moduleBuildId?: string;
}

export interface MonthlyData {
  month: string; // YYYY-MM
  electricityImportedKWh: number;
  targetNetKWhP50: number;
  inverterExportKWh: number[];
  inverterTargetOMKWh: number[];
  inverterIrradiation: number[];
  inverterDcCapacityKW: number[];
}

export enum BreakdownReason {
  GRID_FAILURE = 'Grid Failure',
  GRID_OVER_VOLTAGE = 'Grid Over Voltage',
  GRID_UNDER_VOLTAGE = 'Grid Under Voltage',
  TRANSMISSION_LINE = 'Transmission Line Breakdown',
  PLANT_BREAKDOWN = 'Plant Breakdown',
  OTHER = 'Other',
}

export interface BreakdownEvent {
  id: string;
  inverterName: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  reason: BreakdownReason;
  notes?: string;
  giiAtStart: number;
  giiAtEnd: number;
}

export interface Project {
  projectCode: string;
  projectState: string;
  projectName: string;
  projectOwner: string;
  dateOfCommissioning: string;
  tariff: number;
  plantId?: string; // SolisCloud station id (kept as a string — it exceeds 32-bit int range)
  /**
   * SolisCloud's own lifetime generation roll-up (station.allEnergy, in kWh).
   * Used as the authoritative figure for ALL-timeline KPIs so the dashboard
   * matches what SolisCloud shows — historic per-month aggregation can be
   * short when inverters have been replaced or the plant generated before
   * being registered on SolisCloud. Updated on every Solis sync.
   */
  lifetimeKWh?: number;
  inverters: Inverter[];
  monthlyData: Record<string, MonthlyData>;
  breakdownEvents?: BreakdownEvent[];
}

export interface KPIResult {
  totalCapacityKWac: number;
  totalCapacityKWdc: number;
  tariff: number;
  totalExport: number;
  totalImport: number;
  netEnergy: number;
  revenue: number;
  targetRevenue: number;
  yield: number;
  pr: number;
  cuf: number;
  dcCuf: number;
  co2Reduction: number;
  targetP50: number;
  targetOM: number;
  totalDays: number;
  averageDailyYield: number;
}

export interface InverterKPIResult extends Omit<KPIResult, 'totalImport' | 'targetP50' | 'netEnergy'> {
  totalTheoreticalEnergy: number;
}

export interface BreakdownStats {
  totalBreakdownDurationMinutes: number;
  totalGenerationLossKwh: number;
  totalGiiLoss: number;
  availabilityPercent: number;
  byReason: {
    [key in BreakdownReason]?: {
      durationMinutes: number;
      giiLoss: number;
      generationLossKwh: number;
      count: number;
    };
  };
}

export type TimeRange = '6M' | '12M' | 'ALL';

/** SolisCloud API credentials. The secret is stored only on the backend. */
export interface SolisCredentials {
  apiId: string;
  apiSecret: string;
  baseUrl: string;
}

/** A SolisCloud power station, normalized for the frontend. */
export interface SolisStation {
  id: string;
  name: string;
  capacityKW: number;
  address: string;
  dayEnergyKWh: number;
  monthEnergyKWh: number;
  yearEnergyKWh: number;
  totalEnergyKWh: number;
  state: number; // 1=online, 2=offline, 3=alarm
  pricePerKWh: number;
  firstGenerationTime: number; // timestamp of first generation, 0 if unknown
  moduleCount: number; // number of PV panels ("components") on the station
}

/** Progress of a SolisCloud fetch/sync. */
export interface SolisSyncStatus {
  state: 'idle' | 'running' | 'done' | 'error';
  message: string;
  totalSteps: number;
  doneSteps: number;
  startedAt?: number;
  finishedAt?: number;
  lastSyncedAt?: number;
  /** When the next automatic (cron) sync is scheduled to run. */
  nextSyncAt?: number;
  /** What kind of sync the last/current run is — full history, current year, or just current-month delta. */
  kind?: 'full' | 'incremental' | 'cron';
}

/** A SolisCloud inverter list entry, normalized for the frontend. */
export interface SolisInverterSummary {
  id: string;
  sn: string;
  collectorSn: string;
  stationId: string;
  name: string;
  capacityKW: number;
  acPowerKW: number;
  eTodayKWh: number;
  eTotalKWh: number;
  state: number; // 1=online, 2=offline, 3=alarm
}

/** Real-time inverter detail, normalized to kW / kWh. */
export interface InverterRealTime {
  sn: string;
  name: string;
  state: number; // 1=online, 2=offline, 3=alarm
  acPowerKW: number;
  dcPowerKW: number;
  eTodayKWh: number;
  eTotalKWh: number;
  gridFrequencyHz: number;
  acVoltage: [number, number, number];
  temperatureC: number;
  mppt: { voltage: number; current: number }[];
  dataTimestamp: number;
}

/** One point on an inverter's intraday generation curve. */
export interface DailyCurvePoint {
  time: string; // HH:MM:SS
  power: number; // kW
}

/** Shape of the JSON file that backs the whole API. */
export interface Database {
  users: StoredUser[];
  projects: Project[];
  moduleBuilds: ModuleBuild[];
  solisCredentials?: SolisCredentials;
  solisSyncedAt?: number; // timestamp of the last successful SolisCloud sync
}
