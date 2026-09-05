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

    // SÉCURITÉ CRITIQUE : Bloquer l'accès immédiatement si l'utilisateur est banni (L'Admin Global reste exempté pour pouvoir gérer le panel)
    if (user.is_locked && !user.is_global_admin) {
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
 * Middleware pour l'admin global ou délégué
 */
const isAdmin = async (req, res, next) => {
  if (req.user && req.user.is_global_admin) {
    req.user.is_delegated = false;
    req.user.allowed_modules = ['stats', 'users', 'groups', 'support', 'market-requests', 'verifications', 'audit', 'campaigns', 'legal', 'config', 'delegations', 'approvals', 'collaboration'];
    return next();
  }

  try {
    // Vérifier si l'utilisateur est délégué
    const delegation = await query('SELECT modules, is_active, collab_admin_rights, user_admin_rights FROM public.admin_delegations WHERE user_id = $1', [req.userId]);
    if (delegation.rows.length > 0) {
      if (!delegation.rows[0].is_active) {
        return res.status(403).json({
          success: false,
          error: 'Accès Admin révoqué',
          message: 'Vos privilèges d\'administration ont été retirés par l\'administrateur principal.'
        });
      }
      req.user.is_delegated = true;
      req.user.allowed_modules = delegation.rows[0].modules;
      req.user.collab_rights = delegation.rows[0].collab_admin_rights || {};
      req.user.user_rights = delegation.rows[0].user_admin_rights || {};
      return next();
    }
  } catch (err) {
    logger.error('Error checking admin delegation:', err);
  }

  res.status(403).json({ success: false, error: 'Accès réservé à l\'administrateur.' });
};

/**
 * Rate limiting pour auth
 */
const rateLimitAuth = (req, res, next) => {
  next();
};

/**
 * Middleware d'authentification minimale (Permet aux bannis de contester)
 */
const authenticateAllowLocked = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Token manquant.' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, config.jwt.secret);

    const result = await query(
      'SELECT id, email, is_global_admin, is_locked FROM public.profiles WHERE id = $1',
      [decoded.userId]
    );

    const user = result.rows[0];
    if (!user) return res.status(401).json({ success: false, error: 'Utilisateur non trouvé.' });

    req.user = user;
    req.userId = user.id;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Session invalide.' });
  }
};

module.exports = { authenticate, authenticateAllowLocked, isAdmin, rateLimitAuth, checkChatParticipation };
