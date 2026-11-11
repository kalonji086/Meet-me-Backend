const { query } = require('../config/db');
const logger = require('../utils/logger');

let tableReady;
let cleanupTimer;

const ensureDeviceSessionsTable = async () => {
  if (!tableReady) {
    tableReady = query(`
      CREATE TABLE IF NOT EXISTS public.user_device_sessions (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        device_info JSONB NOT NULL DEFAULT '{}'::jsonb,
        app_version TEXT,
        country TEXT,
        city TEXT,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMP WITH TIME ZONE,
        ended_at TIMESTAMP WITH TIME ZONE,
        revoked_at TIMESTAMP WITH TIME ZONE,
        revoked_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL
      )
    `).then(() => query(`
      ALTER TABLE public.user_device_sessions
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE
    `)).then(() => query(`
      CREATE INDEX IF NOT EXISTS user_device_sessions_user_created_idx
      ON public.user_device_sessions (user_id, created_at DESC)
    `)).then(() => query(`
      DELETE FROM public.user_device_sessions
      WHERE created_at < NOW() - INTERVAL '365 days'
        AND (ended_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at <= NOW())
    `)).catch((error) => {
      tableReady = null;
      throw error;
    });
  }
  await tableReady;
  if (!cleanupTimer) {
    cleanupTimer = setInterval(() => {
      query(`
        DELETE FROM public.user_device_sessions
        WHERE created_at < NOW() - INTERVAL '365 days'
          AND (ended_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at <= NOW())
      `).catch((error) => logger.error('Impossible de purger l’historique des sessions expirées:', error));
    }, 24 * 60 * 60 * 1000);
    if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
  }
};

const isSessionValid = async (sessionId, userId) => {
  if (!sessionId) return true;
  await ensureDeviceSessionsTable();
  const result = await query(
    `SELECT 1
     FROM public.user_device_sessions
     WHERE id = $1 AND user_id = $2 AND ended_at IS NULL AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [sessionId, userId]
  );
  return result.rows.length > 0;
};

const touchSession = async (sessionId) => {
  if (!sessionId) return;
  await ensureDeviceSessionsTable();
  await query(
    `UPDATE public.user_device_sessions
     SET last_seen_at = NOW()
     WHERE id = $1 AND ended_at IS NULL AND revoked_at IS NULL
       AND last_seen_at < NOW() - INTERVAL '2 minutes'`,
    [sessionId]
  );
};

module.exports = { ensureDeviceSessionsTable, isSessionValid, touchSession };
