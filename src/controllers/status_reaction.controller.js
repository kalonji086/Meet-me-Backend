const { query } = require('../config/db');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/error.middleware');
const socketService = require('../services/socket.service');

/**
 * @desc    Ajouter une réaction ou un commentaire à un status
 * @route   POST /api/statuses/:statusId/reactions
 * @access  Private
 */
const addReaction = asyncHandler(async (req, res) => {
  const { statusId } = req.params;
  const userId = req.userId;
  const { content, type } = req.body;

  if (!content || !type) {
    return res.status(400).json({
      success: false,
      error: 'Contenu et type requis',
    });
  }

  // 1. Insérer la réaction
  const result = await query(
    `INSERT INTO public.status_reactions (status_id, user_id, content, type)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [statusId, userId, content, type]
  );

  const reaction = result.rows[0];

  // 2. Récupérer les infos de l'expéditeur et du propriétaire du status
  const userInfo = await query('SELECT full_name, avatar_url FROM public.profiles WHERE id = $1', [userId]);
  const statusOwner = await query('SELECT user_id FROM public.statuses WHERE id = $1', [statusId]);

  if (userInfo.rows.length > 0 && statusOwner.rows.length > 0) {
    const sender = userInfo.rows[0];
    const ownerId = statusOwner.rows[0].user_id;

    // 3. Notifier le propriétaire en temps réel
    socketService.sendToUser(ownerId, 'status:reacted', {
      statusId,
      reaction: {
        ...reaction,
        full_name: sender.full_name,
        avatar_url: sender.avatar_url
      }
    });
  }

  res.status(201).json({
    success: true,
    data: reaction,
  });
});

/**
 * @desc    Obtenir les réactions pour un status
 * @route   GET /api/statuses/:statusId/reactions
 * @access  Private
 */
const getReactions = asyncHandler(async (req, res) => {
  const { statusId } = req.params;

  const result = await query(
    `SELECT sr.*, p.full_name, p.avatar_url
     FROM public.status_reactions sr
     JOIN public.profiles p ON sr.user_id = p.id
     WHERE sr.status_id = $1
     ORDER BY sr.created_at DESC`,
    [statusId]
  );

  res.json({
    success: true,
    data: result.rows,
  });
});

module.exports = {
  addReaction,
  getReactions,
};
