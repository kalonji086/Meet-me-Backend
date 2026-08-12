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
  const userId = req.userId;

  if (!reason) {
    return res.status(400).json({ success: false, error: 'Veuillez expliquer votre contestation.' });
  }

  const result = await query(
    'INSERT INTO public.appeals (user_id, reason, type) VALUES ($1, $2, \'appeal\') RETURNING id',
    [userId, reason]
  );

  socketService.broadcast('admin_new_appeal', { appealId: result.rows[0].id, userId, type: 'appeal', reason });
  res.json({ success: true, message: 'Votre demande a été envoyée.' });
});

/**
 * @desc    Soumettre une demande au Helpdesk (Public ou Privé)
 * @route   POST /api/support/helpdesk
 */
const submitHelpdesk = asyncHandler(async (req, res) => {
  const { category, reason, email } = req.body;
  const userId = req.userId || null; // Optionnel si authentifié

  if (!reason || !category) {
    return res.status(400).json({ success: false, error: 'Catégorie et message requis.' });
  }

  // Si non connecté, l'email est obligatoire
  if (!userId && !email) {
    return res.status(400).json({ success: false, error: 'Veuillez fournir un email pour que nous puissions vous répondre.' });
  }

  const result = await query(
    'INSERT INTO public.appeals (user_id, contact_email, category, reason, type) VALUES ($1, $2, $3, $4, \'helpdesk\') RETURNING id',
    [userId, email || null, category, reason]
  );

  socketService.broadcast('admin_new_appeal', { appealId: result.rows[0].id, type: 'helpdesk', reason, category });

  res.json({ success: true, message: 'Votre demande a été transmise au support technique.' });
});

/**
 * @desc    Demande de suppression de compte
 */
const requestDeletion = asyncHandler(async (req, res) => {
  const { email, password, reason } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Email et mot de passe requis.' });
  }

  const userRes = await query('SELECT id, password FROM public.profiles WHERE email = $1', [email.toLowerCase()]);
  const user = userRes.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ success: false, error: 'Identifiants incorrects.' });
  }

  const fullReason = `⚠️ DEMANDE DE SUPPRESSION DÉFINITIVE\nRaison: ${reason || 'Non précisée'}`;

  await query(
    'INSERT INTO public.appeals (user_id, reason, type) VALUES ($1, $2, \'deletion\')',
    [user.id, fullReason]
  );

  await query('UPDATE public.profiles SET is_locked = TRUE WHERE id = $1', [user.id]);
  socketService.broadcast('admin_new_appeal', { userId: user.id, type: 'deletion', reason: fullReason });

  res.json({ success: true, message: 'Demande enregistrée.' });
});

module.exports = { submitAppeal, submitHelpdesk, requestDeletion };
