const { query } = require('../config/db');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/error.middleware');

/**
 * @desc    Créer un nouveau status
 * @route   POST /api/statuses
 * @access  Private
 */
const createStatus = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { content, type = 'text', mediaUrl, backgroundColor } = req.body;

  const result = await query(
    `INSERT INTO public.statuses (user_id, content, type, media_url, background_color)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, content, type, mediaUrl, backgroundColor || '#128C7E']
  );

  res.status(201).json({
    success: true,
    data: result.rows[0],
    message: 'Status publié avec succès',
  });
});

/**
 * @desc    Obtenir les status récents des contacts
 * @route   GET /api/statuses
 * @access  Private
 */
const getStatuses = asyncHandler(async (req, res) => {
  const userId = req.userId;

  // On récupère les status non expirés des autres utilisateurs
  // Pour l'instant, on prend tous les utilisateurs (mode découverte)
  // Dans une version finale, on filtrerait par contacts
  const result = await query(
    `SELECT s.*, p.full_name, p.avatar_url
     FROM public.statuses s
     JOIN public.profiles p ON s.user_id = p.id
     WHERE s.expires_at > NOW()
     ORDER BY s.created_at DESC`,
    []
  );

  // Grouper les status par utilisateur (comme WhatsApp)
  const groupedStatuses = result.rows.reduce((acc, status) => {
    const userIndex = acc.findIndex(item => item.user_id === status.user_id);
    if (userIndex > -1) {
      acc[userIndex].statuses.push(status);
    } else {
      acc.push({
        user_id: status.user_id,
        full_name: status.full_name,
        avatar_url: status.avatar_url,
        statuses: [status]
      });
    }
    return acc;
  }, []);

  res.json({
    success: true,
    data: groupedStatuses,
  });
});

/**
 * @desc    Supprimer un status
 * @route   DELETE /api/statuses/:id
 * @access  Private
 */
const deleteStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.userId;

  const result = await query(
    'DELETE FROM public.statuses WHERE id = $1 AND user_id = $2 RETURNING *',
    [id, userId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({
      success: false,
      error: 'Status non trouvé ou non autorisé',
    });
  }

  res.json({
    success: true,
    message: 'Status supprimé',
  });
});

module.exports = {
  createStatus,
  getStatuses,
  deleteStatus,
};
