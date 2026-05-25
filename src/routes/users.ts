import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { getDb, saveDb } from '../db/store';
import { authenticate, requireRole } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { StoredUser, User, UserRole } from '../types';

const router = Router();

router.use(authenticate);

const ROLES: UserRole[] = ['admin', 'operations', 'viewer'];

function toPublicUser(user: StoredUser): User {
  return {
    username: user.username,
    role: user.role,
    fullName: user.fullName,
    email: user.email,
    contact: user.contact,
    isActive: user.isActive !== false,
  };
}

const normalize = (value: unknown): string => String(value ?? '').trim();
const toLower = (value: unknown): string => normalize(value).toLowerCase();

router.get('/', requireRole('admin'), (_req, res) => {
  res.json(getDb().users.map(toPublicUser));
});

router.post(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { username, fullName, email, contact, password, role } = req.body || {};
    const trimmedUsername = normalize(username);
    const trimmedFullName = normalize(fullName);
    const trimmedEmail = normalize(email);
    const trimmedContact = normalize(contact);

    if (!trimmedUsername || !trimmedFullName) {
      res.status(400).json({ error: 'Full name and username are required.' });
      return;
    }
    if (!password) {
      res.status(400).json({ error: 'Password is required for new users.' });
      return;
    }
    if (!ROLES.includes(role)) {
      res.status(400).json({ error: 'A valid role is required.' });
      return;
    }

    const users = getDb().users;
    if (users.some((u) => u.username.toLowerCase() === trimmedUsername.toLowerCase())) {
      res.status(409).json({ error: `Username "${trimmedUsername}" already exists.` });
      return;
    }
    if (trimmedEmail && users.some((u) => toLower(u.email) === trimmedEmail.toLowerCase())) {
      res.status(409).json({ error: `Email "${trimmedEmail}" is already in use.` });
      return;
    }
    if (trimmedContact && users.some((u) => toLower(u.contact) === trimmedContact.toLowerCase())) {
      res.status(409).json({ error: `Contact number "${trimmedContact}" is already in use.` });
      return;
    }

    const newUser: StoredUser = {
      username: trimmedUsername,
      role,
      fullName: trimmedFullName,
      email: trimmedEmail || undefined,
      contact: trimmedContact || undefined,
      isActive: true,
      passwordHash: bcrypt.hashSync(String(password), 10),
    };
    users.push(newUser);
    await saveDb();
    res.status(201).json(toPublicUser(newUser));
  }),
);

router.put(
  '/:username',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const users = getDb().users;
    const index = users.findIndex((u) => u.username === req.params.username);
    if (index === -1) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    const { fullName, email, contact, password, role } = req.body || {};
    const trimmedFullName = normalize(fullName);
    const trimmedEmail = normalize(email);
    const trimmedContact = normalize(contact);

    if (!trimmedFullName) {
      res.status(400).json({ error: 'Full name is required.' });
      return;
    }
    if (!ROLES.includes(role)) {
      res.status(400).json({ error: 'A valid role is required.' });
      return;
    }
    if (trimmedEmail && users.some((u, i) => i !== index && toLower(u.email) === trimmedEmail.toLowerCase())) {
      res.status(409).json({ error: `Email "${trimmedEmail}" is already in use.` });
      return;
    }
    if (trimmedContact && users.some((u, i) => i !== index && toLower(u.contact) === trimmedContact.toLowerCase())) {
      res.status(409).json({ error: `Contact number "${trimmedContact}" is already in use.` });
      return;
    }

    const existing = users[index];
    users[index] = {
      ...existing,
      role,
      fullName: trimmedFullName,
      email: trimmedEmail || undefined,
      contact: trimmedContact || undefined,
      passwordHash: password ? bcrypt.hashSync(String(password), 10) : existing.passwordHash,
    };
    await saveDb();
    res.json(toPublicUser(users[index]));
  }),
);

router.patch(
  '/:username/active',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const user = getDb().users.find((u) => u.username === req.params.username);
    if (!user) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    if (user.role === 'admin') {
      res.status(403).json({ error: 'Admin accounts cannot be deactivated.' });
      return;
    }
    user.isActive = !!(req.body && req.body.active);
    await saveDb();
    res.json(toPublicUser(user));
  }),
);

router.delete(
  '/:username',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const target = db.users.find((u) => u.username === req.params.username);
    if (!target) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    if (target.role === 'admin') {
      res.status(403).json({ error: 'Admin accounts cannot be deleted.' });
      return;
    }
    db.users = db.users.filter((u) => u.username !== req.params.username);
    await saveDb();
    res.status(204).end();
  }),
);

export default router;
