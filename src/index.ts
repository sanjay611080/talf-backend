import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import { PORT, SOLIS_AUTO_SYNC, SOLIS_CRON_INTERVAL_MINUTES, SOLIS_SYNC_TTL_HOURS } from './config';
import { getDb, initStore } from './db/store';
import auditRoutes from './routes/audit';
import authRoutes from './routes/auth';
import kpiRoutes from './routes/kpis';
import moduleBuildRoutes from './routes/moduleBuilds';
import projectRoutes from './routes/projects';
import solisRoutes from './routes/solis';
import userRoutes from './routes/users';
import { isSolisConfigured } from './services/solisService';
import { isSyncRunning, runCronSync, runFullSync, setNextSyncAt } from './services/solisSync';

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'talf-solar-backend' });
});

app.use('/api/auth', authRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/users', userRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/module-builds', moduleBuildRoutes);
app.use('/api/kpis', kpiRoutes);
app.use('/api/solis', solisRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Centralized error handler.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[error]', err);
  const message = err instanceof Error ? err.message : 'Internal server error';
  res.status(500).json({ error: message });
});

// Load the dataset from Supabase, then start accepting requests.
async function start() {
  await initStore();

  app.listen(PORT, () => {
    console.log(`[server] Talf Solar backend listening on http://localhost:${PORT}`);

    // Fetch the SolisCloud account on startup, unless a recent sync already exists.
    if (SOLIS_AUTO_SYNC && isSolisConfigured()) {
      const lastSync = getDb().solisSyncedAt || 0;
      const ageHours = (Date.now() - lastSync) / (1000 * 60 * 60);
      if (ageHours >= SOLIS_SYNC_TTL_HOURS) {
        console.log('[solis] Credentials detected — starting SolisCloud sync in the background…');
        void runFullSync();
      } else {
        console.log(`[solis] Skipping sync — last sync was ${ageHours.toFixed(1)}h ago.`);
      }

      // Schedule a recurring delta sync that only refreshes the current month's
      // generation. Manual fields (tariffs, targets, irradiation, import) are
      // never overwritten — see runCronSync.
      const intervalMs = SOLIS_CRON_INTERVAL_MINUTES * 60 * 1000;
      console.log(`[solis] Cron sync scheduled every ${SOLIS_CRON_INTERVAL_MINUTES} min.`);
      setNextSyncAt(Date.now() + intervalMs);
      setInterval(() => {
        if (isSyncRunning()) {
          // Another sync is in progress — defer; nextSyncAt stays accurate
          // because we'll re-publish it once this tick wraps up.
          setNextSyncAt(Date.now() + intervalMs);
          return;
        }
        runCronSync()
          .catch((err) => console.error('[solis-cron] failed:', err))
          .finally(() => setNextSyncAt(Date.now() + intervalMs));
      }, intervalMs).unref?.();
    }
  });
}

start().catch((err) => {
  console.error('[server] Startup failed:', err);
  process.exit(1);
});
