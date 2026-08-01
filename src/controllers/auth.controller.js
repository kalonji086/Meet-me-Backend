const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query } = require('../config/db');
const mailService = require('../services/mail.service');
const logger = require('../utils/logger');
const config = require('../../config/config');
const { asyncHandler } = require('../middleware/error.middleware');

/**
 * @desc    Inscription d'un nouvel utilisateur
 * @route   POST /api/auth/register
 * @access  Public
 */
const register = asyncHandler(async (req, res) => {
  const { name, email, password, phone_number } = req.body;

  // Validation basique
  if (!name || !email || !password) {
    return res.status(400).json({
      success: false,
      error: 'Veuillez fournir tous les champs requis',
    });
  }

  const emailLower = email.toLowerCase();

  // Vérifier si l'utilisateur existe déjà
  const existingUser = await query(
    'SELECT id FROM public.profiles WHERE email = $1 OR (phone_number IS NOT NULL AND phone_number = $2)',
    [emailLower, phone_number || null]
  );
  
  if (existingUser.rows.length > 0) {
    return res.status(400).json({
      success: false,
      error: 'Un utilisateur avec cet email ou ce numéro existe déjà',
    });
  }

  // Hasher le mot de passe
  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);

  // Créer l'utilisateur dans la table profiles
  // Note: On génère un UUID ici par sécurité si le défaut DB ne fonctionne pas
  const userId = crypto.randomUUID();

  const result = await query(
    `INSERT INTO public.profiles (id, full_name, email, password, username, phone_number)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, full_name, email, username, avatar_url, status, phone_number`,
    [
      userId,
      name,
      emailLower,
      hashedPassword,
      emailLower.split('@')[0] + Math.floor(Math.random() * 1000),
      phone_number || null
    ]
  );

  const user = result.rows[0];

  // Générer le token JWT
  const token = jwt.sign(
    { userId: user.id, email: user.email },
    config.jwt.secret,
    { expiresIn: config.jwt.expire }
  );

  // Générer le refresh token
  const refreshToken = jwt.sign(
    { userId: user.id },
    config.jwt.refreshSecret,
    { expiresIn: config.jwt.refreshExpire }
  );

  // Envoyer l'email de bienvenue
  await mailService.sendWelcomeEmail(user.email, user.full_name);

  logger.info(`Nouvel utilisateur inscrit: ${user.email}`);

  res.status(201).json({
    success: true,
    data: {
      token,
      refreshToken,
      user: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        username: user.username,
        avatar: user.avatar_url,
        status: user.status
      },
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

  const emailLower = email.toLowerCase();

  // Trouver l'utilisateur
  const result = await query(
    'SELECT * FROM public.profiles WHERE email = $1',
    [emailLower]
  );

  const user = result.rows[0];
  
  if (!user) {
    return res.status(401).json({
      success: false,
      error: 'Email ou mot de passe incorrect',
    });
  }

  // Vérifier le mot de passe
  const isPasswordValid = await bcrypt.compare(password, user.password);
  
  if (!isPasswordValid) {
    return res.status(401).json({
      success: false,
      error: 'Email ou mot de passe incorrect',
    });
  }

  // Mettre à jour le statut et last_seen
  await query(
    "UPDATE public.profiles SET status = 'online', last_seen = NOW() WHERE id = $1",
    [user.id]
  );

  // Générer le token JWT
  const token = jwt.sign(
    { userId: user.id, email: user.email },
    config.jwt.secret,
    { expiresIn: config.jwt.expire }
  );

  // Générer le refresh token
  const refreshToken = jwt.sign(
    { userId: user.id },
    config.jwt.refreshSecret,
    { expiresIn: config.jwt.refreshExpire }
  );

  logger.info(`Utilisateur connecté: ${user.email}`);

  res.json({
    success: true,
    data: {
      token,
      refreshToken,
      user: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        username: user.username,
        avatar: user.avatar_url,
        status: 'online'
      },
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
    const result = await query(
      'SELECT id, email, full_name, username, avatar_url, status FROM public.profiles WHERE id = $1',
      [decoded.userId]
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Utilisateur non trouvé',
      });
    }

    // Générer un nouveau token d'accès
    const newAccessToken = jwt.sign(
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
        token: newAccessToken,
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
  const userId = req.user.id;

  // Mettre à jour le statut
  await query(
    "UPDATE public.profiles SET status = 'offline', last_seen = NOW() WHERE id = $1",
    [userId]
  );

  logger.info(`Utilisateur déconnecté: ${userId}`);

  res.json({
    success: true,
    message: 'Déconnexion réussie',
  });
});

/**
 * @desc    Demande de réinitialisation de mot de passe (via OTP Brevo)
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

  const emailLower = email.toLowerCase();

  // Trouver l'utilisateur
  const result = await query(
    'SELECT id, email FROM public.profiles WHERE email = $1',
    [emailLower]
  );
  const user = result.rows[0];

  if (!user) {
    // Réponse générique pour la sécurité
    return res.json({
      success: true,
      message: 'Si un compte existe avec cet email, un code OTP a été envoyé',
    });
  }

  // Générer un code OTP à 6 chiffres
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const otpExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

  // Stocker l'OTP dans la base de données
  await query(
    'UPDATE public.profiles SET otp_code = $1, otp_expires_at = $2 WHERE id = $3',
    [otp, otpExpires, user.id]
  );

  // Envoyer l'email via Brevo
  await mailService.sendOTPEmail(user.email, otp);

  logger.info(`Demande de réinitialisation (OTP) pour: ${user.email}`);

  res.json({
    success: true,
    message: 'Si un compte existe avec cet email, un code OTP a été envoyé',
    // En développement, on peut retourner l'OTP pour faciliter les tests
    ...(config.server.nodeEnv === 'development' && { otp }),
  });
});

/**
 * @desc    Réinitialisation du mot de passe avec OTP
 * @route   POST /api/auth/reset-password
 * @access  Public
 */
const resetPassword = asyncHandler(async (req, res) => {
  const { email, otp, newPassword } = req.body;

  if (!email || !otp || !newPassword) {
    return res.status(400).json({
      success: false,
      error: 'Veuillez fournir l\'email, le code OTP et le nouveau mot de passe',
    });
  }

  const emailLower = email.toLowerCase();

  // Trouver l'utilisateur avec l'OTP valide
  const result = await query(
    'SELECT id FROM public.profiles WHERE email = $1 AND otp_code = $2 AND otp_expires_at > NOW()',
    [emailLower, otp]
  );
  
  const user = result.rows[0];

  if (!user) {
    return res.status(400).json({
      success: false,
      error: 'Code OTP invalide ou expiré',
    });
  }

  // Hasher le nouveau mot de passe
  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(newPassword, salt);

  // Mettre à jour le mot de passe et effacer l'OTP
  await query(
    'UPDATE public.profiles SET password = $1, otp_code = NULL, otp_expires_at = NULL WHERE id = $2',
    [hashedPassword, user.id]
  );

  logger.info(`Mot de passe réinitialisé pour: ${emailLower}`);

  res.json({
    success: true,
    message: 'Mot de passe réinitialisé avec succès',
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
    data: { user },
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
  verifyToken,
};