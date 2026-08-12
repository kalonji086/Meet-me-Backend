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

  // SÉCURITÉ RENFORCÉE : Une seule demande PENDING de n'importe quel type par utilisateur
  const existing = await query(
    'SELECT id FROM public.appeals WHERE user_id = $1 AND status = \'pending\'',
    [userId]
  );

  if (existing.rows.length > 0) {
    return res.status(403).json({
      success: false,
      error: 'Violation des droits : Tentative de soumissions multiples',
      message: 'ACCÈS REFUSÉ. Vous avez déjà une demande en attente de traitement par nos services. Toute tentative de multiplier les requêtes est considérée comme une attaque par déni de service (Spam). Votre compte est sous surveillance et sera DÉFINITIVEMENT BANNI pour violation grave de nos conditions d\'utilisation si vous réitérez cette action.'
    });
  }

  const result = await query(
    'INSERT INTO public.appeals (user_id, reason, type) VALUES ($1, $2, \'appeal\') RETURNING id',
    [userId, reason]
  );

  socketService.broadcast('admin_new_appeal', { appealId: result.rows[0].id, userId, type: 'appeal', reason });
  res.json({ success: true, message: 'Votre contestation a été envoyée.' });
});

/**
 * @desc    Soumettre une demande au Helpdesk (Public ou Privé)
 * @route   POST /api/support/helpdesk
 */
const submitHelpdesk = asyncHandler(async (req, res) => {
  const { category, reason, email } = req.body;
  const userId = req.userId || null;

  if (!reason || !category) {
    return res.status(400).json({ success: false, error: 'Catégorie et message requis.' });
  }

  if (!userId && !email) {
    return res.status(400).json({ success: false, error: 'Veuillez fournir un email pour que nous puissions vous répondre.' });
  }

  // SÉCURITÉ RENFORCÉE : Limiter par email ou par ID utilisateur
  let checkSql = 'SELECT id FROM public.appeals WHERE status = \'pending\' AND ';
  const checkParams = [];
  if (userId) {
    checkSql += 'user_id = $1';
    checkParams.push(userId);
  } else {
    checkSql += 'contact_email = $1';
    checkParams.push(email.toLowerCase());
  }

  const existing = await query(checkSql, checkParams);
  if (existing.rows.length > 0) {
    return res.status(403).json({
      success: false,
      error: 'Système saturé : Requête dupliquée',
      message: 'AVERTISSEMENT SÉCURITÉ. Notre système détecte déjà une demande d\'aide active associée à vos identifiants. Il est strictement interdit d\'inonder le support avec des demandes répétitives. En cas de nouvelle tentative, votre accès sera révoqué et votre compte bloqué pour non-respect du protocole de sécurité et violation des droits d\'utilisation.'
    });
  }

  const result = await query(
    'INSERT INTO public.appeals (user_id, contact_email, category, reason, type) VALUES ($1, $2, $3, $4, \'helpdesk\') RETURNING id',
    [userId, email || null, category, reason]
  );

  socketService.broadcast('admin_new_appeal', { appealId: result.rows[0].id, type: 'helpdesk', reason, category });

  res.json({ success: true, message: 'Votre demande a été transmise avec succès.' });
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
    return res.status(401).json({ success: false, error: 'Identifiants de sécurité incorrects.' });
  }

  // Vérifier si une demande de suppression est déjà en cours
  const existing = await query('SELECT id FROM public.appeals WHERE user_id = $1 AND type = \'deletion\' AND status = \'pending\'', [user.id]);
  if (existing.rows.length > 0) {
    return res.status(400).json({ success: false, error: 'Une demande de suppression est déjà en attente pour ce compte.' });
  }

  const fullReason = `⚠️ DEMANDE DE SUPPRESSION DÉFINITIVE\nRaison: ${reason || 'Non précisée'}`;

  await query(
    'INSERT INTO public.appeals (user_id, reason, type) VALUES ($1, $2, \'deletion\')',
    [user.id, fullReason]
  );

  await query('UPDATE public.profiles SET is_locked = TRUE WHERE id = $1', [user.id]);
  socketService.broadcast('admin_new_appeal', { userId: user.id, type: 'deletion', reason: fullReason });

  res.json({ success: true, message: 'Votre demande de suppression a été enregistrée. Votre compte est désormais verrouillé.' });
});

module.exports = { submitAppeal, submitHelpdesk, requestDeletion };
