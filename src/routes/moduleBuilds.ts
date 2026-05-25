import { randomUUID } from 'crypto';
import { Router } from 'express';
import { getDb, saveDb } from '../db/store';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { ModuleBuild } from '../types';

const router = Router();

router.use(authenticate);

router.get('/', (_req, res) => {
  res.json(getDb().moduleBuilds);
});

router.post(
  '/',
  requireRole('admin', 'operations'),
  asyncHandler(async (req, res) => {
    const body = req.body as Partial<ModuleBuild>;
    if (!body?.name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const build: ModuleBuild = {
      id: randomUUID(),
      name: body.name,
      wp: Number(body.wp) || 0,
      area: Number(body.area) || 0,
      degradation: {
        firstYear: Number(body.degradation?.firstYear) || 0,
        subsequentYears: Number(body.degradation?.subsequentYears) || 0,
      },
    };
    getDb().moduleBuilds.push(build);
    await saveDb();
    res.status(201).json(build);
  }),
);

router.put(
  '/:id',
  requireRole('admin', 'operations'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const idx = db.moduleBuilds.findIndex((b) => b.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Module build not found' });
      return;
    }
    db.moduleBuilds[idx] = { ...(req.body as ModuleBuild), id: req.params.id };
    await saveDb();
    res.json(db.moduleBuilds[idx]);
  }),
);

router.delete(
  '/:id',
  requireRole('admin', 'operations'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const before = db.moduleBuilds.length;
    db.moduleBuilds = db.moduleBuilds.filter((b) => b.id !== req.params.id);
    if (db.moduleBuilds.length === before) {
      res.status(404).json({ error: 'Module build not found' });
      return;
    }
    await saveDb();
    res.status(204).end();
  }),
);

export default router;
