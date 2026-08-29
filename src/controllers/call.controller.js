const { RtcTokenBuilder, RtcRole } = require('agora-token');
const config = require('../../config/config');
const { asyncHandler } = require('../middleware/error.middleware');
const { query } = require('../config/db');

/**
 * @desc    Générer un jeton RTC pour Agora
 * @route   POST /api/calls/generate-token
 */
const generateToken = asyncHandler(async (req, res) => {
  const { channelName, role = 'publisher' } = req.body;

  if (!channelName) {
    return res.status(400).json({ success: false, error: 'Nom du canal requis' });
  }

  const appId = config.agora.appId;
  const appCertificate = config.agora.appCertificate;

  if (!appId || !appCertificate) {
    return res.status(500).json({ success: false, error: 'Configuration Agora manquante sur le serveur' });
  }

  // Rôle Agora
  const agoraRole = role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;

  // Expiration (2 heures)
  const expirationTimeInSeconds = 3600 * 2;
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

  // Génération du token (UID 0 car Agora le gère automatiquement)
  const token = RtcTokenBuilder.buildTokenWithUid(
    appId,
    appCertificate,
    channelName,
    0,
    agoraRole,
    privilegeExpiredTs,
    privilegeExpiredTs
  );

  res.json({
    success: true,
    data: {
      token,
      appId,
      channelName
    }
  });
});

/**
 * @desc    Obtenir l'historique des appels
 * @route   GET /api/calls/history
 */
const getCallHistory = asyncHandler(async (req, res) => {
  const userId = req.userId;

  const result = await query(
    `SELECT c.*,
            p1.full_name as caller_name, p1.avatar_url as caller_avatar,
            p2.full_name as callee_name, p2.avatar_url as callee_avatar
     FROM public.calls c
     LEFT JOIN public.profiles p1 ON c.caller_id = p1.id
     LEFT JOIN public.profiles p2 ON c.callee_id = p2.id
     WHERE c.caller_id = $1 OR c.callee_id = $1
     ORDER BY c.created_at DESC
     LIMIT 50`,
    [userId]
  );

  res.json({
    success: true,
    data: result.rows
  });
});

module.exports = { generateToken, getCallHistory };
