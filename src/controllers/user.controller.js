const { query } = require('../config/db');
const { asyncHandler } = require('../middleware/error.middleware');
const logger = require('../utils/logger');
const socketService = require('../services/socket.service');
const bcrypt = require('bcryptjs');

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
  const userId = req.userId;

  const avatarIsPresent = Object.prototype.hasOwnProperty.call(req.body, 'avatar_url');

  if (username) {
    const usernameLower = username.toLowerCase().trim();
    if (!/^[a-z0-9_.]+$/.test(usernameLower)) {
      return res.status(400).json({ success: false, error: 'Pseudo invalide' });
    }
    const existing = await query(
      'SELECT id FROM public.profiles WHERE LOWER(username) = $1 AND id != $2',
      [usernameLower, userId]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'Ce pseudo est déjà utilisé' });
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
     RETURNING id, full_name, email, username, avatar_url, status, phone_number, is_global_admin, push_token`,
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

  socketService.broadcast('admin_user_profile_updated', {
    userId: updatedUser.id,
    name: updatedUser.full_name,
    username: updatedUser.username,
    avatar: updatedUser.avatar_url
  });

  res.json({
    success: true,
    data: { ...updatedUser, name: updatedUser.full_name, avatar: updatedUser.avatar_url },
  });
});

/**
 * @desc    Supprimer le compte (SÉCURISÉ)
 */
const deleteAccount = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ success: false, error: 'Mot de passe requis' });
  }

  const userRes = await query('SELECT password FROM public.profiles WHERE id = $1', [userId]);
  const user = userRes.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ success: false, error: 'Mot de passe incorrect' });
  }

  try {
    await query('BEGIN');

    // 1. Désamorcer les clés étrangères protectrices (NULL)
    await query('UPDATE public.chats SET created_by = NULL WHERE created_by = $1', [userId]);
    await query('UPDATE public.calls SET caller_id = NULL WHERE caller_id = $1', [userId]);
    await query('UPDATE public.calls SET callee_id = NULL WHERE callee_id = $1', [userId]);
    await query('UPDATE public.admin_audit_logs SET admin_id = NULL WHERE admin_id = $1', [userId]);

    // 2. Supprimer les données orphelines (Normalement CASCADE mais on nettoie manuellement pour être sûr)
    await query('DELETE FROM public.chat_participants WHERE user_id = $1', [userId]);
    await query('DELETE FROM public.messages WHERE sender_id = $1', [userId]);
    await query('DELETE FROM public.status_views WHERE user_id = $1', [userId]);
    await query('DELETE FROM public.status_reactions WHERE user_id = $1', [userId]);
    await query('DELETE FROM public.statuses WHERE user_id = $1', [userId]);
    await query('DELETE FROM public.appeals WHERE user_id = $1', [userId]);
    await query('DELETE FROM public.contacts WHERE user_id = $1 OR contact_id = $1', [userId]);
    await query('DELETE FROM public.blocked_users WHERE blocker_id = $1 OR blocked_id = $1', [userId]);

    // 3. Suppression finale
    await query('DELETE FROM public.profiles WHERE id = $1', [userId]);

    await query('COMMIT');

    socketService.broadcast('admin_user_deleted', { userId });
    res.json({ success: true, message: 'Compte supprimé définitivement' });
  } catch (error) {
    await query('ROLLBACK');
    logger.error('CRITICAL: Account deletion failed:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur de base de données',
      message: 'Impossible de supprimer le compte en raison d\'une référence active. Détail: ' + error.message
    });
  }
});

// Les autres méthodes (searchUsers, syncContacts, etc.) restent identiques
const searchUsers = asyncHandler(async (req, res) => {
  const { query: searchQuery } = req.query;
  const userId = req.userId;
  if (!searchQuery) return res.json({ success: true, data: [] });
  const searchTerm = `%${searchQuery.toLowerCase()}%`;
  const result = await query(
    `SELECT id, full_name, avatar_url, status, username FROM public.profiles
     WHERE (LOWER(full_name) LIKE $1 OR LOWER(username) LIKE $1 OR phone_number LIKE $1)
     AND id != $2 AND is_locked = FALSE LIMIT 20`,
    [searchTerm, userId]
  );
  res.json({ success: true, data: result.rows });
});

const syncContacts = asyncHandler(async (req, res) => {
  const { phoneNumbers } = req.body;
  const result = await query(
    'SELECT id, full_name, avatar_url, status, phone_number, username FROM public.profiles WHERE phone_number = ANY($1) AND is_locked = FALSE',
    [phoneNumbers]
  );
  res.json({ success: true, data: result.rows });
});

const updatePrivacy = asyncHandler(async (req, res) => {
  await query('UPDATE public.profiles SET privacy_settings = $1 WHERE id = $2', [JSON.stringify(req.body.privacySettings), req.userId]);
  res.json({ success: true });
});

const updatePushToken = asyncHandler(async (req, res) => {
  await query('UPDATE public.profiles SET push_token = $1 WHERE id = $2', [req.body.pushToken, req.userId]);
  res.json({ success: true });
});

const getBadges = asyncHandler(async (req, res) => {
  const msgRes = await query(
    'SELECT COUNT(*) FROM public.messages m JOIN public.chat_participants cp ON m.chat_id = cp.chat_id WHERE cp.user_id = $1 AND m.sender_id != $1 AND m.status != \'read\'',
    [req.userId]
  );
  res.json({ success: true, data: { messages: parseInt(msgRes.rows[0].count), calls: 0, status: 0 } });
});

const submitVerification = asyncHandler(async (req, res) => {
  await query('INSERT INTO public.verification_requests (user_id, document_url) VALUES ($1, $2)', [req.userId, req.body.documentUrl]);
  res.json({ success: true, message: 'Demande envoyée' });
});

const getUserById = asyncHandler(async (req, res) => {
  const result = await query('SELECT id, full_name, avatar_url, status, username FROM public.profiles WHERE id = $1', [req.params.id]);
  if (result.rows[0]) res.json({ success: true, data: result.rows[0] });
  else res.status(404).json({ success: false, error: 'Non trouvé' });
});

const blockUser = asyncHandler(async (req, res) => {
  await query('INSERT INTO public.blocked_users (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.userId, req.body.targetId]);
  res.json({ success: true });
});

const reportUser = asyncHandler(async (req, res) => {
  await query('INSERT INTO public.reported_content (reporter_id, target_id, reason, report_type) VALUES ($1, $2, $3, \'user\')', [req.userId, req.body.targetId, req.body.reason]);
  res.json({ success: true });
});

const addContact = asyncHandler(async (req, res) => {
  await query('INSERT INTO public.contacts (user_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.userId, req.body.contactId]);
  res.json({ success: true });
});

const checkContact = asyncHandler(async (req, res) => {
  const result = await query('SELECT 1 FROM public.contacts WHERE user_id = $1 AND contact_id = $2', [req.userId, req.params.peerId]);
  res.json({ success: true, isContact: result.rows.length > 0 });
});

module.exports = { getMe, updateProfile, searchUsers, syncContacts, updatePrivacy, updatePushToken, getBadges, submitVerification, getUserById, blockUser, reportUser, addContact, checkContact, deleteAccount };
