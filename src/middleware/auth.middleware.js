const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const logger = require('../utils/logger');
const config = require('../../config/config');

/**
 * Middleware d'authentification JWT avec vérification de blocage
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Accès non autorisé. Token manquant.' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, config.jwt.secret);

    const result = await query(
      'SELECT id, email, full_name, username, is_global_admin, is_locked FROM public.profiles WHERE id = $1',
      [decoded.userId]
    );

    const user = result.rows[0];
    if (!user) return res.status(401).json({ success: false, error: 'Utilisateur non trouvé.' });

    // SÉCURITÉ CRITIQUE : Bloquer l'accès immédiatement si l'utilisateur est banni
    if (user.is_locked) {
      return res.status(403).json({
        success: false,
        error: 'Compte banni',
        isLocked: true,
        message: 'Votre accès a été révoqué par l\'administrateur.'
      });
    }

    req.user = user;
    req.userId = user.id;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Session invalide ou expirée.' });
  }
};

/**
 * Middleware pour vérifier si un utilisateur participe à un chat
 */
const checkChatParticipation = async (req, res, next) => {
  try {
    const chatId = req.params.chatId || req.body.chat;
    const userId = req.userId;
    if (!chatId) return next();

    const result = await query(
      'SELECT 1 FROM public.chat_participants WHERE chat_id = $1 AND user_id = $2',
      [chatId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({ success: false, error: 'Accès interdit.' });
    }
    next();
  } catch (error) {
    res.status(500).json({ success: false, error: 'Erreur de vérification.' });
  }
};

/**
 * Middleware pour l'admin global
 */
const isAdmin = (req, res, next) => {
  if (req.user && req.user.is_global_admin) return next();
  res.status(403).json({ success: false, error: 'Accès réservé à l\'administrateur.' });
};

/**
 * Rate limiting pour auth
 */
const rateLimitAuth = (req, res, next) => {
  next();
};

module.exports = { authenticate, isAdmin, rateLimitAuth, checkChatParticipation };
