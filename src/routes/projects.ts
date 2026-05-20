import { Router } from 'express';
import { getDb, saveDb } from '../db/store';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { Project } from '../types';

const router = Router();

// Every project endpoint requires a logged-in user.
router.use(authenticate);

// GET /api/projects
router.get('/', (_req, res) => {
  res.json(getDb().projects);
});

// GET /api/projects/:code
router.get('/:code', (req, res) => {
  const project = getDb().projects.find((p) => p.projectCode === req.params.code);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  res.json(project);
});

// PUT /api/projects  — bulk replace the whole collection (used by the frontend).
router.put(
  '/',
  requireRole('admin', 'operations'),
  asyncHandler(async (req, res) => {
    if (!Array.isArray(req.body)) {
      res.status(400).json({ error: 'Expected an array of projects' });
      return;
    }
    getDb().projects = req.body as Project[];
    await saveDb();
    res.json(getDb().projects);
  }),
);

// POST /api/projects  — create a single project.
router.post(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const project = req.body as Project;
    if (!project?.projectCode) {
      res.status(400).json({ error: 'projectCode is required' });
      return;
    }
    if (getDb().projects.some((p) => p.projectCode === project.projectCode)) {
      res.status(409).json({ error: `Project code "${project.projectCode}" already exists` });
      return;
    }
    getDb().projects.push(project);
    await saveDb();
    res.status(201).json(project);
  }),
);

// PUT /api/projects/:code  — update a single project.
router.put(
  '/:code',
  requireRole('admin', 'operations'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const idx = db.projects.findIndex((p) => p.projectCode === req.params.code);
    if (idx === -1) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    db.projects[idx] = { ...(req.body as Project), projectCode: req.params.code };
    await saveDb();
    res.json(db.projects[idx]);
  }),
);

// DELETE /api/projects/:code
router.delete(
  '/:code',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const before = db.projects.length;
    db.projects = db.projects.filter((p) => p.projectCode !== req.params.code);
    if (db.projects.length === before) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    await saveDb();
    res.status(204).end();
  }),
);

export default router;
