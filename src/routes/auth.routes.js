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
  password: Joi.string().min(8).required(),
});

const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string().min(8).required(),
});

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
 * @route   POST /api/auth/reset-password/:token
 * @desc    Réinitialisation du mot de passe avec token
 * @access  Public
 */
router.post(
  '/reset-password/:token',
  validate(resetPasswordSchema),
  asyncHandler(authController.resetPassword)
);

/**
 * @route   GET /api/auth/verify-email/:token
 * @desc    Vérification d'email
 * @access  Public
 */
router.get(
  '/verify-email/:token',
  asyncHandler(authController.verifyEmail)
);

/**
 * @route   POST /api/auth/resend-verification
 * @desc    Renvoyer l'email de vérification
 * @access  Private
 */
router.post(
  '/resend-verification',
  authenticate,
  asyncHandler(authController.resendVerification)
);

/**
 * @route   POST /api/auth/change-password
 * @desc    Changer le mot de passe (utilisateur connecté)
 * @access  Private
 */
router.post(
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
        user: req.user.getFullProfile(),
      },
    });
  })
);

module.exports = router;