const { query } = require('../config/db');
const { asyncHandler } = require('../middleware/error.middleware');
const socketService = require('../services/socket.service');

const bcrypt = require('bcryptjs');

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

/**
 * @desc    Demande de suppression de compte (Google Play Requirements)
 * @route   POST /api/users/request-deletion
 */
const requestDeletion = asyncHandler(async (req, res) => {
  const { email, password, reason } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Email et mot de passe requis.' });
  }

  // 1. Vérifier les identifiants
  const userRes = await query('SELECT id, password FROM public.profiles WHERE email = $1', [email.toLowerCase()]);
  const user = userRes.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ success: false, error: 'Identifiants incorrects.' });
  }

  // 2. Créer une entrée spéciale dans Support (Appeals)
  const fullReason = `⚠️ DEMANDE DE SUPPRESSION DÉFINITIVE (Google Play)\nRaison: ${reason || 'Non précisée'}`;

  await query(
    'INSERT INTO public.appeals (user_id, reason, status) VALUES ($1, $2, \'pending\')',
    [user.id, fullReason]
  );

  // 3. Bloquer le compte immédiatement pour sécurité
  await query('UPDATE public.profiles SET is_locked = TRUE WHERE id = $1', [user.id]);

  // Informer l'admin
  socketService.broadcast('admin_new_appeal', { userId: user.id });

  res.json({ success: true, message: 'Demande enregistrée.' });
});

module.exports = { submitAppeal, requestDeletion };
