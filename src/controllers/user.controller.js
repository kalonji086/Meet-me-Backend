const { query } = require('../config/db');
const { asyncHandler } = require('../middleware/error.middleware');
const logger = require('../utils/logger');
const socketService = require('../services/socket.service');

/**
 * @desc    Obtenir le profil de l'utilisateur actuel
 */
const getMe = asyncHandler(async (req, res) => {
  const userId = req.userId;

  const result = await query(
    'SELECT id, email, username, full_name, avatar_url, status, phone_number, last_seen, privacy_settings, last_login_at, is_global_admin, is_locked FROM public.profiles WHERE id = $1',
    [userId]
  );

  const user = result.rows[0];

  if (!user) {
    return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });
  }

  // Vérification immédiate du blocage
  if (user.is_locked) {
    return res.status(403).json({
      success: false,
      error: 'Compte banni',
      isLocked: true,
      message: 'Votre compte a été suspendu pour non-respect de nos conditions d\'utilisation.'
    });
  }

  res.json({
    success: true,
    data: {
      ...user,
      name: user.full_name,
      avatar: user.avatar_url
    },
  });
});

/**
 * @desc    Mettre à jour le profil
 */
const updateProfile = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { name, status, avatar_url, username } = req.body;

  if (username) {
    const usernameLower = username.toLowerCase().trim();
    if (!/^[a-z0-9_.]+$/.test(usernameLower)) {
      return res.status(400).json({ success: false, error: 'Le pseudo contient des caractères non autorisés' });
    }
    const existing = await query(
      'SELECT id FROM public.profiles WHERE LOWER(username) = $1 AND id != $2',
      [usernameLower, userId]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'Ce pseudo n\'est pas disponible' });
    }
  }

  const result = await query(
    `UPDATE public.profiles
     SET full_name = COALESCE($1, full_name),
         status = COALESCE($2, status),
         avatar_url = COALESCE($3, avatar_url),
         username = COALESCE($4, username),
         updated_at = NOW()
     WHERE id = $5
     RETURNING id, full_name, email, username, avatar_url, status, phone_number, is_global_admin`,
    [name, status, avatar_url, username?.toLowerCase().trim(), userId]
  );

  const updatedUser = result.rows[0];
  socketService.notifyUserStatusChange(userId, updatedUser.status);

  res.json({
    success: true,
    data: { ...updatedUser, name: updatedUser.full_name, avatar: updatedUser.avatar_url },
    message: 'Profil mis à jour',
  });
});

/**
 * @desc    Rechercher des utilisateurs (Exclut les bannis)
 */
const searchUsers = asyncHandler(async (req, res) => {
  const { query: searchQuery } = req.query;
  const userId = req.userId;

  if (!searchQuery) return res.json({ success: true, data: [] });

  const searchTerm = `%${searchQuery.toLowerCase()}%`;

  const result = await query(
    `SELECT id, full_name, avatar_url, status, username
     FROM public.profiles
     WHERE (LOWER(full_name) LIKE $1 OR LOWER(username) LIKE $1 OR phone_number LIKE $1)
       AND id != $2
       AND is_locked = FALSE
       AND is_global_admin = FALSE
     LIMIT 20`,
    [searchTerm, userId]
  );

  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Synchroniser les contacts (Exclut les bannis)
 */
const syncContacts = asyncHandler(async (req, res) => {
  const { phoneNumbers } = req.body;
  const userId = req.userId;

  if (!phoneNumbers || !Array.isArray(phoneNumbers)) {
    return res.status(400).json({ success: false, error: 'Liste requise' });
  }

  const result = await query(
    `SELECT id, full_name, avatar_url, status, phone_number, username
     FROM public.profiles
     WHERE phone_number = ANY($1)
       AND id != $2
       AND is_locked = FALSE
       AND is_global_admin = FALSE`,
    [phoneNumbers, userId]
  );

  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Mettre à jour la confidentialité
 */
const updatePrivacy = asyncHandler(async (req, res) => {
  await query('UPDATE public.profiles SET privacy_settings = $1 WHERE id = $2', [JSON.stringify(req.body.privacySettings), req.userId]);
  res.json({ success: true });
});

/**
 * @desc    Push token
 */
const updatePushToken = asyncHandler(async (req, res) => {
  await query('UPDATE public.profiles SET push_token = $1 WHERE id = $2', [req.body.pushToken, req.userId]);
  res.json({ success: true });
});

/**
 * @desc    Badges
 */
const getBadges = asyncHandler(async (req, res) => {
  const msgRes = await query(
    'SELECT COUNT(*) FROM public.messages m JOIN public.chat_participants cp ON m.chat_id = cp.chat_id WHERE cp.user_id = $1 AND m.sender_id != $1 AND m.status != \'read\'',
    [req.userId]
  );
  res.json({ success: true, data: { messages: parseInt(msgRes.rows[0].count), calls: 0, status: 0 } });
});

module.exports = { getMe, updateProfile, searchUsers, syncContacts, updatePrivacy, updatePushToken, getBadges };
