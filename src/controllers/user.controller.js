const { query } = require('../config/db');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/error.middleware');

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
    'SELECT id, email, full_name, username, avatar_url, status, phone_number, last_seen FROM public.profiles WHERE id = $1',
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

module.exports = {
  searchUsers,
  getProfile,
  updateProfile,
  syncContacts,
};
