const { query } = require('../config/db');
const { asyncHandler } = require('../middleware/error.middleware');
const socketService = require('../services/socket.service');

/**
 * @desc    Obtenir les statistiques globales
 */
const getStats = asyncHandler(async (req, res) => {
  const usersCount = await query('SELECT COUNT(*) FROM public.profiles');
  const messagesCount = await query('SELECT COUNT(*) FROM public.messages');
  const chatsCount = await query('SELECT COUNT(*) FROM public.chats');
  const groupsCount = await query("SELECT COUNT(*) FROM public.chats WHERE type = 'group'");

  // Statistiques des 7 derniers jours (Inscriptions)
  const growth = await query(`
    SELECT DATE_TRUNC('day', created_at) as date, COUNT(*) as count
    FROM public.profiles
    WHERE created_at > NOW() - INTERVAL '7 days'
    GROUP BY 1 ORDER BY 1 ASC
  `);

  res.json({
    success: true,
    data: {
      totalUsers: parseInt(usersCount.rows[0].count),
      totalMessages: parseInt(messagesCount.rows[0].count),
      totalChats: parseInt(chatsCount.rows[0].count),
      totalGroups: parseInt(groupsCount.rows[0].count),
      growth: growth.rows,
      onlineUsers: socketService.getConnectionStats().connectedUsers
    }
  });
});

/**
 * @desc    Lister tous les utilisateurs
 */
const getUsers = asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT id, email, full_name, username, avatar_url, status, phone_number, is_locked, login_attempts, created_at, is_global_admin
    FROM public.profiles
    ORDER BY created_at DESC
  `);

  res.json({ success: true, data: result.rows });
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
 * @desc    Envoyer un message à tous les utilisateurs (Broadcast)
 */
const broadcastMessage = asyncHandler(async (req, res) => {
  const { content, title } = req.body;

  if (!content) return res.status(400).json({ success: false, error: 'Message vide' });

  // Envoyer via Socket.IO à tous les connectés
  socketService.broadcast('push_notification', {
    title: title || 'Message de l\'équipe Meet Me',
    body: content,
    type: 'system'
  });

  res.json({ success: true, message: 'Message diffusé à tous les utilisateurs' });
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

module.exports = {
  getStats,
  getUsers,
  toggleUserLock,
  broadcastMessage,
  getGroups
};
