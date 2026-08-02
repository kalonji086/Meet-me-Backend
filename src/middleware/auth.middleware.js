const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const logger = require('../utils/logger');
const config = require('../../config/config');

/**
 * Middleware d'authentification JWT
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
      'SELECT id, email, full_name, username, avatar_url, status, is_global_admin FROM public.profiles WHERE id = $1',
      [decoded.userId]
    );
    const user = result.rows[0];
    
    if (!user) {
      return res.status(401).json({ success: false, error: 'Utilisateur non trouvé.' });
    }

    req.user = user;
    req.userId = user.id;

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Token JWT expiré.' });
    }
    return res.status(401).json({ success: false, error: 'Erreur d\'authentification.' });
  }
};

/**
 * Middleware pour restreindre l'accès à l'administrateur global
 */
const isAdmin = (req, res, next) => {
  if (req.user && req.user.is_global_admin === true) {
    next();
  } else {
    logger.warn(`Tentative d'accès Admin refusée pour: ${req.user?.email}`);
    res.status(403).json({ success: false, error: 'Accès réservé à l\'administrateur.' });
  }
};

module.exports = {
  authenticate,
  isAdmin
};
