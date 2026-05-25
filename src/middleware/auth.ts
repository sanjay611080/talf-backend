import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config';
import { User, UserRole } from '../types';

export interface AuthRequest extends Request {
  user?: User;
}

export function authenticate(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as { username: string; role: UserRole };
    req.user = { username: payload.username, role: payload.role };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions for this action' });
      return;
    }
    next();
  };
}
