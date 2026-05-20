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

/**
 * Wraps an async handler so upstream SolisCloud failures become clean HTTP
 * errors instead of crashing the process (Express 4 does not catch rejections).
 */
function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'SolisCloud request failed';
      const status = message.includes('not configured') ? 400 : 502;
      res.status(status).json({ error: message });
    });
  };
}

// GET /api/solis/credentials  — never returns the secret itself.
router.get('/credentials', requireRole('admin'), (_req, res) => {
  const c = getActiveCredentials();
  res.json({
    configured: isSolisConfigured(),
    source: getCredentialSource(), // 'environment' | 'database' | 'none'
    apiId: c?.apiId || '',
    baseUrl: c?.baseUrl || DEFAULT_SOLIS_BASE_URL,
    hasSecret: !!c?.apiSecret,
  });
});

// PUT /api/solis/credentials
// An empty apiSecret reuses the stored one, so the secret never needs to be
// re-typed just to change the API ID or base URL.
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

// GET /api/solis/test  — verify the stored credentials work.
router.get(
  '/test',
  requireRole('admin', 'operations'),
  wrap(async (_req, res) => {
    await testConnection();
    res.json({ ok: true });
  }),
);

// GET /api/solis/stations
router.get(
  '/stations',
  wrap(async (req, res) => {
    const pageNo = Number(req.query.pageNo) || 1;
    const pageSize = Number(req.query.pageSize) || 100;
    res.json(await listStations(pageNo, pageSize));
  }),
);

// GET /api/solis/stations/:id/inverters
router.get(
  '/stations/:id/inverters',
  wrap(async (req, res) => {
    res.json(await listInverters(req.params.id));
  }),
);

// GET /api/solis/inverters/:sn/realtime
router.get(
  '/inverters/:sn/realtime',
  wrap(async (req, res) => {
    res.json(await getInverterRealTime(req.params.sn));
  }),
);

// GET /api/solis/inverters/:sn/day?date=YYYY-MM-DD&timeZone=8
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

// POST /api/solis/projects/:code/sync?month=YYYY-MM
// Returns a freshly-built MonthlyData record (does NOT persist it).
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

// GET /api/solis/sync/status  — progress of the SolisCloud fetch.
router.get('/sync/status', (_req, res) => {
  res.json(getSyncStatus());
});

// POST /api/solis/sync  — (re)fetch the whole SolisCloud account in the background.
router.post('/sync', requireRole('admin', 'operations'), (_req, res) => {
  if (!isSolisConfigured()) {
    res.status(400).json({ error: 'SolisCloud credentials are not configured.' });
    return;
  }
  if (isSyncRunning()) {
    res.status(409).json({ error: 'A SolisCloud sync is already running.', status: getSyncStatus() });
    return;
  }
  void runFullSync(); // fire-and-forget; clients poll /sync/status
  res.status(202).json({ started: true, status: getSyncStatus() });
});

// POST /api/solis/sync/incremental
// Fast refresh: re-fetches only the current year for inverters already in the
// database, updating recent months without re-walking the full history.
router.post('/sync/incremental', requireRole('admin', 'operations'), (_req, res) => {
  if (!isSolisConfigured()) {
    res.status(400).json({ error: 'SolisCloud credentials are not configured.' });
    return;
  }
  if (isSyncRunning()) {
    res.status(409).json({ error: 'A SolisCloud sync is already running.', status: getSyncStatus() });
    return;
  }
  void runIncrementalSync(); // fire-and-forget; clients poll /sync/status
  res.status(202).json({ started: true, status: getSyncStatus() });
});

export default router;
