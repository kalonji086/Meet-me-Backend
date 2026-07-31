const logger = require('../utils/logger');
const config = require('../../config/config');

/**
 * Middleware pour les routes non trouvées
 */
const notFound = (req, res, next) => {
  const error = new Error(`Route non trouvée - ${req.originalUrl}`);
  error.statusCode = 404;
  next(error);
};

/**
 * Middleware de gestion des erreurs
 */
const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;
  error.stack = err.stack;

  // Log de l'erreur
  logger.errorWithContext(err, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    user: req.user ? req.user._id : null,
    body: config.server.nodeEnv === 'development' ? req.body : undefined,
    params: config.server.nodeEnv === 'development' ? req.params : undefined,
    query: config.server.nodeEnv === 'development' ? req.query : undefined,
  });

  // Erreurs Mongoose
  if (err.name === 'CastError') {
    const message = `Ressource non trouvée avec l'ID ${err.value}`;
    error = new Error(message);
    error.statusCode = 404;
  }

  // Erreur de validation Mongoose
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map(val => val.message);
    const message = `Validation échouée: ${messages.join(', ')}`;
    error = new Error(message);
    error.statusCode = 400;
  }

  // Erreur de duplication (clé unique)
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern)[0];
    const value = err.keyValue[field];
    const message = `La valeur '${value}' pour le champ '${field}' existe déjà`;
    error = new Error(message);
    error.statusCode = 400;
  }

  // Erreur JWT
  if (err.name === 'JsonWebTokenError') {
    const message = 'Token JWT invalide';
    error = new Error(message);
    error.statusCode = 401;
  }

  // Token JWT expiré
  if (err.name === 'TokenExpiredError') {
    const message = 'Token JWT expiré';
    error = new Error(message);
    error.statusCode = 401;
  }

  // Erreur de limite de taille de fichier (Multer)
  if (err.code === 'LIMIT_FILE_SIZE') {
    const message = `Fichier trop volumineux. Taille maximale: ${config.upload.maxFileSize / (1024 * 1024)}MB`;
    error = new Error(message);
    error.statusCode = 400;
  }

  // Erreur de type de fichier (Multer)
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    const message = 'Type de fichier non autorisé';
    error = new Error(message);
    error.statusCode = 400;
  }

  // Déterminer le statut HTTP
  const statusCode = error.statusCode || err.statusCode || 500;
  
  // Déterminer le message d'erreur
  let message = error.message || 'Erreur interne du serveur';
  
  // En production, masquer les détails des erreurs internes
  if (statusCode === 500 && config.server.nodeEnv === 'production') {
    message = 'Erreur interne du serveur';
  }

  // Réponse d'erreur
  const errorResponse = {
    success: false,
    error: message,
    statusCode,
  };

  // Ajouter la stack trace en développement
  if (config.server.nodeEnv === 'development') {
    errorResponse.stack = error.stack;
    
    // Ajouter des détails supplémentaires pour le débogage
    if (err.errors) {
      errorResponse.errors = err.errors;
    }
    
    if (err.code) {
      errorResponse.code = err.code;
    }
  }

  // Envoyer la réponse
  res.status(statusCode).json(errorResponse);
};

/**
 * Middleware pour wrapper les contrôleurs async/await
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * Middleware pour valider les données d'entrée
 */
const validate = (schema) => (req, res, next) => {
  try {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const messages = error.details.map(detail => detail.message);
      return res.status(400).json({
        success: false,
        error: 'Validation échouée',
        details: messages,
      });
    }

    // Remplacer le body par les données validées
    req.body = value;
    next();
  } catch (validationError) {
    next(validationError);
  }
};

/**
 * Middleware pour vérifier les permissions de rôle
 */
const hasPermission = (permission) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'Authentification requise',
    });
  }

  // Dans une application réelle, vous auriez un système de permissions plus complexe
  // Pour l'instant, nous utilisons simplement les rôles
  const userRole = req.user.role;
  
  // Définir les permissions par rôle
  const rolePermissions = {
    admin: ['create', 'read', 'update', 'delete', 'manage_users', 'manage_chats'],
    moderator: ['create', 'read', 'update', 'delete', 'manage_chats'],
    user: ['create', 'read', 'update', 'delete_own'],
  };

  const userPermissions = rolePermissions[userRole] || [];

  if (!userPermissions.includes(permission)) {
    return res.status(403).json({
      success: false,
      error: 'Permissions insuffisantes',
    });
  }

  next();
};

/**
 * Middleware pour limiter le taux de requêtes
 */
const rateLimiter = (options = {}) => {
  const windowMs = options.windowMs || 15 * 60 * 1000; // 15 minutes par défaut
  const max = options.max || 100; // 100 requêtes par fenêtre par défaut
  const keyGenerator = options.keyGenerator || (req => req.ip);

  const requests = new Map();

  return (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();
    
    if (!requests.has(key)) {
      requests.set(key, []);
    }

    const window = requests.get(key);
    
    // Nettoyer les requêtes anciennes
    const validWindow = window.filter(time => now - time < windowMs);
    requests.set(key, validWindow);

    if (validWindow.length >= max) {
      const retryAfter = Math.ceil((validWindow[0] + windowMs - now) / 1000);
      
      return res.status(429).json({
        success: false,
        error: `Trop de requêtes. Réessayez dans ${retryAfter} secondes.`,
        retryAfter,
      });
    }

    // Ajouter la requête actuelle
    validWindow.push(now);
    next();
  };
};

module.exports = {
  notFound,
  errorHandler,
  asyncHandler,
  validate,
  hasPermission,
  rateLimiter,
};