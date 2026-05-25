import dotenv from 'dotenv';

dotenv.config();

export const PORT = Number(process.env.PORT) || 4000;

export const JWT_SECRET = process.env.JWT_SECRET || 'talf-solar-dev-secret-change-me';

export const JWT_EXPIRES_SECONDS = Number(process.env.JWT_EXPIRES_SECONDS) || 60 * 60 * 24 * 7;

// SolisCloud API — .env credentials take precedence over UI-saved ones.
export const SOLIS_API_ID = (process.env.SOLIS_API_ID || '').trim();
export const SOLIS_API_SECRET = (process.env.SOLIS_API_SECRET || '').trim();
export const SOLIS_BASE_URL = (process.env.SOLIS_BASE_URL || 'https://www.soliscloud.com:13333').trim();

export const SOLIS_AUTO_SYNC = (process.env.SOLIS_AUTO_SYNC || 'true').toLowerCase() !== 'false';
export const SOLIS_SYNC_TTL_HOURS = Number(process.env.SOLIS_SYNC_TTL_HOURS) || 6;

// 10 min keeps dashboards near-live without exhausting the ~3 req/sec API rate limit.
export const SOLIS_CRON_INTERVAL_MINUTES = Number(process.env.SOLIS_CRON_INTERVAL_MINUTES) || 10;
