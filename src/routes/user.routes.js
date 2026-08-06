const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { authenticate } = require('../middleware/auth.middleware');

// Toutes les routes utilisateur sont protégées
router.use(authenticate);

/**
 * @route   GET /api/users/profile/current
 */
router.get('/profile/current', userController.getMe);

/**
 * @route   GET /api/users/search
 */
router.get('/search', userController.searchUsers);

/**
 * @route   PUT /api/users/profile
 */
router.put('/profile', userController.updateProfile);

/**
 * @route   POST /api/users/sync-contacts
 */
router.post('/sync-contacts', userController.syncContacts);

/**
 * @route   PUT /api/users/privacy
 */
router.put('/privacy', userController.updatePrivacy);

/**
 * @route   PUT /api/users/push-token
 */
router.put('/push-token', userController.updatePushToken);

/**
 * @route   GET /api/users/badges
 */
router.get('/badges', userController.getBadges);

/**
 * @route   POST /api/users/verify
 */
router.post('/verify', userController.submitVerification);

/**
 * @route GET /api/users/:id
 */
router.get('/:id', userController.getUserById);

module.exports = router;
