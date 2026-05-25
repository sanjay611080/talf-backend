import { Request, Response, Router } from 'express';
import { getDb } from '../db/store';
import { authenticate, requireRole } from '../middleware/auth';
import {
  DEFAULT_SOLIS_BASE_URL,
  getActiveCredentials,
  getCredentialSource,
  getInverterDay,
  getInverterRealTime,
  getStoredCredentials,
  isSolisConfigured,
  listInverters,
  listStations,
  saveStoredCredentials,
  syncProjectMonth,
  testConnection,
} from '../services/solisService';
import { getSyncStatus, isSyncRunning, runFullSync, runIncrementalSync } from '../services/solisSync';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

router.use(authenticate);

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'SolisCloud request failed';
      const status = message.includes('not configured') ? 400 : 502;
      res.status(status).json({ error: message });
    });
  };
}

router.get('/credentials', requireRole('admin'), (_req, res) => {
  const c = getActiveCredentials();
  res.json({
    configured: isSolisConfigured(),
    source: getCredentialSource(),
    apiId: c?.apiId || '',
    baseUrl: c?.baseUrl || DEFAULT_SOLIS_BASE_URL,
    hasSecret: !!c?.apiSecret,
  });
});

// PUT /api/solis/credentials — empty apiSecret reuses the stored one.
router.put(
  '/credentials',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { apiId, apiSecret, baseUrl } = req.body || {};
    if (!apiId) {
      res.status(400).json({ error: 'apiId is required' });
      return;
    }
    const secret = apiSecret || getStoredCredentials()?.apiSecret;
    if (!secret) {
      res.status(400).json({ error: 'apiSecret is required' });
      return;
    }
    const saved = await saveStoredCredentials({ apiId, apiSecret: secret, baseUrl });
    res.json({ configured: true, apiId: saved.apiId, baseUrl: saved.baseUrl, hasSecret: true });
  }),
);

router.get(
  '/test',
  requireRole('admin', 'operations'),
  wrap(async (_req, res) => {
    await testConnection();
    res.json({ ok: true });
  }),
);

router.get(
  '/stations',
  wrap(async (req, res) => {
    const pageNo = Number(req.query.pageNo) || 1;
    const pageSize = Number(req.query.pageSize) || 100;
    res.json(await listStations(pageNo, pageSize));
  }),
);

router.get(
  '/stations/:id/inverters',
  wrap(async (req, res) => {
    res.json(await listInverters(req.params.id));
  }),
);

router.get(
  '/inverters/:sn/realtime',
  wrap(async (req, res) => {
    res.json(await getInverterRealTime(req.params.sn));
  }),
);

router.get(
  '/inverters/:sn/day',
  wrap(async (req, res) => {
    const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'date query parameter is required (YYYY-MM-DD)' });
      return;
    }
    const timeZone = Number(req.query.timeZone) || 8;
    res.json(await getInverterDay(req.params.sn, date, timeZone));
  }),
);

// POST /api/solis/projects/:code/sync?month=YYYY-MM — returns MonthlyData without persisting.
router.post(
  '/projects/:code/sync',
  requireRole('admin', 'operations'),
  wrap(async (req, res) => {
    const month = String(req.query.month || '');
    if (!/^\d{4}-\d{2}$/.test(month)) {
      res.status(400).json({ error: 'month query parameter is required (YYYY-MM)' });
      return;
    }
    const project = getDb().projects.find((p) => p.projectCode === req.params.code);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json(await syncProjectMonth(project, month));
  }),
);

router.get('/sync/status', (_req, res) => {
  res.json(getSyncStatus());
});

router.post('/sync', requireRole('admin', 'operations'), (_req, res) => {
  if (!isSolisConfigured()) {
    res.status(400).json({ error: 'SolisCloud credentials are not configured.' });
    return;
  }
  if (isSyncRunning()) {
    res.status(409).json({ error: 'A SolisCloud sync is already running.', status: getSyncStatus() });
    return;
  }
  void runFullSync(); // fire-and-forget
  res.status(202).json({ started: true, status: getSyncStatus() });
});

router.post('/sync/incremental', requireRole('admin', 'operations'), (_req, res) => {
  if (!isSolisConfigured()) {
    res.status(400).json({ error: 'SolisCloud credentials are not configured.' });
    return;
  }
  if (isSyncRunning()) {
    res.status(409).json({ error: 'A SolisCloud sync is already running.', status: getSyncStatus() });
    return;
  }
  void runIncrementalSync(); // fire-and-forget
  res.status(202).json({ started: true, status: getSyncStatus() });
});

export default router;
