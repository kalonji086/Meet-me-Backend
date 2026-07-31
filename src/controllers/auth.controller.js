const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User.model');
const logger = require('../utils/logger');
const config = require('../../config/config');
const { asyncHandler } = require('../middleware/error.middleware');

/**
 * @desc    Inscription d'un nouvel utilisateur
 * @route   POST /api/auth/register
 * @access  Public
 */
const register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;

  // Validation basique
  if (!name || !email || !password) {
    return res.status(400).json({
      success: false,
      error: 'Veuillez fournir tous les champs requis',
    });
  }

  // Vérifier si l'utilisateur existe déjà
  const existingUser = await User.findOne({ email: email.toLowerCase() });
  
  if (existingUser) {
    return res.status(400).json({
      success: false,
      error: 'Un utilisateur avec cet email existe déjà',
    });
  }

  // Créer l'utilisateur
  const user = await User.create({
    name,
    email: email.toLowerCase(),
    password,
  });

  // Générer le token JWT
  const token = jwt.sign(
    { userId: user._id, email: user.email },
    config.jwt.secret,
    { expiresIn: config.jwt.expire }
  );

  // Générer le refresh token
  const refreshToken = jwt.sign(
    { userId: user._id },
    config.jwt.refreshSecret,
    { expiresIn: config.jwt.refreshExpire }
  );

  logger.info(`Nouvel utilisateur inscrit: ${user.email}`);

  res.status(201).json({
    success: true,
    data: {
      token,
      refreshToken,
      user: user.getFullProfile(),
    },
    message: 'Inscription réussie',
  });
});

/**
 * @desc    Connexion utilisateur
 * @route   POST /api/auth/login
 * @access  Public
 */
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  // Validation
  if (!email || !password) {
    return res.status(400).json({
      success: false,
      error: 'Veuillez fournir un email et un mot de passe',
    });
  }

  // Trouver l'utilisateur avec le mot de passe
  const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
  
  if (!user) {
    return res.status(401).json({
      success: false,
      error: 'Email ou mot de passe incorrect',
    });
  }

  // Vérifier le mot de passe
  const isPasswordValid = await user.comparePassword(password);
  
  if (!isPasswordValid) {
    return res.status(401).json({
      success: false,
      error: 'Email ou mot de passe incorrect',
    });
  }

  // Vérifier si le compte est actif
  if (!user.isActive) {
    return res.status(401).json({
      success: false,
      error: 'Compte désactivé. Contactez l\'administrateur.',
    });
  }

  // Mettre à jour le statut
  await user.updateStatus('online');

  // Générer le token JWT
  const token = jwt.sign(
    { userId: user._id, email: user.email },
    config.jwt.secret,
    { expiresIn: config.jwt.expire }
  );

  // Générer le refresh token
  const refreshToken = jwt.sign(
    { userId: user._id },
    config.jwt.refreshSecret,
    { expiresIn: config.jwt.refreshExpire }
  );

  logger.info(`Utilisateur connecté: ${user.email}`);

  res.json({
    success: true,
    data: {
      token,
      refreshToken,
      user: user.getFullProfile(),
    },
    message: 'Connexion réussie',
  });
});

/**
 * @desc    Rafraîchir le token
 * @route   POST /api/auth/refresh
 * @access  Public
 */
const refreshToken = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({
      success: false,
      error: 'Refresh token requis',
    });
  }

  try {
    // Vérifier le refresh token
    const decoded = jwt.verify(refreshToken, config.jwt.refreshSecret);
    
    // Trouver l'utilisateur
    const user = await User.findById(decoded.userId);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Utilisateur non trouvé',
      });
    }

    // Générer un nouveau token d'accès
    const newAccessToken = jwt.sign(
      { userId: user._id, email: user.email },
      config.jwt.secret,
      { expiresIn: config.jwt.expire }
    );

    // Générer un nouveau refresh token
    const newRefreshToken = jwt.sign(
      { userId: user._id },
      config.jwt.refreshSecret,
      { expiresIn: config.jwt.refreshExpire }
    );

    logger.debug(`Token rafraîchi pour l'utilisateur: ${user.email}`);

    res.json({
      success: true,
      data: {
        token: newAccessToken,
        refreshToken: newRefreshToken,
        user: user.getPublicProfile(),
      },
    });
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Refresh token invalide',
      });
    }

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Refresh token expiré. Veuillez vous reconnecter.',
      });
    }

    throw error;
  }
});

/**
 * @desc    Déconnexion utilisateur
 * @route   POST /api/auth/logout
 * @access  Private
 */
const logout = asyncHandler(async (req, res) => {
  const user = req.user;

  // Mettre à jour le statut
  await user.updateStatus('offline');

  logger.info(`Utilisateur déconnecté: ${user.email}`);

  res.json({
    success: true,
    message: 'Déconnexion réussie',
  });
});

/**
 * @desc    Demande de réinitialisation de mot de passe
 * @route   POST /api/auth/forgot-password
 * @access  Public
 */
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({
      success: false,
      error: 'Veuillez fournir un email',
    });
  }

  // Trouver l'utilisateur
  const user = await User.findOne({ email: email.toLowerCase() });

  // Pour des raisons de sécurité, ne pas révéler si l'utilisateur existe ou non
  if (!user) {
    logger.warn(`Tentative de réinitialisation pour un email inexistant: ${email}`);
    
    // Retourner une réponse générique pour éviter l'énumération d'emails
    return res.json({
      success: true,
      message: 'Si un compte existe avec cet email, un lien de réinitialisation a été envoyé',
    });
  }

  // Générer le token de réinitialisation
  const resetToken = user.createPasswordResetToken();
  await user.save();

  // Dans une application réelle, envoyer un email ici
  // Pour l'instant, retourner le token dans la réponse (pour le développement)
  const resetUrl = `${req.protocol}://${req.get('host')}/api/auth/reset-password/${resetToken}`;

  logger.info(`Demande de réinitialisation de mot de passe pour: ${user.email}`);

  res.json({
    success: true,
    message: 'Si un compte existe avec cet email, un lien de réinitialisation a été envoyé',
    // Ne retourner ces informations qu'en développement
    ...(config.server.nodeEnv === 'development' && {
      resetToken,
      resetUrl,
      userId: user._id,
    }),
  });
});

/**
 * @desc    Réinitialisation du mot de passe
 * @route   POST /api/auth/reset-password/:token
 * @access  Public
 */
const resetPassword = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({
      success: false,
      error: 'Veuillez fournir un nouveau mot de passe',
    });
  }

  // Hasher le token pour le comparer avec celui stocké
  const hashedToken = crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');

  // Trouver l'utilisateur avec un token valide et non expiré
  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  });

  if (!user) {
    return res.status(400).json({
      success: false,
      error: 'Token invalide ou expiré',
    });
  }

  // Mettre à jour le mot de passe
  user.password = password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  logger.info(`Mot de passe réinitialisé pour: ${user.email}`);

  res.json({
    success: true,
    message: 'Mot de passe réinitialisé avec succès',
  });
});

/**
 * @desc    Vérification d'email
 * @route   GET /api/auth/verify-email/:token
 * @access  Public
 */
const verifyEmail = asyncHandler(async (req, res) => {
  const { token } = req.params;

  // Trouver l'utilisateur avec le token de vérification
  const user = await User.findOne({
    emailVerificationToken: token,
  });

  if (!user) {
    return res.status(400).json({
      success: false,
      error: 'Token de vérification invalide',
    });
  }

  // Marquer l'email comme vérifié
  user.emailVerified = true;
  user.emailVerificationToken = undefined;
  await user.save();

  logger.info(`Email vérifié pour: ${user.email}`);

  res.json({
    success: true,
    message: 'Email vérifié avec succès',
    user: user.getPublicProfile(),
  });
});

/**
 * @desc    Renvoyer l'email de vérification
 * @route   POST /api/auth/resend-verification
 * @access  Private
 */
const resendVerification = asyncHandler(async (req, res) => {
  const user = req.user;

  if (user.emailVerified) {
    return res.status(400).json({
      success: false,
      error: 'Email déjà vérifié',
    });
  }

  // Générer un nouveau token de vérification
  const verificationToken = crypto.randomBytes(32).toString('hex');
  
  user.emailVerificationToken = crypto
    .createHash('sha256')
    .update(verificationToken)
    .digest('hex');
  
  await user.save();

  // Dans une application réelle, envoyer un email ici
  const verificationUrl = `${req.protocol}://${req.get('host')}/api/auth/verify-email/${verificationToken}`;

  logger.info(`Email de vérification renvoyé pour: ${user.email}`);

  res.json({
    success: true,
    message: 'Email de vérification envoyé',
    // Ne retourner ces informations qu'en développement
    ...(config.server.nodeEnv === 'development' && {
      verificationToken,
      verificationUrl,
    }),
  });
});

/**
 * @desc    Changer le mot de passe (utilisateur connecté)
 * @route   POST /api/auth/change-password
 * @access  Private
 */
const changePassword = asyncHandler(async (req, res) => {
  const user = req.user;
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      success: false,
      error: 'Veuillez fournir l\'ancien et le nouveau mot de passe',
    });
  }

  // Vérifier l'ancien mot de passe
  const isPasswordValid = await user.comparePassword(currentPassword);
  
  if (!isPasswordValid) {
    return res.status(401).json({
      success: false,
      error: 'Ancien mot de passe incorrect',
    });
  }

  // Mettre à jour le mot de passe
  user.password = newPassword;
  await user.save();

  logger.info(`Mot de passe changé pour: ${user.email}`);

  res.json({
    success: true,
    message: 'Mot de passe changé avec succès',
  });
});

/**
 * @desc    Vérifier le token (pour le frontend)
 * @route   GET /api/auth/verify
 * @access  Private
 */
const verifyToken = asyncHandler(async (req, res) => {
  const user = req.user;

  res.json({
    success: true,
    data: {
      user: user.getFullProfile(),
    },
    message: 'Token valide',
  });
});

module.exports = {
  register,
  login,
  refreshToken,
  logout,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerification,
  changePassword,
  verifyToken,
};