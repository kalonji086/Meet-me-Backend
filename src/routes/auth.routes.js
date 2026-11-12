const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { authenticate, rateLimitAuth } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/error.middleware');
const Joi = require('joi');

const registerSchema = Joi.object({
  name: Joi.string().trim().required(),
  email: Joi.string().email().trim().required(),
  password: Joi.string().min(8).required(),
  phone_number: Joi.string().allow(null, ''),
  username: Joi.string().allow(null, ''),
  gender: Joi.string().valid('M', 'F').required(),
  country: Joi.string().trim().required(),
  province: Joi.string().trim().required(),
  city: Joi.string().trim().required(),
  commune: Joi.string().allow(null, ''),
  birth_date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  device_info: Joi.object().unknown(true).default({}),
  appVersion: Joi.string().allow(null, ''),
  accepted_legal_version: Joi.string().required(),
  accepted_tos_version: Joi.string().required(),
  accepted_privacy_version: Joi.string().required()
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required()
});

const googleLoginSchema = Joi.object({
  idToken: Joi.string().max(8192).required(),
  device_info: Joi.object().unknown(true).default({}),
  appVersion: Joi.string().allow(null, '')
});

const googleRegisterSchema = Joi.object({
  idToken: Joi.string().max(8192).required(),
  name: Joi.string().trim().required(),
  phone_number: Joi.string().pattern(/^\+\d{7,15}$/).required(),
  username: Joi.string().trim().pattern(/^[a-z0-9_.]{3,30}$/i).allow(null, ''),
  gender: Joi.string().valid('M', 'F').required(),
  country: Joi.string().trim().required(),
  province: Joi.string().trim().required(),
  city: Joi.string().trim().required(),
  commune: Joi.string().allow(null, ''),
  birth_date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  device_info: Joi.object().unknown(true).default({}),
  appVersion: Joi.string().allow(null, ''),
  accepted_legal_version: Joi.string().required(),
  accepted_tos_version: Joi.string().required(),
  accepted_privacy_version: Joi.string().required()
});

router.get('/check-availability', authController.checkAvailability);
router.post('/register', rateLimitAuth, validate(registerSchema), authController.register);
router.post('/login', rateLimitAuth, validate(loginSchema), authController.login);
router.post('/google', rateLimitAuth, validate(googleLoginSchema), authController.loginWithGoogle);
router.post('/google/register', rateLimitAuth, validate(googleRegisterSchema), authController.registerWithGoogle);
router.post('/refresh', authController.refreshToken);
router.post('/logout', authenticate, authController.logout);
router.post('/forgot-password', authController.forgotPassword);
router.post('/verify-otp', authController.verifyOTP);
router.post('/reset-password', authController.resetPassword);
router.put('/change-password', authenticate, authController.changePassword);
router.get('/verify', authenticate, authController.verifyToken);

module.exports = router;
