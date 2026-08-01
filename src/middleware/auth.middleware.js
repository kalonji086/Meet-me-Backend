const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const logger = require('../utils/logger');
const config = require('../../config/config');

/**
 * Middleware d'authentification JWT
 */
const authenticate = async (req, res, next) => {
  try {
    // Récupérer le token depuis les headers
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Accès non autorisé. Token manquant.',
      });
    }

    const token = authHeader.split(' ')[1];

    // Vérifier le token
    const decoded = jwt.verify(token, config.jwt.secret);
    
    // Trouver l'utilisateur
    const result = await query(
      'SELECT id, email, full_name, username, avatar_url, status FROM public.profiles WHERE id = $1',
      [decoded.userId]
    );
    const user = result.rows[0];
    
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Utilisateur non trouvé. Token invalide.',
      });
    }

    // Ajouter l'utilisateur à la requête
    req.user = user;
    req.userId = user.id;

    // Log de l'authentification
    logger.debug(`Authentification réussie pour l'utilisateur: ${user.email}`);

    next();
  } catch (error) {
    logger.error('Erreur d\'authentification:', error);

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Token JWT invalide.',
      });
    }

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token JWT expiré. Veuillez vous reconnecter.',
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Erreur d\'authentification.',
    });
  }
};

/**
 * Middleware pour vérifier les rôles
 */
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Accès non autorisé. Utilisateur non authentifié.',
      });
    }

    if (!roles.includes(req.user.role)) {
      logger.warn(`Tentative d'accès non autorisé: ${req.user.email} - Rôle: ${req.user.role}`);
      
      return res.status(403).json({
        success: false,
        error: 'Accès interdit. Permissions insuffisantes.',
      });
    }

    next();
  };
};

/**
 * Middleware pour vérifier la propriété (Version Postgres)
 */
const checkOwnership = (tableName, paramName = 'id', userIdField = 'sender_id') => {
  return async (req, res, next) => {
    try {
      const documentId = req.params[paramName];
      const userId = req.userId;

      const result = await query(
        `SELECT * FROM public.${tableName} WHERE id = $1`,
        [documentId]
      );

      const document = result.rows[0];

      if (!document) {
        return res.status(404).json({
          success: false,
          error: 'Document non trouvé.',
        });
      }

      // Vérifier la propriété
      if (document[userIdField] !== userId && req.user.role !== 'admin') {
        return res.status(403).json({
          success: false,
          error: 'Accès interdit. Vous n\'êtes pas propriétaire de cette ressource.',
        });
      }

      req.document = document;
      next();
    } catch (error) {
      logger.error('Erreur de vérification de propriété:', error);
      return res.status(500).json({
        success: false,
        error: 'Erreur de vérification des permissions.',
      });
    }
  };
};

/**
 * Middleware pour vérifier la participation à une conversation (Version Postgres)
 */
const checkChatParticipation = async (req, res, next) => {
  try {
    const chatId = req.params.chatId || req.body.chat;
    const userId = req.userId;

    if (!chatId) {
      return next();
    }

    const result = await query(
      'SELECT 1 FROM public.chat_participants WHERE chat_id = $1 AND user_id = $2',
      [chatId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({
        success: false,
        error: 'Accès interdit. Vous ne faites pas partie de cette conversation.',
      });
    }

    next();
  } catch (error) {
    logger.error('Erreur de vérification de participation:', error);
    return res.status(500).json({
      success: false,
      error: 'Erreur de vérification des permissions.',
    });
  }
};

/**
 * Middleware pour générer un nouveau token d'accès (Version Postgres)
 */
const refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        error: 'Refresh token requis.',
      });
    }

    // Vérifier le refresh token
    const decoded = jwt.verify(refreshToken, config.jwt.refreshSecret);
    
    // Trouver l'utilisateur
    const result = await query(
      'SELECT id, email, full_name, username, avatar_url, status FROM public.profiles WHERE id = $1',
      [decoded.userId]
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Utilisateur non trouvé.',
      });
    }

    // Générer un nouveau token d'accès
    const accessToken = jwt.sign(
      { userId: user.id, email: user.email },
      config.jwt.secret,
      { expiresIn: config.jwt.expire }
    );

    // Générer un nouveau refresh token
    const newRefreshToken = jwt.sign(
      { userId: user.id },
      config.jwt.refreshSecret,
      { expiresIn: config.jwt.refreshExpire }
    );

    logger.debug(`Token rafraîchi pour l'utilisateur: ${user.email}`);

    res.json({
      success: true,
      data: {
        accessToken,
        refreshToken: newRefreshToken,
        user: {
          id: user.id,
          name: user.full_name,
          email: user.email,
          username: user.username,
          avatar: user.avatar_url,
          status: user.status
        },
      },
    });
  } catch (error) {
    logger.error('Erreur de rafraîchissement du token:', error);

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Refresh token invalide.',
      });
    }

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Refresh token expiré. Veuillez vous reconnecter.',
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Erreur de rafraîchissement du token.',
    });
  }
};

/**
 * Middleware pour vérifier l'email vérifié
 */
const requireVerifiedEmail = (req, res, next) => {
  if (!req.user.emailVerified) {
    return res.status(403).json({
      success: false,
      error: 'Veuillez vérifier votre adresse email avant d\'effectuer cette action.',
    });
  }
  next();
};

/**
 * Middleware pour limiter les tentatives de connexion
 */
const rateLimitAuth = (req, res, next) => {
  // Implémentation basique de rate limiting
  // Dans une application réelle, utiliser un package comme express-rate-limit
  const ip = req.ip;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const maxAttempts = 5;

  // Stocker les tentatives en mémoire (dans une app réelle, utiliser Redis)
  if (!req.app.locals.authAttempts) {
    req.app.locals.authAttempts = new Map();
  }

  const attempts = req.app.locals.authAttempts.get(ip) || [];

  // Nettoyer les tentatives anciennes
  const recentAttempts = attempts.filter(time => now - time < windowMs);

  if (recentAttempts.length >= maxAttempts) {
    const retryAfter = Math.ceil((recentAttempts[0] + windowMs - now) / 1000);
    
    return res.status(429).json({
      success: false,
      error: `Trop de tentatives. Réessayez dans ${retryAfter} secondes.`,
      retryAfter,
    });
  }

  // Ajouter la tentative actuelle
  recentAttempts.push(now);
  req.app.locals.authAttempts.set(ip, recentAttempts);

  next();
};

module.exports = {
  authenticate,
  authorize,
  checkOwnership,
  checkChatParticipation,
  refreshToken,
  requireVerifiedEmail,
  rateLimitAuth,
};