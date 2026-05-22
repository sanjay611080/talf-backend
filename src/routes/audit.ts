import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { prisma } from '../db/prisma';
import { AuthRequest, authenticate, requireRole } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

// All audit endpoints require a valid session.
router.use(authenticate);

// ---------------------------------------------------------------------------
// POST /api/audit
// Create a new audit log entry. Accepts any authenticated role — events are
// emitted by the frontend on behalf of the currently logged-in user.
// The `performedBy` field in the body is honoured when present (useful for
// system-generated events that carry an explicit actor, e.g. "system").
// ---------------------------------------------------------------------------
router.post(
  '/',
  asyncHandler(async (req: AuthRequest, res) => {
    const {
      action,
      entityType,
      entityId,
      entityLabel,
      description,
      changes,
      metadata,
      performedBy,
      timestamp,
    } = req.body || {};

    if (!action || !entityType || !description) {
      res.status(400).json({ error: 'action, entityType and description are required' });
      return;
    }

    const data: Prisma.AuditLogCreateInput = {
      performedBy: performedBy || req.user?.username || 'unknown',
      action: String(action),
      entityType: String(entityType),
      entityId: entityId ? String(entityId) : null,
      entityLabel: entityLabel ? String(entityLabel) : null,
      description: String(description),
      changes: changes != null ? (changes as Prisma.InputJsonValue) : undefined,
      metadata: metadata != null ? (metadata as Prisma.InputJsonValue) : undefined,
      ...(timestamp ? { timestamp: new Date(String(timestamp)) } : {}),
    };

    const log = await prisma.auditLog.create({ data });
    res.status(201).json(log);
  }),
);

// ---------------------------------------------------------------------------
// GET /api/audit
// List audit logs. Admin only.
// Query params: limit (default 500, max 1000), offset (default 0),
//   performedBy, action, entityType
// ---------------------------------------------------------------------------
router.get(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 500, 1000);
    const skip = Number(req.query.offset) || 0;

    const where: Prisma.AuditLogWhereInput = {};
    if (req.query.performedBy) where.performedBy = String(req.query.performedBy);
    if (req.query.action) where.action = String(req.query.action);
    if (req.query.entityType) where.entityType = String(req.query.entityType);

    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: limit,
      skip,
    });

    res.json(logs);
  }),
);

// ---------------------------------------------------------------------------
// DELETE /api/audit
// Permanently delete all audit log entries. Admin only.
// ---------------------------------------------------------------------------
router.delete(
  '/',
  requireRole('admin'),
  asyncHandler(async (_req, res) => {
    await prisma.auditLog.deleteMany();
    res.status(204).end();
  }),
);

export default router;
