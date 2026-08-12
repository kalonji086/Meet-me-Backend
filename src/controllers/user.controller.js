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
    'SELECT id, email, username, full_name, avatar_url, status, phone_number, last_seen, privacy_settings, last_login_at, is_global_admin, is_locked, push_token FROM public.profiles WHERE id = $1',
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
  const { name, status, avatar_url, username } = req.body;

  // Déterminer si avatar_url est présent dans la requête (même si null)
  const avatarIsPresent = Object.prototype.hasOwnProperty.call(req.body, 'avatar_url');

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
         avatar_url = CASE WHEN $8 THEN $3 ELSE avatar_url END,
         username = COALESCE($4, username),
         accepted_legal_version = COALESCE($5, accepted_legal_version),
         accepted_tos_version = COALESCE($6, accepted_tos_version),
         accepted_privacy_version = COALESCE($7, accepted_privacy_version),
         updated_at = NOW()
     WHERE id = $9
     RETURNING id, full_name, email, username, avatar_url, status, phone_number, is_global_admin, push_token, accepted_legal_version, accepted_tos_version, accepted_privacy_version`,
    [
      name,
      status,
      avatar_url,
      username?.toLowerCase().trim(),
      req.body.accepted_legal_version,
      req.body.accepted_tos_version,
      req.body.accepted_privacy_version,
      avatarIsPresent,
      userId
    ]
  );

  const updatedUser = result.rows[0];
  socketService.notifyUserStatusChange(userId, updatedUser.status);

  // Notifier l'admin du changement de profil (Pseudo ou Photo)
  socketService.broadcast('admin_user_profile_updated', {
    userId: updatedUser.id,
    name: updatedUser.full_name,
    email: updatedUser.email,
    username: updatedUser.username,
    avatar: updatedUser.avatar_url,
    updated_at: new Date()
  });

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

/**
 * @desc    Soumettre une demande de vérification
 */
const submitVerification = asyncHandler(async (req, res) => {
  const { documentUrl } = req.body;
  const userId = req.userId;

  if (!documentUrl) {
    return res.status(400).json({ success: false, error: 'Document requis' });
  }

  const result = await query(
    'INSERT INTO public.verification_requests (user_id, document_url) VALUES ($1, $2) RETURNING *',
    [userId, documentUrl]
  );

  socketService.broadcast('admin_new_verification', { requestId: result.rows[0].id, userId });

  res.json({ success: true, message: 'Demande envoyée' });
});

/**
 * @desc Get user by id (public minimal profile)
 */
const getUserById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await query('SELECT id, full_name, avatar_url, status, username FROM public.profiles WHERE id = $1', [id]);
  const user = result.rows[0];
  if (!user) return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });
  res.json({ success: true, data: { id: user.id, name: user.full_name, avatar: user.avatar_url, status: user.status, username: user.username } });
});

/**
 * @desc    Bloquer un utilisateur
 */
const blockUser = asyncHandler(async (req, res) => {
  const { targetId } = req.body;
  const userId = req.userId;

  await query(
    'INSERT INTO public.blocked_users (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [userId, targetId]
  );

  res.json({ success: true, message: 'Utilisateur bloqué' });
});

/**
 * @desc    Signaler un utilisateur
 */
const reportUser = asyncHandler(async (req, res) => {
  const { targetId, reason } = req.body;
  const userId = req.userId;

  await query(
    'INSERT INTO public.reported_content (reporter_id, target_id, reason, report_type) VALUES ($1, $2, $3, \'user\')',
    [userId, targetId, reason]
  );

  res.json({ success: true, message: 'Signalement envoyé' });
});

/**
 * @desc    Ajouter aux contacts
 */
const addContact = asyncHandler(async (req, res) => {
  const { contactId } = req.body;
  const userId = req.userId;

  await query(
    'INSERT INTO public.contacts (user_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [userId, contactId]
  );

  res.json({ success: true, message: 'Contact ajouté' });
});

/**
 * @desc    Vérifier si un utilisateur est dans les contacts
 */
const checkContact = asyncHandler(async (req, res) => {
  const { peerId } = req.params;
  const userId = req.userId;

  const result = await query(
    'SELECT 1 FROM public.contacts WHERE user_id = $1 AND contact_id = $2',
    [userId, peerId]
  );

  res.json({ success: true, isContact: result.rows.length > 0 });
});

/**
 * @desc    Supprimer le compte de l'utilisateur
 */
const deleteAccount = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ success: false, error: 'Mot de passe requis pour confirmer la suppression' });
  }

  // 1. Vérifier le mot de passe
  const result = await query('SELECT password FROM public.profiles WHERE id = $1', [userId]);
  const user = result.rows[0];

  if (!user) {
    return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });
  }

  const bcrypt = require('bcryptjs');
  const isMatch = await bcrypt.compare(password, user.password);

  if (!isMatch) {
    return res.status(401).json({ success: false, error: 'Mot de passe incorrect' });
  }

  // 2. Nettoyage manuel des dépendances critiques avant suppression
  try {
    // Utiliser une transaction pour s'assurer que tout est nettoyé ou rien
    await query('BEGIN');

    // Supprimer les données liées (celles avec ON DELETE CASCADE devraient partir seules, mais on assure le coup)
    await query('DELETE FROM public.messages WHERE sender_id = $1', [userId]);
    await query('DELETE FROM public.chat_participants WHERE user_id = $1', [userId]);
    await query('DELETE FROM public.status_reactions WHERE user_id = $1', [userId]);
    await query('DELETE FROM public.status_views WHERE user_id = $1', [userId]);
    await query('DELETE FROM public.statuses WHERE user_id = $1', [userId]);
    await query('DELETE FROM public.appeals WHERE user_id = $1', [userId]);
    await query('DELETE FROM public.verification_requests WHERE user_id = $1', [userId]);

    // Nettoyer les références circulaires ou protectrices
    await query('UPDATE public.chats SET created_by = NULL WHERE created_by = $1', [userId]);
    await query('UPDATE public.calls SET caller_id = NULL WHERE caller_id = $1', [userId]);
    await query('UPDATE public.calls SET callee_id = NULL WHERE callee_id = $1', [userId]);
    await query('UPDATE public.notification_campaigns SET created_by = NULL WHERE created_by = $1', [userId]);
    await query('UPDATE public.admin_audit_logs SET admin_id = NULL WHERE admin_id = $1', [userId]);

    // Supprimer des tables de relations
    await query('DELETE FROM public.reported_content WHERE reporter_id = $1 OR target_id = $1', [userId]);
    await query('DELETE FROM public.blocked_users WHERE blocker_id = $1 OR blocked_id = $1', [userId]);
    await query('DELETE FROM public.contacts WHERE user_id = $1 OR contact_id = $1', [userId]);

    // 3. Suppression finale du profil
    await query('DELETE FROM public.profiles WHERE id = $1', [userId]);

    await query('COMMIT');

    socketService.broadcast('admin_user_deleted', { userId });
    res.json({ success: true, message: 'Compte supprimé avec succès' });
  } catch (deleteError) {
    await query('ROLLBACK');
    logger.error('Erreur lors de la suppression du compte:', deleteError);
    return res.status(500).json({
      success: false,
      error: 'Erreur technique de base de données',
      message: 'Une contrainte de référence empêche la suppression. Contactez le support.'
    });
  }
});

module.exports = { getMe, updateProfile, searchUsers, syncContacts, updatePrivacy, updatePushToken, getBadges, submitVerification, getUserById, blockUser, reportUser, addContact, checkContact, deleteAccount };
