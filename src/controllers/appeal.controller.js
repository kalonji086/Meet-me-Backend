const { query } = require('../config/db');
const { asyncHandler } = require('../middleware/error.middleware');
const socketService = require('../services/socket.service');

/**
 * @desc    Soumettre une réclamation (Appelé par l'utilisateur banni)
 * @route   POST /api/users/appeal
 */
const submitAppeal = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const userId = req.userId; // Récupéré par authenticate (même si banni)

  if (!reason) {
    return res.status(400).json({ success: false, error: 'Veuillez expliquer votre contestation.' });
  }

  // Vérifier si une demande est déjà en cours
  const existing = await query('SELECT id FROM public.appeals WHERE user_id = $1 AND status = \'pending\'', [userId]);
  if (existing.rows.length > 0) {
    return res.status(400).json({ success: false, error: 'Une demande de contestation est déjà en cours d\'examen.' });
  }

  const result = await query(
    'INSERT INTO public.appeals (user_id, reason) VALUES ($1, $2) RETURNING id',
    [userId, reason]
  );

  // Informer l'admin en temps réel
  socketService.broadcast('admin_new_appeal', {
    appealId: result.rows[0].id,
    userId
  });

  res.json({ success: true, message: 'Votre demande a été envoyée. L\'équipe Meet Me l\'examinera sous peu.' });
});

module.exports = { submitAppeal };
