const { query } = require('../config/db');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { asyncHandler } = require('../middleware/error.middleware');
const notificationService = require('../services/notification.service');
const translationService = require('../services/translation.service');
const socketService = require('../services/socket.service');

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
  // On inclut le décompte des messages non lus (unread_count)
  const result = await query(
    `SELECT
        c.*,
        cp.is_favorite,
        cp.is_priority,
        CASE
          WHEN c.type = 'group' THEN NULL
          ELSE (
            SELECT json_build_object(
              'id', p.id,
              'full_name', p.full_name,
              'avatar_url', p.avatar_url,
              'status', p.status,
              'is_verified', p.is_verified
            )
            FROM public.chat_participants cp2
            JOIN public.profiles p ON cp2.user_id = p.id
            WHERE cp2.chat_id = c.id AND cp2.user_id != $1
            LIMIT 1
          )
        END as other_user,
        (
          SELECT COUNT(*)
          FROM public.messages m
          WHERE m.chat_id = c.id
            AND m.sender_id != $1
            AND m.status != 'read'
            AND (m.deleted_for_users IS NULL OR NOT ($1 = ANY(m.deleted_for_users)))
        ) as unread_count
     FROM public.chats c
     JOIN public.chat_participants cp ON c.id = cp.chat_id
     WHERE cp.user_id = $1 AND cp.is_archived = $4
     ORDER BY cp.is_priority DESC, c.last_message_at DESC
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
       WHERE c.type = 'private'
         AND (SELECT COUNT(*) FROM public.chat_participants WHERE chat_id = c.id) = $3
         AND EXISTS (SELECT 1 FROM public.chat_participants WHERE chat_id = c.id AND user_id = $1)
         AND EXISTS (SELECT 1 FROM public.chat_participants WHERE chat_id = c.id AND user_id = $2)`,
      [userId, otherUserId, userId === otherUserId ? 1 : 2]
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

  // Si c'est un groupe, envoyer une notification système et notifier l'admin en temps réel
  if (type === 'group') {
    await query(
      `INSERT INTO public.messages (chat_id, sender_id, content, type)
       VALUES ($1, $2, $3, 'text')`,
      [chatId, userId, `📢 ${name} a été créé`]
    );

    // Notifier le dashboard admin en temps réel
    socketService.broadcast('admin:new_group', {
      id: chatId,
      name,
      creatorId: userId,
      createdAt: new Date()
    });
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
  const userId = req.userId;
  const offset = (page - 1) * limit;

  const result = await query(
    `SELECT m.*, p.full_name as sender_name, p.avatar_url as sender_avatar, p.is_verified as sender_is_verified,
            med.file_name, med.file_size, med.mime_type, med.metadata as media_metadata
     FROM public.messages m
     JOIN public.profiles p ON m.sender_id = p.id
     LEFT JOIN public.media med ON m.id = med.message_id
     WHERE m.chat_id = $1
       AND (m.deleted_for_users IS NULL OR NOT ($2 = ANY(m.deleted_for_users)))
     ORDER BY m.created_at DESC
     LIMIT $3 OFFSET $4`,
    [chatId, userId, limit, offset]
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
  const { chat: chatId, content, type = 'text', file_url: fileUrl, fileSize, mimeType, ...metadata } = req.body;

  if (!chatId || !content) {
    return res.status(400).json({
      success: false,
      error: 'ID de conversation et contenu requis',
    });
  }

  const result = await query(
    `INSERT INTO public.messages (chat_id, sender_id, content, type, file_url, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [chatId, userId, content, type, fileUrl, JSON.stringify(req.body.metadata || metadata)]
  );

  const message = result.rows[0];

  // Si c'est un message avec un fichier, on l'ajoute à la table media
  if (fileUrl && type !== 'text') {
    try {
      await query(
        `INSERT INTO public.media (user_id, message_id, file_url, file_name, file_size, mime_type, type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, message.id, fileUrl, content, fileSize, mimeType, type]
      );
    } catch (mediaErr) {
      logger.error('Erreur insertion table media:', mediaErr);
    }
  }

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
      // Compter les messages non lus pour ce destinataire spécifique (Total Badge)
      const unreadResult = await query(
        `SELECT COUNT(*) as count FROM public.messages m
         JOIN public.chat_participants cp ON m.chat_id = cp.chat_id
         JOIN public.profiles p ON cp.user_id = p.id
         WHERE p.push_token = $1
           AND m.sender_id != p.id
           AND m.status != 'read'
           AND (m.deleted_for_users IS NULL OR NOT (p.id = ANY(m.deleted_for_users)))`,
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

  // Notifier le dashboard admin en temps réel pour les statistiques
  socketService.broadcast('admin:new_message', {
    id: message.id,
    type: message.type,
    time: new Date()
  });

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
 * @desc    Supprimer un message (Le marquer comme retiré ou le masquer)
 * @route   DELETE /api/messages/:messageId
 */
const deleteMessage = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const { deleteType = 'everyone' } = req.query; // 'everyone' or 'me'
  const userId = req.userId;

  // Récupérer le message
  const messageResult = await query(
    'SELECT * FROM public.messages WHERE id = $1',
    [messageId]
  );

  if (messageResult.rows.length === 0) {
    return res.status(404).json({ success: false, error: 'Message non trouvé' });
  }

  const message = messageResult.rows[0];

  if (deleteType === 'me') {
    // Supprimer uniquement pour l'utilisateur actuel
    const updatedMessage = await query(
      `UPDATE public.messages
       SET deleted_for_users = array_append(COALESCE(deleted_for_users, '{}'), $1)
       WHERE id = $2
       RETURNING *`,
      [userId, messageId]
    );

    return res.json({
      success: true,
      message: 'Message masqué pour vous',
      data: updatedMessage.rows[0]
    });
  }

  // Suppression pour tout le monde
  if (message.sender_id !== userId) {
    return res.status(403).json({ success: false, error: 'Non autorisé à supprimer ce message pour tous' });
  }

  // Au lieu de supprimer physiquement, on met à jour le contenu (Style WhatsApp)
  const deleteMention = "🚫 Ce message a été supprimé";
  const updatedMessage = await query(
    `UPDATE public.messages
     SET content = $1,
         type = 'text',
         file_url = NULL,
         status = 'read',
         translated_content = NULL,
         source_language = NULL
     WHERE id = $2
     RETURNING *`,
    [deleteMention, messageId]
  );

  // Mettre à jour le last_message du chat si c'était le dernier message
  const chatRes = await query(
    'SELECT id FROM public.chats WHERE id = $1 AND last_message_at = $2',
    [message.chat_id, message.created_at]
  );

  if (chatRes.rows.length > 0) {
    await query(
      'UPDATE public.chats SET last_message = $1 WHERE id = $2',
      [deleteMention, message.chat_id]
    );
  }

  res.json({
    success: true,
    message: 'Message retiré pour tout le monde',
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
    `SELECT p.id, p.full_name, p.avatar_url, p.status, p.is_verified, cp.role, cp.joined_at
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

  // Notifier en temps réel
  const socketService = require('../services/socket.service');
  socketService.sendToChat(chatId, 'member_removed', { chatId, userId: targetUserId });

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

  // Notifier en temps réel
  const socketService = require('../services/socket.service');
  socketService.sendToChat(chatId, 'member_role_changed', { chatId, userId: targetUserId, role });

  res.json({ success: true, message: 'Rôle mis à jour' });
});

/**
 * @desc    Traduire un message
 * @route   POST /api/messages/:messageId/translate
 */
const translateMessage = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const { targetLanguage } = req.body;

  if (!targetLanguage) {
    return res.status(400).json({ success: false, error: 'Langue cible requise' });
  }

  try {
    const translatedText = await translationService.translateMessage(messageId, targetLanguage);
    res.json({
      success: true,
      data: {
        translatedText
      }
    });
  } catch (error) {
    logger.error('Erreur de traduction:', error);
    res.status(500).json({ success: false, error: 'Échec de la traduction' });
  }
});

/**
 * @desc    Traduire un message vocal (Transcription + Traduction IA)
 * @route   POST /api/messages/:messageId/translate-voice
 */
const translateAudioMessage = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const { targetLanguage } = req.body;

  if (!targetLanguage) {
    return res.status(400).json({ success: false, error: 'Langue cible requise' });
  }

  try {
    // 1. Récupérer le message et son URL audio
    const result = await query(
      'SELECT m.*, media.file_url as audio_url FROM public.messages m LEFT JOIN public.media ON m.id = media.message_id WHERE m.id = $1',
      [messageId]
    );
    const message = result.rows[0];

    if (!message || message.type !== 'audio' || !message.audio_url) {
      return res.status(404).json({ success: false, error: 'Audio non trouvé pour ce message' });
    }

    // 2. Télécharger le fichier temporairement pour Whisper
    const tempFilePath = path.join(__dirname, '../../uploads', `temp_${messageId}.m4a`);
    const response = await axios({
      method: 'get',
      url: message.audio_url,
      responseType: 'stream'
    });

    const writer = fs.createWriteStream(tempFilePath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // 3. Transcription et Traduction avec l'IA
    const aiResult = await translationService.transcribeAndTranslateAudio(tempFilePath, targetLanguage);

    // 4. Nettoyer le fichier temp
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);

    // 5. Sauvegarder dans la base de données
    let translatedContent = {};
    try {
      translatedContent = typeof message.translated_content === 'string'
        ? JSON.parse(message.translated_content)
        : (message.translated_content || {});
    } catch (e) { translatedContent = {}; }

    translatedContent[targetLanguage] = aiResult.translatedText;
    translatedContent[`${targetLanguage}_transcription`] = aiResult.originalText;

    await query(
      'UPDATE public.messages SET translated_content = $1 WHERE id = $2',
      [JSON.stringify(translatedContent), messageId]
    );

    res.json({
      success: true,
      data: {
        transcription: aiResult.originalText,
        translatedText: aiResult.translatedText
      }
    });
  } catch (error) {
    logger.error('Erreur traduction audio IA:', error);
    res.status(500).json({ success: false, error: 'Échec de la transcription/traduction par l\'IA' });
  }
});

/**
 * @desc    Mettre en favoris/Retirer des favoris
 * @route   PUT /api/chats/:chatId/favorite
 */
const toggleFavorite = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const userId = req.userId;
  const { favorite = true } = req.body;

  await query(
    'UPDATE public.chat_participants SET is_favorite = $1 WHERE chat_id = $2 AND user_id = $3',
    [favorite, chatId, userId]
  );

  res.json({ success: true, message: favorite ? 'Ajouté aux favoris' : 'Retiré des favoris' });
});

/**
 * @desc    Mettre en priorité/Retirer priorité
 * @route   PUT /api/chats/:chatId/priority
 */
const togglePriority = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const userId = req.userId;
  const { priority = true } = req.body;

  await query(
    'UPDATE public.chat_participants SET is_priority = $1 WHERE chat_id = $2 AND user_id = $3',
    [priority, chatId, userId]
  );

  res.json({ success: true, message: priority ? 'Discussion épinglée' : 'Discussion détachée' });
});

/**
 * @desc    Liker/Réagir à un message
 * @route   PUT /api/messages/:messageId/react
 */
const reactToMessage = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const userId = req.userId;

  const result = await query(
    `UPDATE public.messages
     SET likes = CASE
       WHEN $1 = ANY(COALESCE(likes, '{}')) THEN array_remove(likes, $1)
       ELSE array_append(COALESCE(likes, '{}'), $1)
     END
     WHERE id = $2
     RETURNING likes, chat_id`,
    [userId, messageId]
  );

  if (result.rows.length > 0) {
    const { likes, chat_id } = result.rows[0];
    socketService.sendToChat(chat_id, 'message_reaction', { messageId, likes });
    res.json({ success: true, data: { likes } });
  } else {
    res.status(404).json({ success: false, error: 'Message non trouvé' });
  }
});

module.exports = {
  getChats,
  createChat,
  getMessages,
  sendMessage,
  toggleArchive,
  toggleFavorite,
  togglePriority,
  deleteChat,
  markAsRead,
  deleteMessage,
  getChatDetails,
  updateChat,
  addMembers,
  removeMember,
  changeMemberRole,
  translateMessage,
  translateAudioMessage,
  reactToMessage,
};
