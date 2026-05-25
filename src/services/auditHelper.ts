import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';

export interface AuditPayload {
  performedBy: string;
  action: string;
  entityType: string;
  entityId?: string;
  entityLabel?: string;
  description: string;
  changes?: unknown;
  metadata?: unknown;
  timestamp?: string; // ISO-8601, defaults to now()
}

// Fire-and-forget: errors are logged but never rethrown.
export function logAuditEvent(payload: AuditPayload): void {
  const data: Prisma.AuditLogCreateInput = {
    performedBy: payload.performedBy,
    action: payload.action,
    entityType: payload.entityType,
    entityId: payload.entityId ?? null,
    entityLabel: payload.entityLabel ?? null,
    description: payload.description,
    changes: payload.changes != null ? (payload.changes as Prisma.InputJsonValue) : undefined,
    metadata: payload.metadata != null ? (payload.metadata as Prisma.InputJsonValue) : undefined,
    ...(payload.timestamp ? { timestamp: new Date(payload.timestamp) } : {}),
  };

  prisma.auditLog
    .create({ data })
    .catch((err: unknown) =>
      console.error('[audit] Failed to persist event:', err instanceof Error ? err.message : err),
    );
}
