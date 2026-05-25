import { Router } from 'express';
import { getDb } from '../db/store';
import { authenticate } from '../middleware/auth';
import { calculateInverterKPIs, calculateKPIs, parseTimeRange } from '../services/kpiService';

const router = Router();

router.use(authenticate);

router.get('/portfolio', (req, res) => {
  const range = parseTimeRange(req.query.range);
  const { projects, moduleBuilds } = getDb();
  res.json(
    projects.map((p) => ({
      projectCode: p.projectCode,
      projectName: p.projectName,
      kpi: calculateKPIs(p, range, moduleBuilds),
    })),
  );
});

router.get('/projects/:code', (req, res) => {
  const range = parseTimeRange(req.query.range);
  const { projects, moduleBuilds } = getDb();
  const project = projects.find((p) => p.projectCode === req.params.code);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  res.json(calculateKPIs(project, range, moduleBuilds));
});

router.get('/projects/:code/inverters/:index', (req, res) => {
  const range = parseTimeRange(req.query.range);
  const { projects, moduleBuilds } = getDb();
  const project = projects.find((p) => p.projectCode === req.params.code);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const index = Number(req.params.index);
  const inverter = project.inverters[index];
  if (!inverter) {
    res.status(404).json({ error: 'Inverter not found' });
    return;
  }
  res.json(calculateInverterKPIs(project, inverter, index, range, moduleBuilds));
});

export default router;
