const { query } = require('../config/db');
const logger = require('../utils/logger');
const net = require('net');

let tableReady;
let cleanupTimer;

const normalizeIpAddress = (value) => {
  if (typeof value !== 'string') return null;
  const ip = value.trim().replace(/^::ffff:/i, '');
  return net.isIP(ip) ? ip : null;
};

const cleanupDeviceSessions = async () => {
  await clearStaleLocations();
  await query(`
    UPDATE public.user_device_sessions
    SET ip_anonymized = host(set_masklen(ip_address::inet,
          CASE WHEN family(ip_address::inet) = 4 THEN 24 ELSE 48 END)),
        ip_address = NULL,
        ip_anonymized_at = NOW()
    WHERE ip_address IS NOT NULL
      AND ip_last_seen_at < NOW() - INTERVAL '30 days'
  `);
  await query(`
    UPDATE public.user_device_sessions
    SET latitude = NULL, longitude = NULL, location_accuracy_m = NULL,
        location_updated_at = NULL,
        location_revoked_at = COALESCE(location_revoked_at, NOW())
    WHERE location_consent_at IS NOT NULL AND location_revoked_at IS NULL
      AND (ended_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at <= NOW())
  `);
  await query(`
    DELETE FROM public.user_device_sessions
    WHERE created_at < NOW() - INTERVAL '365 days'
      AND (ended_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at <= NOW())
  `);
};

const clearStaleLocations = async () => {
  await query(`
    UPDATE public.user_device_sessions
    SET latitude = NULL, longitude = NULL, location_accuracy_m = NULL,
        location_updated_at = NULL
    WHERE location_consent_at IS NOT NULL AND location_revoked_at IS NULL
      AND location_updated_at < NOW() - INTERVAL '5 minutes'
  `);
};

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
        revoked_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
        ip_address TEXT,
        ip_anonymized TEXT,
        ip_last_seen_at TIMESTAMP WITH TIME ZONE,
        ip_anonymized_at TIMESTAMP WITH TIME ZONE,
        location_consent_at TIMESTAMP WITH TIME ZONE,
        location_revoked_at TIMESTAMP WITH TIME ZONE,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        location_accuracy_m DOUBLE PRECISION,
        location_updated_at TIMESTAMP WITH TIME ZONE
      )
    `).then(() => query(`
      ALTER TABLE public.user_device_sessions
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS ip_address TEXT,
      ADD COLUMN IF NOT EXISTS ip_anonymized TEXT,
      ADD COLUMN IF NOT EXISTS ip_last_seen_at TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS ip_anonymized_at TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS location_consent_at TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS location_revoked_at TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS location_accuracy_m DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMP WITH TIME ZONE
    `)).then(() => query(`
      CREATE INDEX IF NOT EXISTS user_device_sessions_user_created_idx
      ON public.user_device_sessions (user_id, created_at DESC)
    `)).then(() => query(`
      CREATE INDEX IF NOT EXISTS user_device_sessions_ip_retention_idx
      ON public.user_device_sessions (ip_last_seen_at)
      WHERE ip_address IS NOT NULL
    `)).then(() => query(`
      CREATE INDEX IF NOT EXISTS user_device_sessions_location_freshness_idx
      ON public.user_device_sessions (location_updated_at)
      WHERE latitude IS NOT NULL
    `)).then(() => cleanupDeviceSessions()).catch((error) => {
      tableReady = null;
      throw error;
    });
  }
  await tableReady;
  if (!cleanupTimer) {
    cleanupTimer = setInterval(() => {
      cleanupDeviceSessions().catch((error) => logger.error('Impossible de nettoyer les données des sessions:', error));
    }, 15 * 60 * 1000);
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

const touchSession = async (sessionId, userId, ipAddress) => {
  if (!sessionId) return;
  await ensureDeviceSessionsTable();
  await query(
    `UPDATE public.user_device_sessions
     SET last_seen_at = NOW()
     WHERE id = $1 AND ended_at IS NULL AND revoked_at IS NULL
       AND last_seen_at < NOW() - INTERVAL '2 minutes'`,
    [sessionId]
  );
  if (userId) await recordSessionIp(sessionId, userId, ipAddress);
};

const getLocationSharing = async (sessionId, userId) => {
  if (!sessionId) return false;
  await ensureDeviceSessionsTable();
  const result = await query(
    `SELECT location_consent_at IS NOT NULL AND location_revoked_at IS NULL AS enabled
     FROM public.user_device_sessions
     WHERE id = $1 AND user_id = $2 AND ended_at IS NULL AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [sessionId, userId]
  );
  return Boolean(result.rows[0]?.enabled);
};

const recordSessionIp = async (sessionId, userId, ipAddress) => {
  const ip = normalizeIpAddress(ipAddress);
  if (!ip) return;
  await query(
    `WITH request_ip AS (
       SELECT $3::inet AS address,
              host(set_masklen($3::inet,
                CASE WHEN family($3::inet) = 4 THEN 24 ELSE 48 END)) AS network
     )
     UPDATE public.user_device_sessions ds
     SET ip_anonymized = NULL, ip_anonymized_at = NULL,
         ip_last_seen_at = NOW(), ip_address = request_ip.address::text
     FROM request_ip
     WHERE ds.id = $1 AND ds.user_id = $2
       AND ds.ended_at IS NULL AND ds.revoked_at IS NULL
       AND (ds.expires_at IS NULL OR ds.expires_at > NOW())
       AND ds.ip_address IS DISTINCT FROM request_ip.address::text
       AND (ds.ip_address IS NOT NULL OR ds.ip_anonymized IS DISTINCT FROM request_ip.network)`,
    [sessionId, userId, ip]
  );
};

const setLocationSharing = async (sessionId, userId, enabled, location, ipAddress) => {
  if (!sessionId) return false;
  await ensureDeviceSessionsTable();
  const result = enabled
    ? await query(
      `UPDATE public.user_device_sessions
       SET location_consent_at = CASE
             WHEN location_revoked_at IS NOT NULL THEN NOW()
             ELSE COALESCE(location_consent_at, NOW())
           END,
           location_revoked_at = NULL,
           latitude = $3, longitude = $4, location_accuracy_m = $5, location_updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND ended_at IS NULL AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > NOW())
       RETURNING id`,
      [sessionId, userId, location.latitude, location.longitude, location.accuracy]
    )
    : await query(
      `UPDATE public.user_device_sessions
       SET location_revoked_at = NOW(), latitude = NULL, longitude = NULL,
           location_accuracy_m = NULL, location_updated_at = NULL
       WHERE id = $1 AND user_id = $2 AND ended_at IS NULL AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > NOW())
       RETURNING id`,
      [sessionId, userId]
    );
  if (enabled && result.rows.length > 0) await recordSessionIp(sessionId, userId, ipAddress);
  return result.rows.length > 0;
};

const updateCurrentLocation = async (sessionId, userId, location, ipAddress) => {
  if (!sessionId) return false;
  await ensureDeviceSessionsTable();
  const result = await query(
    `UPDATE public.user_device_sessions
     SET latitude = $3, longitude = $4, location_accuracy_m = $5, location_updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND location_consent_at IS NOT NULL
       AND location_revoked_at IS NULL AND ended_at IS NULL AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
     RETURNING id`,
    [sessionId, userId, location.latitude, location.longitude, location.accuracy]
  );
  if (result.rows.length > 0) await recordSessionIp(sessionId, userId, ipAddress);
  return result.rows.length > 0;
};

const clearCurrentLocation = async (sessionId, userId) => {
  if (!sessionId) return false;
  await ensureDeviceSessionsTable();
  const result = await query(
    `UPDATE public.user_device_sessions
     SET latitude = NULL, longitude = NULL, location_accuracy_m = NULL, location_updated_at = NULL
     WHERE id = $1 AND user_id = $2 AND location_consent_at IS NOT NULL
       AND location_revoked_at IS NULL AND ended_at IS NULL AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
     RETURNING id`,
    [sessionId, userId]
  );
  return result.rows.length > 0;
};

module.exports = {
  ensureDeviceSessionsTable,
  isSessionValid,
  touchSession,
  getLocationSharing,
  setLocationSharing,
  updateCurrentLocation,
  clearCurrentLocation,
  clearStaleLocations,
  normalizeIpAddress,
};
