import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { JWT_EXPIRES_SECONDS, JWT_SECRET } from '../config';
import { getDb } from '../db/store';
import { AuthRequest, authenticate } from '../middleware/auth';

const router = Router();

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    res.status(400).json({ error: 'username and password are required' });
    return;
  }

  const user = getDb().users.find((u) => u.username.toLowerCase() === String(username).toLowerCase());
  if (!user || !bcrypt.compareSync(String(password), user.passwordHash)) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }
  if (user.isActive === false) {
    res.status(403).json({ error: 'This account is deactivated. Contact your administrator.' });
    return;
  }

  const token = jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_SECONDS,
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

// GET /api/auth/me
router.get('/me', authenticate, (req: AuthRequest, res) => {
  res.json({ user: req.user });
});

export default router;
