const { query } = require('../config/db');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/error.middleware');

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

  const result = await query(
    `INSERT INTO public.status_reactions (status_id, user_id, content, type)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [statusId, userId, content, type]
  );

  res.status(201).json({
    success: true,
    data: result.rows[0],
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
