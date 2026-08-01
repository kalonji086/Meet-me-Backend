const { query } = require('../config/db');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/error.middleware');
const notificationService = require('../services/notification.service');

/**
 * @desc    Obtenir la liste des conversations
 * @route   GET /api/chats
 * @access  Private
 */
const getChats = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  // On récupère les conversations où l'utilisateur participe
  // Si c'est un auto-chat (un seul participant), on récupère ses propres infos
  const result = await query(
    `SELECT
        c.*,
        COALESCE(
          (
            SELECT json_build_object(
              'id', p.id,
              'full_name', p.full_name,
              'avatar_url', p.avatar_url,
              'status', p.status
            )
            FROM public.chat_participants cp2
            JOIN public.profiles p ON cp2.user_id = p.id
            WHERE cp2.chat_id = c.id AND cp2.user_id != $1
            LIMIT 1
          ),
          (
            SELECT json_build_object(
              'id', p.id,
              'full_name', p.full_name,
              'avatar_url', p.avatar_url,
              'status', p.status
            )
            FROM public.profiles p
            WHERE p.id = $1
          )
        ) as other_user
     FROM public.chats c
     JOIN public.chat_participants cp ON c.id = cp.chat_id
     WHERE cp.user_id = $1 AND cp.is_archived = $4
     ORDER BY c.last_message_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset, req.query.archived === 'true']
  );

  res.json({
    success: true,
    data: result.rows,
  });
});

/**
 * @desc    Créer ou récupérer une conversation privée
 * @route   POST /api/chats
 * @access  Private
 */
const createChat = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { participants, type = 'private', name, description, avatarUrl } = req.body;

  if (!participants || !Array.isArray(participants) || participants.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Veuillez fournir au moins un participant',
    });
  }

  // Pour un chat privé, on vérifie si une conversation existe déjà entre les deux
  if (type === 'private' && participants.length === 1) {
    const otherUserId = participants[0];

    const existingChat = await query(
      `SELECT c.id
       FROM public.chats c
       JOIN public.chat_participants cp1 ON c.id = cp1.chat_id
       JOIN public.chat_participants cp2 ON c.id = cp2.chat_id
       WHERE c.type = 'private'
         AND cp1.user_id = $1
         AND cp2.user_id = $2`,
      [userId, otherUserId]
    );

    if (existingChat.rows.length > 0) {
      return res.json({
        success: true,
        data: { id: existingChat.rows[0].id },
        message: 'Conversation existante récupérée',
      });
    }
  }

  // Créer la nouvelle conversation
  const chatResult = await query(
    `INSERT INTO public.chats (name, description, type, avatar_url, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [name || null, description || null, type, avatarUrl || null, userId]
  );

  const chatId = chatResult.rows[0].id;

  // Ajouter les participants
  const allParticipants = [...new Set([userId, ...participants])];
  for (const pId of allParticipants) {
    const role = pId === userId ? 'admin' : 'member';
    await query(
      'INSERT INTO public.chat_participants (chat_id, user_id, role) VALUES ($1, $2, $3)',
      [chatId, pId, role]
    );
  }

  // Si c'est un groupe, envoyer une notification système
  if (type === 'group') {
    await query(
      `INSERT INTO public.messages (chat_id, sender_id, content, type)
       VALUES ($1, $2, $3, 'text')`,
      [chatId, userId, `📢 ${name} a été créé`]
    );
  }

  res.status(201).json({
    success: true,
    data: { id: chatId },
    message: 'Conversation créée avec succès',
  });
});

/**
 * @desc    Obtenir les messages d'une conversation
 * @route   GET /api/messages/:chatId
 * @access  Private
 */
const getMessages = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const { page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  const result = await query(
    `SELECT m.*, p.full_name as sender_name, p.avatar_url as sender_avatar
     FROM public.messages m
     JOIN public.profiles p ON m.sender_id = p.id
     WHERE m.chat_id = $1
     ORDER BY m.created_at DESC
     LIMIT $2 OFFSET $3`,
    [chatId, limit, offset]
  );

  res.json({
    success: true,
    data: result.rows.reverse(), // On inverse pour avoir l'ordre chronologique dans l'UI
  });
});

/**
 * @desc    Envoyer un message
 * @route   POST /api/messages
 * @access  Private
 */
const sendMessage = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { chat: chatId, content, type = 'text', fileUrl } = req.body;

  if (!chatId || !content) {
    return res.status(400).json({
      success: false,
      error: 'ID de conversation et contenu requis',
    });
  }

  const result = await query(
    `INSERT INTO public.messages (chat_id, sender_id, content, type, file_url)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [chatId, userId, content, type, fileUrl]
  );

  const message = result.rows[0];

  // Envoyer une notification push aux autres participants
  const participantsResult = await query(
    `SELECT p.push_token, p.full_name as sender_name
     FROM public.chat_participants cp
     JOIN public.profiles p ON cp.user_id = p.id
     WHERE cp.chat_id = $1 AND cp.user_id != $2`,
    [chatId, userId]
  );

  const senderResult = await query('SELECT full_name FROM public.profiles WHERE id = $1', [userId]);
  const senderName = senderResult.rows[0]?.full_name || 'Nouveau message';

  for (const row of participantsResult.rows) {
    if (row.push_token) {
      // Compter les messages non lus pour ce destinataire spécifique
      const unreadResult = await query(
        "SELECT COUNT(*) as count FROM public.messages WHERE chat_id IN (SELECT chat_id FROM public.chat_participants WHERE user_id = (SELECT id FROM public.profiles WHERE push_token = $1)) AND status != 'read' AND sender_id != (SELECT id FROM public.profiles WHERE push_token = $1)",
        [row.push_token]
      );
      const badgeCount = parseInt(unreadResult.rows[0].count);

      notificationService.sendNotification(row.push_token, {
        title: senderName,
        body: type === 'text' ? content : `📷 Image`,
        data: { chatId, type: 'new_message' },
        badge: badgeCount
      });
    }
  }

  res.status(201).json({
    success: true,
    data: message,
  });
});

/**
 * @desc    Marquer les messages d'une conversation comme lus
 * @route   PUT /api/messages/:chatId/read
 */
const markAsRead = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const userId = req.userId;

  // Vérifier si l'utilisateur a désactivé les confirmations de lecture
  const userResult = await query(
    'SELECT privacy_settings FROM public.profiles WHERE id = $1',
    [userId]
  );

  const settings = userResult.rows[0]?.privacy_settings || {};

  if (settings.read_receipts === false) {
    return res.json({ success: true, message: 'Lecture non marquée (confidentialité active)' });
  }

  await query(
    `UPDATE public.messages
     SET status = 'read'
     WHERE chat_id = $1 AND sender_id != $2 AND status != 'read'`,
    [chatId, userId]
  );

  res.json({ success: true, message: 'Messages marqués comme lus' });
});

/**
 * @desc    Archiver/Désarchiver une discussion
 * @route   PUT /api/chats/:chatId/archive
 */
const toggleArchive = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const userId = req.userId;
  const { archive = true } = req.body;

  await query(
    'UPDATE public.chat_participants SET is_archived = $1 WHERE chat_id = $2 AND user_id = $3',
    [archive, chatId, userId]
  );

  res.json({ success: true, message: archive ? 'Discussion archivée' : 'Discussion désarchivée' });
});

/**
 * @desc    Supprimer une discussion définitivement
 * @route   DELETE /api/chats/:chatId
 */
const deleteChat = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const userId = req.userId;

  // Supprimer l'utilisateur de la conversation
  await query(
    'DELETE FROM public.chat_participants WHERE chat_id = $1 AND user_id = $2',
    [chatId, userId]
  );

  // Si plus personne n'est dans la conversation, on peut supprimer les messages et le chat (optionnel)
  const remaining = await query('SELECT 1 FROM public.chat_participants WHERE chat_id = $1', [chatId]);
  if (remaining.rows.length === 0) {
    await query('DELETE FROM public.chats WHERE id = $1', [chatId]);
  }

  res.json({ success: true, message: 'Discussion supprimée définitivement' });
});

/**
 * @desc    Supprimer un message (Le marquer comme retiré)
 * @route   DELETE /api/messages/:messageId
 */
const deleteMessage = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const userId = req.userId;

  // Récupérer le message et les infos de l'expéditeur
  const messageResult = await query(
    `SELECT m.*, p.full_name as sender_name
     FROM public.messages m
     JOIN public.profiles p ON m.sender_id = p.id
     WHERE m.id = $1`,
    [messageId]
  );

  if (messageResult.rows.length === 0) {
    return res.status(404).json({ success: false, error: 'Message non trouvé' });
  }

  const message = messageResult.rows[0];

  if (message.sender_id !== userId) {
    return res.status(403).json({ success: false, error: 'Non autorisé à supprimer ce message' });
  }

  // Au lieu de supprimer, on met à jour le contenu
  const updatedMessage = await query(
    `UPDATE public.messages
     SET content = $1, type = 'text', file_url = NULL, status = 'read'
     WHERE id = $2
     RETURNING *`,
    [`🚫 Ce message a été supprimé par ${message.sender_name}`, messageId]
  );

  res.json({
    success: true,
    message: 'Message retiré',
    data: updatedMessage.rows[0]
  });
});

/**
 * @desc    Obtenir les détails d'un groupe
 * @route   GET /api/chats/:chatId
 */
const getChatDetails = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const userId = req.userId;

  // Récupérer les infos du chat
  const chatResult = await query(
    `SELECT c.*, cp.role as my_role
     FROM public.chats c
     JOIN public.chat_participants cp ON c.id = cp.chat_id
     WHERE c.id = $1 AND cp.user_id = $2`,
    [chatId, userId]
  );

  if (chatResult.rows.length === 0) {
    return res.status(404).json({ success: false, error: 'Discussion non trouvée' });
  }

  // Récupérer les participants
  const participantsResult = await query(
    `SELECT p.id, p.full_name, p.avatar_url, p.status, cp.role, cp.joined_at
     FROM public.chat_participants cp
     JOIN public.profiles p ON cp.user_id = p.id
     WHERE cp.chat_id = $1
     ORDER BY cp.role ASC, p.full_name ASC`,
    [chatId]
  );

  res.json({
    success: true,
    data: {
      ...chatResult.rows[0],
      participants: participantsResult.rows
    }
  });
});

/**
 * @desc    Mettre à jour les infos d'un groupe
 * @route   PUT /api/chats/:chatId
 */
const updateChat = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const userId = req.userId;
  const { name, description, avatarUrl } = req.body;

  // Vérifier si l'utilisateur est admin
  const adminCheck = await query(
    "SELECT role FROM public.chat_participants WHERE chat_id = $1 AND user_id = $2",
    [chatId, userId]
  );

  if (adminCheck.rows.length === 0 || adminCheck.rows[0].role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Seuls les admins peuvent modifier le groupe' });
  }

  const result = await query(
    `UPDATE public.chats
     SET name = COALESCE($1, name),
         description = COALESCE($2, description),
         avatar_url = COALESCE($3, avatar_url)
     WHERE id = $4
     RETURNING *`,
    [name, description, avatarUrl, chatId]
  );

  res.json({
    success: true,
    data: result.rows[0],
    message: 'Groupe mis à jour'
  });
});

/**
 * @desc    Ajouter des membres au groupe
 * @route   POST /api/chats/:chatId/members
 */
const addMembers = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const userId = req.userId;
  const { userIds } = req.body;

  // Vérifier admin
  const adminCheck = await query(
    "SELECT role FROM public.chat_participants WHERE chat_id = $1 AND user_id = $2",
    [chatId, userId]
  );

  if (adminCheck.rows.length === 0 || adminCheck.rows[0].role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Seuls les admins peuvent ajouter des membres' });
  }

  for (const targetId of userIds) {
    await query(
      "INSERT INTO public.chat_participants (chat_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING",
      [chatId, targetId]
    );
  }

  res.json({ success: true, message: 'Membres ajoutés' });
});

/**
 * @desc    Retirer un membre ou quitter le groupe
 * @route   DELETE /api/chats/:chatId/members/:targetUserId
 */
const removeMember = asyncHandler(async (req, res) => {
  const { chatId, targetUserId } = req.params;
  const userId = req.userId;

  // Si l'utilisateur se retire lui-même (Quitter le groupe)
  if (userId === targetUserId) {
    await query("DELETE FROM public.chat_participants WHERE chat_id = $1 AND user_id = $2", [chatId, userId]);
    return res.json({ success: true, message: 'Vous avez quitté le groupe' });
  }

  // Sinon, vérifier si l'utilisateur actuel est admin
  const adminCheck = await query(
    "SELECT role FROM public.chat_participants WHERE chat_id = $1 AND user_id = $2",
    [chatId, userId]
  );

  if (adminCheck.rows.length === 0 || adminCheck.rows[0].role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Seuls les admins peuvent retirer des membres' });
  }

  await query("DELETE FROM public.chat_participants WHERE chat_id = $1 AND user_id = $2", [chatId, targetUserId]);

  res.json({ success: true, message: 'Membre retiré' });
});

/**
 * @desc    Changer le rôle d'un membre (Nommer admin)
 * @route   PUT /api/chats/:chatId/members/:targetUserId/role
 */
const changeMemberRole = asyncHandler(async (req, res) => {
  const { chatId, targetUserId } = req.params;
  const userId = req.userId;
  const { role } = req.body;

  // Vérifier admin
  const adminCheck = await query(
    "SELECT role FROM public.chat_participants WHERE chat_id = $1 AND user_id = $2",
    [chatId, userId]
  );

  if (adminCheck.rows.length === 0 || adminCheck.rows[0].role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Seuls les admins peuvent changer les rôles' });
  }

  await query(
    "UPDATE public.chat_participants SET role = $1 WHERE chat_id = $2 AND user_id = $3",
    [role, chatId, targetUserId]
  );

  res.json({ success: true, message: 'Rôle mis à jour' });
});

module.exports = {
  getChats,
  createChat,
  getMessages,
  sendMessage,
  toggleArchive,
  deleteChat,
  markAsRead,
  deleteMessage,
  getChatDetails,
  updateChat,
  addMembers,
  removeMember,
  changeMemberRole,
};
