import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { JWT_EXPIRES_SECONDS, JWT_SECRET } from '../config';
import { getDb } from '../db/store';
import { AuthRequest, authenticate } from '../middleware/auth';
import { logAuditEvent } from '../services/auditHelper';

const router = Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    res.status(400).json({ error: 'username and password are required' });
    return;
  }

  const user = getDb().users.find((u) => u.username.toLowerCase() === String(username).toLowerCase());

  if (!user || !bcrypt.compareSync(String(password), user.passwordHash)) {
    logAuditEvent({
      performedBy: 'system',
      action: 'login_failed',
      entityType: 'auth',
      entityId: String(username),
      description: `Failed login attempt for username "${username}"`,
      metadata: { username },
    });
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  if (user.isActive === false) {
    logAuditEvent({
      performedBy: 'system',
      action: 'login_blocked',
      entityType: 'auth',
      entityId: user.username,
      description: `Login blocked — account "${user.username}" is deactivated`,
      metadata: { username: user.username },
    });
    res.status(403).json({ error: 'This account is deactivated. Contact your administrator.' });
    return;
  }

  const token = jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_SECONDS,
  });

  logAuditEvent({
    performedBy: user.username,
    action: 'login_success',
    entityType: 'auth',
    entityId: user.username,
    description: `User "${user.username}" logged in`,
    metadata: { role: user.role },
  });

  res.json({
    token,
    user: {
      username: user.username,
      role: user.role,
      fullName: user.fullName,
      email: user.email,
      contact: user.contact,
      isActive: true,
    },
  });
});

router.get('/me', authenticate, (req: AuthRequest, res) => {
  res.json({ user: req.user });
});

export default router;
