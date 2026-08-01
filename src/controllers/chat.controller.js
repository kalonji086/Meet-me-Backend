const { query } = require('../config/db');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/error.middleware');

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
  const { participants, type = 'private', name } = req.body;

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
    `INSERT INTO public.chats (name, type, created_by)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [name || null, type, userId]
  );

  const chatId = chatResult.rows[0].id;

  // Ajouter les participants
  const allParticipants = [userId, ...participants];
  for (const pId of allParticipants) {
    await query(
      'INSERT INTO public.chat_participants (chat_id, user_id) VALUES ($1, $2)',
      [chatId, pId]
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

  // Note: En temps réel, on utiliserait Socket.IO ici pour notifier les participants
  // via socketService.io.to(chatId).emit('new_message', message);

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

module.exports = {
  getChats,
  createChat,
  getMessages,
  sendMessage,
  toggleArchive,
  deleteChat,
  markAsRead,
  deleteMessage,
};
