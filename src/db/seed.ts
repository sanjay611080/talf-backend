import bcrypt from 'bcryptjs';
import { SOLIS_API_ID, SOLIS_API_SECRET } from '../config';
import { Database, ModuleBuild, MonthlyData, Project, BreakdownReason, StoredUser } from '../types';

// Builds initial seed data on first run with an empty database.
export function seedDatabase(): Database {
  const moduleBuilds: ModuleBuild[] = [
    {
      id: 'mb-540-mono',
      name: 'Default 540Wp Mono PERC',
      wp: 540,
      area: 2.53,
      degradation: { firstYear: 2.0, subsequentYears: 0.55 },
    },
    {
      id: 'mb-450-poly',
      name: 'Generic 450Wp Poly',
      wp: 450,
      area: 2.15,
      degradation: { firstYear: 2.5, subsequentYears: 0.7 },
    },
  ];
  const defaultBuildId = moduleBuilds[0].id;

  const passwordHash = bcrypt.hashSync('password', 10);
  const users: StoredUser[] = [
    { username: 'admin', role: 'admin', fullName: 'Administrator', email: 'admin@talfsolar.in', contact: '+91 90000 00001', isActive: true, passwordHash },
    { username: 'ops', role: 'operations', fullName: 'Operations User', email: 'ops@talfsolar.in', contact: '+91 90000 00002', isActive: true, passwordHash },
    { username: 'viewer', role: 'viewer', fullName: 'Viewer User', email: 'viewer@talfsolar.in', contact: '+91 90000 00003', isActive: true, passwordHash },
  ];

  const solisConfigured = !!(SOLIS_API_ID && SOLIS_API_SECRET);
  const projects = solisConfigured ? [] : buildProjects(defaultBuildId);

  return { users, projects, moduleBuilds };
}

function buildProjects(defaultBuildId: string): Project[] {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const fiveDaysAgo = new Date();
  fiveDaysAgo.setDate(today.getDate() - 5);
  const formatDate = (d: Date) => d.toISOString().split('T')[0];

  const projects: Project[] = [
    {
      projectCode: 'TALF-GGN-01',
      projectName: 'Gurgaon Commercial Rooftop',
      projectState: 'Haryana',
      projectOwner: 'Talf Solar',
      dateOfCommissioning: '2022-04-15T00:00:00.000Z',
      tariff: 4.75,
      inverters: [
        { name: 'GGN-INV-01', kwac: 50, moduleCount: 120, moduleBuildId: defaultBuildId, solisSn: '1234567890123', psKey: 'pskey-ggn-01' },
        { name: 'GGN-INV-02', kwac: 50, moduleCount: 120, moduleBuildId: defaultBuildId, psKey: 'pskey-ggn-02' },
        { name: 'GGN-INV-03', kwac: 25, moduleCount: 60, moduleBuildId: defaultBuildId, psKey: 'pskey-ggn-03' },
      ],
      monthlyData: {},
      breakdownEvents: [
        { id: 'bd-1', inverterName: 'GGN-INV-02', date: formatDate(fiveDaysAgo), startTime: '11:30', endTime: '13:00', reason: BreakdownReason.GRID_FAILURE, giiAtStart: 2.1, giiAtEnd: 2.8, notes: 'Feeder E-11 tripped.' },
        { id: 'bd-2', inverterName: 'GGN-INV-02', date: formatDate(yesterday), startTime: '14:00', endTime: '14:20', reason: BreakdownReason.PLANT_BREAKDOWN, giiAtStart: 3.5, giiAtEnd: 3.7, notes: 'ACDB fuse blown, replaced.' },
        { id: 'bd-3', inverterName: 'GGN-INV-01', date: formatDate(yesterday), startTime: '09:15', endTime: '10:45', reason: BreakdownReason.GRID_OVER_VOLTAGE, giiAtStart: 1.1, giiAtEnd: 1.9 },
      ],
    },
    {
      projectCode: 'TALF-RJ-01',
      projectName: 'Bhadla Solar Park (Phase IV)',
      projectState: 'Rajasthan',
      projectOwner: 'Talf Solar',
      dateOfCommissioning: '2023-11-01T00:00:00.000Z',
      tariff: 2.15,
      inverters: [
        { name: 'BHD-INV-01', kwac: 100, moduleCount: 240, moduleBuildId: defaultBuildId, psKey: 'pskey-bhd-01' },
        { name: 'BHD-INV-02', kwac: 100, moduleCount: 240, moduleBuildId: defaultBuildId, psKey: 'pskey-bhd-02' },
        { name: 'BHD-INV-03', kwac: 100, moduleCount: 240, moduleBuildId: defaultBuildId, psKey: 'pskey-bhd-03' },
        { name: 'BHD-INV-04', kwac: 100, moduleCount: 240, moduleBuildId: defaultBuildId, psKey: 'pskey-bhd-04' },
      ],
      monthlyData: {},
      breakdownEvents: [],
    },
    {
      projectCode: 'TALF-DL-RES-01',
      projectName: 'Delhi Residential Rooftop',
      projectState: 'Delhi',
      projectOwner: 'Private Owner',
      dateOfCommissioning: '2023-01-20T00:00:00.000Z',
      tariff: 5.5,
      inverters: [
        { name: 'DL-INV-01', kwac: 10, moduleCount: 22, moduleBuildId: defaultBuildId, psKey: 'pskey-dl-01' },
      ],
      monthlyData: {},
      breakdownEvents: [],
    },
  ];

  projects.forEach((p) => {
    p.monthlyData = generateMonthlyData(new Date(p.dateOfCommissioning), p.inverters, p.projectCode);
  });

  return projects;
}

function generateMonthlyData(
  doc: Date,
  inverters: { name: string; kwac: number; moduleCount?: number }[],
  projectCode: string,
): Record<string, MonthlyData> {
  const data: Record<string, MonthlyData> = {};
  const today = new Date();
  const currentMonth = new Date(doc.getFullYear(), doc.getMonth(), 1);

  const anomalyDate = new Date();
  anomalyDate.setMonth(anomalyDate.getMonth() - 2);
  const anomalyMonthKey = `${anomalyDate.getFullYear()}-${String(anomalyDate.getMonth() + 1).padStart(2, '0')}`;

  while (currentMonth <= today) {
    const monthKey = `${currentMonth.getFullYear()}-${String(currentMonth.getMonth() + 1).padStart(2, '0')}`;
    const monthNum = currentMonth.getMonth() + 1;
    const seasonalFactor = 1 - (Math.abs(6.5 - monthNum) / 5.5) * 0.4;

    const monthData: MonthlyData = {
      month: monthKey,
      electricityImportedKWh: 0,
      targetNetKWhP50: 0,
      inverterExportKWh: [],
      inverterTargetOMKWh: [],
      inverterIrradiation: [],
      inverterDcCapacityKW: [],
    };

    let projectImport = 0;
    let projectTargetP50 = 0;

    inverters.forEach((inv) => {
      const randomFactor = 0.9 + Math.random() * 0.2;
      const dailyGen = inv.kwac * 4.2 * seasonalFactor * randomFactor;
      let monthlyGen = Math.round(dailyGen * 30);

      if (projectCode === 'TALF-GGN-01' && inv.name === 'GGN-INV-02' && monthKey === anomalyMonthKey) {
        monthlyGen = 0;
      }

      const monthlyTargetOM = Math.round(dailyGen * 30 * 0.95);
      const monthlyTargetP50 = Math.round(monthlyTargetOM * 1.05);
      const dcCapacity = (inv.moduleCount || 0) * 0.54;

      monthData.inverterExportKWh.push(monthlyGen);
      monthData.inverterTargetOMKWh.push(monthlyTargetOM);
      monthData.inverterIrradiation.push(Math.round((130 + Math.random() * 40) * seasonalFactor * (dcCapacity / (inv.kwac * 1.2))));
      monthData.inverterDcCapacityKW.push(dcCapacity);

      projectImport += Math.round(monthlyGen * 0.02 * Math.random());
      projectTargetP50 += monthlyTargetP50;
    });

    monthData.electricityImportedKWh = projectImport;
    monthData.targetNetKWhP50 = projectTargetP50;
    data[monthKey] = monthData;
    currentMonth.setMonth(currentMonth.getMonth() + 1);
  }

  return data;
}
