const { query } = require('../config/db');
const { asyncHandler } = require('../middleware/error.middleware');
const socketService = require('../services/socket.service');
const mailService = require('../services/mail.service');

/**
 * @desc    Obtenir les statistiques globales
 */
const getStats = asyncHandler(async (req, res) => {
  const usersCount = await query('SELECT COUNT(*) FROM public.profiles WHERE is_global_admin = FALSE');
  const messagesCount = await query('SELECT COUNT(*) FROM public.messages');
  const chatsCount = await query('SELECT COUNT(*) FROM public.chats');
  const groupsCount = await query("SELECT COUNT(*) FROM public.chats WHERE type = 'group'");

  const growth = await query(`
    SELECT DATE_TRUNC('day', created_at) as date, COUNT(*) as count
    FROM public.profiles
    WHERE created_at > NOW() - INTERVAL '7 days' AND is_global_admin = FALSE
    GROUP BY 1 ORDER BY 1 ASC
  `);

  const userActivity = await query(`
    SELECT p.full_name as name, COUNT(m.id) as count
    FROM public.profiles p
    LEFT JOIN public.messages m ON p.id = m.sender_id
    WHERE p.is_global_admin = FALSE
    GROUP BY p.id, p.full_name
    ORDER BY count DESC
    LIMIT 10
  `);

  res.json({
    success: true,
    data: {
      totalUsers: parseInt(usersCount.rows[0].count),
      totalMessages: parseInt(messagesCount.rows[0].count),
      totalChats: parseInt(chatsCount.rows[0].count),
      totalGroups: parseInt(groupsCount.rows[0].count),
      growth: growth.rows,
      userActivity: userActivity.rows,
      onlineUsers: socketService.getConnectionStats().connectedUsers
    }
  });
});

/**
 * @desc    Lister tous les utilisateurs réels
 */
const getUsers = asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT id, email, full_name, username, avatar_url, status, phone_number, is_locked, login_attempts, created_at, is_global_admin, device_info, last_login_at
    FROM public.profiles
    WHERE is_global_admin = FALSE
    ORDER BY last_login_at DESC NULLS LAST
  `);

  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Supprimer un utilisateur
 */
const deleteUser = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const target = await query('SELECT is_global_admin FROM public.profiles WHERE id = $1', [userId]);
  if (target.rows[0]?.is_global_admin) return res.status(403).json({ success: false, error: 'Impossible de supprimer un admin' });
  await query('DELETE FROM public.profiles WHERE id = $1', [userId]);
  res.json({ success: true, message: 'Supprimé' });
});

/**
 * @desc    Bloquer/Débloquer
 */
const toggleUserLock = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { isLocked } = req.body;
  await query('UPDATE public.profiles SET is_locked = $1, login_attempts = $2 WHERE id = $3', [isLocked, isLocked ? 3 : 0, userId]);
  res.json({ success: true });
});

/**
 * @desc    Lister les groupes
 */
const getGroups = asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT c.*, p.full_name as creator_name,
    (SELECT COUNT(*) FROM public.chat_participants WHERE chat_id = c.id) as members_count
    FROM public.chats c
    LEFT JOIN public.profiles p ON c.created_by = p.id
    WHERE c.type = 'group'
    ORDER BY c.created_at DESC
  `);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Membres d'un groupe
 */
const getGroupMembers = asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT p.full_name, p.username, p.email, p.avatar_url, cp.role, cp.joined_at
    FROM public.chat_participants cp
    JOIN public.profiles p ON cp.user_id = p.id
    WHERE cp.chat_id = $1
    ORDER BY cp.role ASC, p.full_name ASC
  `, [req.params.chatId]);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Diffusion (Email + Push)
 */
const broadcastMessage = asyncHandler(async (req, res) => {
  const { content, title, target = 'all', specificEmail } = req.body;

  if (!content || !title) return res.status(400).json({ success: false, error: 'Titre et contenu requis' });

  if (target === 'all') {
    // 1. Envoyer Push à tous via Socket.IO
    socketService.broadcast('push_notification', { title, body: content, type: 'system' });

    // 2. Récupérer tous les emails des utilisateurs réels
    const users = await query('SELECT email FROM public.profiles WHERE is_global_admin = FALSE');

    // 3. Envoyer emails en série (ou parallèle limité pour Brevo)
    for (const user of users.rows) {
      await mailService.sendSystemEmail(user.email, title, content);
    }

    res.json({ success: true, message: `Diffusion envoyée à ${users.rows.length} utilisateurs.` });
  } else {
    // Cible spécifique
    if (!specificEmail) return res.status(400).json({ success: false, error: 'Email cible requis' });

    const userRes = await query('SELECT id FROM public.profiles WHERE email = $1', [specificEmail]);
    if (userRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Destinataire introuvable' });

    // Envoi Push si connecté
    socketService.sendToUser(userRes.rows[0].id, 'push_notification', { title, body: content, type: 'system' });

    // Envoi Email
    const sent = await mailService.sendSystemEmail(specificEmail, title, content);

    if (sent) res.json({ success: true, message: 'Message envoyé personnellement par email.' });
    else res.status(500).json({ success: false, error: 'Échec de l\'envoi de l\'email.' });
  }
});

module.exports = { getStats, getUsers, deleteUser, toggleUserLock, getGroups, getGroupMembers, broadcastMessage };
