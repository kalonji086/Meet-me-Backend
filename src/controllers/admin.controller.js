const { query } = require('../config/db');
const { asyncHandler } = require('../middleware/error.middleware');
const socketService = require('../services/socket.service');

/**
 * @desc    Obtenir les statistiques globales
 */
const getStats = asyncHandler(async (req, res) => {
  const usersCount = await query('SELECT COUNT(*) FROM public.profiles WHERE is_global_admin = FALSE');
  const messagesCount = await query('SELECT COUNT(*) FROM public.messages');
  const chatsCount = await query('SELECT COUNT(*) FROM public.chats');
  const groupsCount = await query("SELECT COUNT(*) FROM public.chats WHERE type = 'group'");

  // Statistiques des 7 derniers jours (Inscriptions)
  const growth = await query(`
    SELECT DATE_TRUNC('day', created_at) as date, COUNT(*) as count
    FROM public.profiles
    WHERE created_at > NOW() - INTERVAL '7 days' AND is_global_admin = FALSE
    GROUP BY 1 ORDER BY 1 ASC
  `);

  // Activité par utilisateur (Top 10 par nombre de messages)
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
 * @desc    Lister tous les utilisateurs réels (exclut les admins)
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
 * @desc    Supprimer un utilisateur définitivement
 */
const deleteUser = asyncHandler(async (req, res) => {
  const { userId } = req.params;

  // Sécurité: Empêcher de se supprimer soi-même ou un autre admin global
  const target = await query('SELECT is_global_admin FROM public.profiles WHERE id = $1', [userId]);
  if (target.rows[0]?.is_global_admin) {
    return res.status(403).json({ success: false, error: 'Impossible de supprimer un administrateur global' });
  }

  await query('DELETE FROM public.profiles WHERE id = $1', [userId]);

  res.json({ success: true, message: 'Utilisateur supprimé avec succès' });
});

/**
 * @desc    Bloquer/Débloquer un utilisateur
 */
const toggleUserLock = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { isLocked } = req.body;

  await query(
    'UPDATE public.profiles SET is_locked = $1, login_attempts = $2 WHERE id = $3',
    [isLocked, isLocked ? 3 : 0, userId]
  );

  res.json({ success: true, message: `Utilisateur ${isLocked ? 'bloqué' : 'débloqué'}` });
});

/**
 * @desc    Lister tous les groupes
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
 * @desc    Voir les membres d'un groupe
 */
const getGroupMembers = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  const result = await query(`
    SELECT p.full_name, p.username, p.email, p.avatar_url, cp.role, cp.joined_at
    FROM public.chat_participants cp
    JOIN public.profiles p ON cp.user_id = p.id
    WHERE cp.chat_id = $1
    ORDER BY cp.role ASC, p.full_name ASC
  `, [chatId]);

  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Envoyer un message à tous les utilisateurs (Broadcast)
 */
const broadcastMessage = asyncHandler(async (req, res) => {
  const { content, title } = req.body;

  if (!content) return res.status(400).json({ success: false, error: 'Message vide' });

  socketService.broadcast('push_notification', {
    title: title || 'Message de l\'équipe Meet Me',
    body: content,
    type: 'system'
  });

  res.json({ success: true, message: 'Message diffusé à tous les utilisateurs' });
});

module.exports = {
  getStats,
  getUsers,
  deleteUser,
  toggleUserLock,
  getGroups,
  getGroupMembers,
  broadcastMessage
};
