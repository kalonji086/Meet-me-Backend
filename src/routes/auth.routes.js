const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { authenticate, rateLimitAuth } = require('../middleware/auth.middleware');
const { asyncHandler, validate } = require('../middleware/error.middleware');

// Validation schemas (simplifiée pour l'exemple)
const Joi = require('joi');

const registerSchema = Joi.object({
  name: Joi.string().min(2).max(50).required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

const refreshTokenSchema = Joi.object({
  refreshToken: Joi.string().required(),
});

const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
});

const resetPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
  otp: Joi.string().length(6).required(),
  password: Joi.string().min(8).required(),
});

const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string().min(8).required(),
});

/**
 * @route   GET /api/auth/check-availability
 */
router.get('/check-availability', authController.checkAvailability);

/**
 * @route   POST /api/auth/register
 * @desc    Inscription d'un nouvel utilisateur
 * @access  Public
 */
router.post(
  '/register',
  rateLimitAuth,
  validate(registerSchema),
  asyncHandler(authController.register)
);

/**
 * @route   POST /api/auth/login
 * @desc    Connexion utilisateur
 * @access  Public
 */
router.post(
  '/login',
  rateLimitAuth,
  validate(loginSchema),
  asyncHandler(authController.login)
);

/**
 * @route   POST /api/auth/refresh
 * @desc    Rafraîchir le token JWT
 * @access  Public
 */
router.post(
  '/refresh',
  validate(refreshTokenSchema),
  asyncHandler(authController.refreshToken)
);

/**
 * @route   POST /api/auth/logout
 * @desc    Déconnexion utilisateur
 * @access  Private
 */
router.post(
  '/logout',
  authenticate,
  asyncHandler(authController.logout)
);

/**
 * @route   POST /api/auth/forgot-password
 * @desc    Demande de réinitialisation de mot de passe
 * @access  Public
 */
router.post(
  '/forgot-password',
  validate(forgotPasswordSchema),
  asyncHandler(authController.forgotPassword)
);

/**
 * @route   POST /api/auth/reset-password
 * @desc    Réinitialisation du mot de passe avec OTP
 * @access  Public
 */
router.post(
  '/reset-password',
  validate(resetPasswordSchema),
  asyncHandler(authController.resetPassword)
);

/**
 * @route   PUT /api/auth/change-password
 */
router.put(
  '/change-password',
  authenticate,
  validate(changePasswordSchema),
  asyncHandler(authController.changePassword)
);

/**
 * @route   GET /api/auth/verify
 * @desc    Vérifier la validité du token
 * @access  Private
 */
router.get(
  '/verify',
  authenticate,
  asyncHandler(authController.verifyToken)
);

/**
 * @route   GET /api/auth/me
 * @desc    Obtenir le profil de l'utilisateur connecté
 * @access  Private
 */
router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({
      success: true,
      data: {
        user: req.user,
      },
    });
  })
);

module.exports = router;