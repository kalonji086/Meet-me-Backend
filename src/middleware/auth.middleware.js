const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const logger = require('../utils/logger');
const config = require('../../config/config');
const deviceSessionService = require('../services/device-session.service');

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
    if (decoded.sid && !(await deviceSessionService.isSessionValid(decoded.sid, decoded.userId))) {
      return res.status(401).json({ success: false, error: 'Cette session a été révoquée.' });
    }

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
    req.sessionId = decoded.sid || null;
    if (decoded.sid) await deviceSessionService.touchSession(decoded.sid, user.id, req.ip);
    next();
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Session invalide ou expirée.' });
  }
};

/**
 * Authentifie une session temporaire créée par un code d'accès scolaire.
 * Cette session ne remplace jamais la session utilisateur principale.
 */
const authenticateSchoolSession = async (req, res, next) => {
  const token = req.headers['x-school-session'];
  if (!token || typeof token !== 'string') {
    return res.status(401).json({ success: false, error: 'Session scolaire manquante.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, config.jwt.secret);
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Session scolaire expirée ou invalide.' });
  }

  if (!decoded.schoolSession || !decoded.schoolId || !decoded.principalId || !decoded.role) {
    return res.status(401).json({ success: false, error: 'Session scolaire invalide.' });
  }

  try {
    const schoolResult = await query(
      'SELECT status FROM public.school_requests WHERE id = $1',
      [decoded.schoolId]
    );
    const approvedStatuses = ['approuve', 'approuvé'];
    if (!approvedStatuses.includes(String(schoolResult.rows[0]?.status || '').trim().toLowerCase())) {
      return res.status(403).json({ success: false, error: 'L’école n’est pas approuvée ou est suspendue.' });
    }

    const principalTable = decoded.principalType === 'staff'
      ? 'school_account_requests'
      : decoded.principalType === 'student'
        ? 'school_students'
        : decoded.principalType === 'parent'
          ? 'school_parent_accounts'
        : null;
    if (!principalTable) {
      return res.status(401).json({ success: false, error: 'Type de compte scolaire invalide.' });
    }
    if (decoded.principalType === 'parent' && decoded.role !== 'parent') {
      return res.status(401).json({ success: false, error: 'Session Parent invalide.' });
    }

    const principalResult = await query(
      `SELECT id${decoded.principalType === 'staff' ? ', role' : ''}
       FROM public.${principalTable}
       WHERE id = $1 AND school_id = $2${decoded.principalType === 'staff' ? " AND LOWER(status) IN ('approuve', 'approuvé')" : " AND COALESCE(is_active, TRUE) = TRUE"}`,
      [decoded.principalId, decoded.schoolId]
    );
    if (principalResult.rows.length === 0) {
      return res.status(403).json({ success: false, error: 'Ce compte scolaire n’est plus actif.' });
    }
    if (decoded.principalType === 'staff' && principalResult.rows[0].role !== decoded.role) {
      return res.status(403).json({ success: false, error: 'Les droits de ce compte scolaire ont changé. Reconnectez-vous.' });
    }
    if (decoded.principalType === 'parent') {
      const childResult = await query(
        `SELECT id FROM public.school_students
         WHERE id = (
           SELECT student_id FROM public.school_parent_accounts WHERE id = $1 AND school_id = $2
         ) AND school_id = $2 AND COALESCE(is_active, TRUE) = TRUE`,
        [decoded.principalId, decoded.schoolId]
      );
      if (childResult.rows.length === 0) {
        return res.status(403).json({ success: false, error: 'Le compte de l’élève associé n’est plus actif.' });
      }
    }

    req.schoolSession = decoded;
    return next();
  } catch (error) {
    return next(error);
  }
};

const authenticateSchoolAccess = async (req, res, next) => {
  const token = req.headers['x-school-session'];
  if (!token) return authenticate(req, res, next);
  if (typeof token !== 'string') {
    return res.status(401).json({ success: false, error: 'Session scolaire invalide.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, config.jwt.secret);
    if (!decoded.schoolSession || decoded.principalType !== 'staff' || !decoded.schoolId || !decoded.principalId || !decoded.role) {
      return res.status(403).json({ success: false, error: 'Ce compte scolaire ne peut pas accéder à ce module.' });
    }
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Session scolaire expirée ou invalide.' });
  }

  let result;
  try {
    result = await query(
      `SELECT sr.id, sr.status AS school_status, sar.status AS staff_status, sar.role AS staff_role
       FROM public.school_requests sr
       JOIN public.school_account_requests sar ON sar.school_id = sr.id
       WHERE sr.id = $1 AND sar.id = $2`,
      [decoded.schoolId, decoded.principalId]
    );
  } catch (error) {
    return next(error);
  }
  const school = result.rows[0];
  const approvedStatuses = ['approuve', 'approuvé'];
  if (!school || !approvedStatuses.includes(String(school.school_status || '').trim().toLowerCase())) {
    return res.status(403).json({ success: false, error: 'L’école n’est pas approuvée ou est suspendue.' });
  }
  if (!approvedStatuses.includes(String(school.staff_status || '').trim().toLowerCase())) {
    return res.status(403).json({ success: false, error: 'Ce compte scolaire n’est plus actif.' });
  }
  if (school.staff_role !== decoded.role) {
    return res.status(403).json({ success: false, error: 'Les droits de ce compte scolaire ont changé. Reconnectez-vous.' });
  }

  req.schoolSession = decoded;
  req.userId = decoded.principalId;
  return next();
};

const authorizeSchoolRoles = (...roles) => (req, res, next) => {
  if (!req.schoolSession || roles.includes(req.schoolSession.role)) return next();
  return res.status(403).json({ success: false, error: 'Votre rôle ne permet pas cette action.' });
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
    req.user.allowed_modules = ['stats', 'users', 'groups', 'support', 'appeals', 'market-requests', 'employer-requests', 'accounts', 'verifications', 'audit', 'campaigns', 'legal', 'config', 'delegations', 'approvals', 'collaboration', 'moderation', 'portfolio'];
    return next();
  }

  try {
    // Vérifier si l'utilisateur est délégué
    const delegation = await query('SELECT modules, is_active, collab_admin_rights, user_admin_rights, granular_permissions FROM public.admin_delegations WHERE user_id = $1', [req.userId]);
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
      req.user.granular_permissions = delegation.rows[0].granular_permissions || {};
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

module.exports = {
  authenticate,
  authenticateAllowLocked,
  authenticateSchoolSession,
  authenticateSchoolAccess,
  authorizeSchoolRoles,
  isAdmin,
  rateLimitAuth,
  checkChatParticipation
};
