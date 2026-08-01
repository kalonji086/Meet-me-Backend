const { query } = require('../config/db');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/error.middleware');
const bcrypt = require('bcryptjs');

/**
 * @desc    Rechercher des utilisateurs
 * @route   GET /api/users/search
 * @access  Private
 */
const searchUsers = asyncHandler(async (req, res) => {
  const { query: searchQuery, limit = 20 } = req.query;
  const userId = req.userId;

  if (!searchQuery) {
    // Retourner tous les utilisateurs (sauf soi-même) si pas de recherche
    const result = await query(
      `SELECT id, email, full_name, username, avatar_url, status
       FROM public.profiles
       WHERE id != $1
       LIMIT $2`,
      [userId, limit]
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  }

  const searchTerm = `%${searchQuery}%`;

  const result = await query(
    `SELECT id, email, full_name, username, avatar_url, status
     FROM public.profiles
     WHERE id != $1 AND (full_name ILIKE $2 OR username ILIKE $2 OR email ILIKE $2)
     LIMIT $3`,
    [userId, searchTerm, limit]
  );

  res.json({
    success: true,
    data: result.rows,
  });
});

/**
 * @desc    Obtenir le profil d'un utilisateur
 * @route   GET /api/users/profile
 * @access  Private
 */
const getProfile = asyncHandler(async (req, res) => {
  const userId = req.userId;

  const result = await query(
    'SELECT id, email, full_name, username, avatar_url, status, phone_number, last_seen, privacy_settings FROM public.profiles WHERE id = $1',
    [userId]
  );

  const user = result.rows[0];

  if (!user) {
    return res.status(404).json({
      success: false,
      error: 'Utilisateur non trouvé',
    });
  }

  res.json({
    success: true,
    data: user,
  });
});

/**
 * @desc    Mettre à jour le profil
 * @route   PUT /api/users/profile
 * @access  Private
 */
const updateProfile = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { name, username, avatar_url, status } = req.body;

  const result = await query(
    `UPDATE public.profiles
     SET full_name = COALESCE($1, full_name),
         username = COALESCE($2, username),
         avatar_url = COALESCE($3, avatar_url),
         status = COALESCE($4, status),
         updated_at = NOW()
     WHERE id = $5
     RETURNING id, full_name, email, username, avatar_url, status`,
    [name, username, avatar_url, status, userId]
  );

  const user = result.rows[0];

  res.json({
    success: true,
    data: {
      user: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        username: user.username,
        avatar: user.avatar_url,
        status: user.status
      },
    },
    message: 'Profil mis à jour avec succès',
  });
});

/**
 * @desc    Synchroniser les contacts téléphoniques
 * @route   POST /api/users/sync-contacts
 * @access  Private
 */
const syncContacts = asyncHandler(async (req, res) => {
  const { phoneNumbers } = req.body;
  const userId = req.userId;

  if (!phoneNumbers || !Array.isArray(phoneNumbers)) {
    return res.status(400).json({
      success: false,
      error: 'Veuillez fournir une liste de numéros de téléphone',
    });
  }

  // On cherche les profils qui correspondent à ces numéros
  const result = await query(
    `SELECT id, full_name, username, avatar_url, status, phone_number
     FROM public.profiles
     WHERE id != $1 AND phone_number = ANY($2)`,
    [userId, phoneNumbers]
  );

  res.json({
    success: true,
    data: result.rows,
  });
});

/**
 * @desc    Mettre à jour les paramètres de confidentialité
 * @route   PUT /api/users/privacy
 * @access  Private
 */
const updatePrivacySettings = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { privacySettings } = req.body;

  if (!privacySettings) {
    return res.status(400).json({ success: false, error: 'Données de confidentialité manquantes' });
  }

  // On récupère les paramètres actuels pour fusionner
  const currentResult = await query('SELECT privacy_settings FROM public.profiles WHERE id = $1', [userId]);
  const currentSettings = currentResult.rows[0].privacy_settings || {};
  const newSettings = { ...currentSettings, ...privacySettings };

  const result = await query(
    'UPDATE public.profiles SET privacy_settings = $1 WHERE id = $2 RETURNING privacy_settings',
    [newSettings, userId]
  );

  res.json({
    success: true,
    data: result.rows[0].privacy_settings,
    message: 'Paramètres de confidentialité mis à jour'
  });
});

/**
 * @desc    Supprimer son compte
 * @route   DELETE /api/users/account
 * @access  Private
 */
const deleteAccount = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ success: false, error: 'Mot de passe requis pour confirmer la suppression' });
  }

  // Vérifier le mot de passe
  const result = await query('SELECT password FROM public.profiles WHERE id = $1', [userId]);
  const user = result.rows[0];

  const isPasswordValid = await bcrypt.compare(password, user.password);
  if (!isPasswordValid) {
    return res.status(401).json({ success: false, error: 'Mot de passe incorrect' });
  }

  // Supprimer le profil (les cascades SQL s'occuperont du reste)
  await query('DELETE FROM public.profiles WHERE id = $1', [userId]);

  res.json({
    success: true,
    message: 'Compte supprimé définitivement'
  });
});

/**
 * @desc    Mettre à jour le push token pour les notifications
 * @route   PUT /api/users/push-token
 * @access  Private
 */
const updatePushToken = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { pushToken } = req.body;

  await query(
    'UPDATE public.profiles SET push_token = $1 WHERE id = $2',
    [pushToken, userId]
  );

  res.json({
    success: true,
    message: 'Token de notification mis à jour'
  });
});

/**
 * @desc    Obtenir les compteurs de notifications (badges)
 * @route   GET /api/users/badges
 * @access  Private
 */
const getBadges = asyncHandler(async (req, res) => {
  const userId = req.userId;

  // 1. Compter les messages non lus
  const messagesResult = await query(
    "SELECT COUNT(*) as count FROM public.messages WHERE chat_id IN (SELECT chat_id FROM public.chat_participants WHERE user_id = $1) AND sender_id != $1 AND status != 'read'",
    [userId]
  );

  // 2. Compter les appels manqués
  const callsResult = await query(
    "SELECT COUNT(*) as count FROM public.calls WHERE receiver_id = $1 AND status = 'missed'",
    [userId]
  );

  // 3. Compter les nouveaux status (non vus par l'utilisateur)
  const statusResult = await query(
    `SELECT COUNT(*) as count
     FROM public.statuses s
     WHERE s.user_id != $1
     AND s.expires_at > NOW()
     AND s.id NOT IN (SELECT status_id FROM public.status_views WHERE user_id = $1)`,
    [userId]
  );

  res.json({
    success: true,
    data: {
      messages: parseInt(messagesResult.rows[0].count),
      calls: parseInt(callsResult.rows[0].count),
      status: parseInt(statusResult.rows[0].count),
      total: parseInt(messagesResult.rows[0].count) + parseInt(callsResult.rows[0].count)
    }
  });
});

module.exports = {
  searchUsers,
  getProfile,
  updateProfile,
  syncContacts,
  updatePrivacySettings,
  deleteAccount,
  updatePushToken,
  getBadges,
};
