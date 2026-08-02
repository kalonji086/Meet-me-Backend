const { RtcTokenBuilder, RtcRole } = require('agora-token');
const config = require('../../config/config');
const { asyncHandler } = require('../middleware/error.middleware');

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

module.exports = { generateToken };
