const { query } = require('../config/db');
const { asyncHandler } = require('../middleware/error.middleware');
const logger = require('../utils/logger');
const socketService = require('../services/socket.service');

/**
 * @desc    Obtenir le profil de l'utilisateur actuel
 * @route   GET /api/me (Route globale consolidée)
 */
const getMe = asyncHandler(async (req, res) => {
  const userId = req.userId;

  const result = await query(
    'SELECT id, email, username, full_name, avatar_url, status, phone_number, last_seen, privacy_settings, last_login_at, is_global_admin FROM public.profiles WHERE id = $1',
    [userId]
  );

  const user = result.rows[0];

  if (!user) {
    return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });
  }

  res.json({
    success: true,
    data: {
      id: user.id,
      email: user.email,
      username: user.username,
      name: user.full_name,
      avatar: user.avatar_url,
      status: user.status,
      phone_number: user.phone_number,
      last_seen: user.last_seen,
      privacy_settings: user.privacy_settings,
      last_login_at: user.last_login_at,
      is_global_admin: user.is_global_admin
    },
  });
});

/**
 * @desc    Mettre à jour le profil
 * @route   PUT /api/users/profile
 */
const updateProfile = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { name, status, avatar_url, username } = req.body;

  // Si on veut changer de pseudo, on vérifie la disponibilité
  if (username) {
    const usernameLower = username.toLowerCase().trim();

    // Vérifier les caractères autorisés (lettres, chiffres, underscores, points)
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

  // Diffuser le changement via Socket.IO
  socketService.notifyUserStatusChange(userId, updatedUser.status);
  socketService.broadcast('user_profile_updated', {
    userId,
    name: updatedUser.full_name,
    username: updatedUser.username,
    avatar: updatedUser.avatar_url,
    status: updatedUser.status
  });

  res.json({
    success: true,
    data: {
      ...updatedUser,
      name: updatedUser.full_name,
      avatar: updatedUser.avatar_url
    },
    message: 'Profil mis à jour avec succès',
  });
});

/**
 * @desc    Rechercher des utilisateurs
 * @route   GET /api/users/search
 */
const searchUsers = asyncHandler(async (req, res) => {
  const { query: searchQuery } = req.query;
  const userId = req.userId;

  if (!searchQuery) {
    return res.json({ success: true, data: [] });
  }

  const searchTerm = `%${searchQuery.toLowerCase()}%`;

  const result = await query(
    `SELECT id, full_name, avatar_url, status, username, phone_number
     FROM public.profiles
     WHERE (LOWER(full_name) LIKE $1
        OR LOWER(username) LIKE $1
        OR phone_number LIKE $1
        OR email LIKE $1)
       AND id != $2
     LIMIT 20`,
    [searchTerm, userId]
  );

  res.json({
    success: true,
    data: result.rows,
  });
});

/**
 * @desc    Synchroniser les contacts
 * @route   POST /api/users/sync-contacts
 */
const syncContacts = asyncHandler(async (req, res) => {
  const { phoneNumbers } = req.body;
  const userId = req.userId;

  if (!phoneNumbers || !Array.isArray(phoneNumbers)) {
    return res.status(400).json({ success: false, error: 'Liste de numéros requise' });
  }

  const result = await query(
    `SELECT id, full_name, avatar_url, status, phone_number, username
     FROM public.profiles
     WHERE phone_number = ANY($1) AND id != $2`,
    [phoneNumbers, userId]
  );

  res.json({
    success: true,
    data: result.rows,
  });
});

/**
 * @desc    Mettre à jour les paramètres de confidentialité
 */
const updatePrivacy = asyncHandler(async (req, res) => {
  const { privacySettings } = req.body;
  const userId = req.userId;

  await query(
    'UPDATE public.profiles SET privacy_settings = $1 WHERE id = $2',
    [JSON.stringify(privacySettings), userId]
  );

  res.json({ success: true, message: 'Paramètres mis à jour' });
});

/**
 * @desc    Mettre à jour le push token
 */
const updatePushToken = asyncHandler(async (req, res) => {
  const { pushToken } = req.body;
  const userId = req.userId;

  await query(
    'UPDATE public.profiles SET push_token = $1 WHERE id = $2',
    [pushToken, userId]
  );

  res.json({ success: true });
});

/**
 * @desc    Obtenir les badges (non lus)
 */
const getBadges = asyncHandler(async (req, res) => {
  const userId = req.userId;

  // Compter messages non lus
  const msgRes = await query(
    'SELECT COUNT(*) FROM public.messages m JOIN public.chat_participants cp ON m.chat_id = cp.chat_id WHERE cp.user_id = $1 AND m.sender_id != $1 AND m.status != \'read\'',
    [userId]
  );

  res.json({
    success: true,
    data: {
      messages: parseInt(msgRes.rows[0].count),
      calls: 0,
      status: 0
    }
  });
});

module.exports = {
  getMe,
  updateProfile,
  searchUsers,
  syncContacts,
  updatePrivacy,
  updatePushToken,
  getBadges
};
