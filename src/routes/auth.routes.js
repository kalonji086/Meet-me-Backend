const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { authenticate, rateLimitAuth } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/error.middleware');
const Joi = require('joi');

const registerSchema = Joi.object({
  name: Joi.string().required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
  phone_number: Joi.string().allow(null, ''),
  username: Joi.string().allow(null, '')
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required()
});

router.get('/check-availability', authController.checkAvailability);
router.post('/register', rateLimitAuth, validate(registerSchema), authController.register);
router.post('/login', rateLimitAuth, validate(loginSchema), authController.login);
router.post('/refresh', authController.refreshToken);
router.post('/logout', authenticate, authController.logout);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.put('/change-password', authenticate, authController.changePassword);
router.get('/verify', authenticate, authController.verifyToken);

module.exports = router;
