const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { authenticate } = require('../middleware/auth.middleware');

// Toutes les routes utilisateur sont protégées
router.use(authenticate);

/**
 * @route   GET /api/users/search
 * @desc    Rechercher des utilisateurs
 * @access  Private
 */
router.get('/search', userController.searchUsers);

/**
 * @route   GET /api/users/profile
 * @desc    Obtenir son propre profil
 * @access  Private
 */
router.get('/profile', userController.getProfile);

/**
 * @route   PUT /api/users/profile
 * @desc    Mettre à jour son profil
 * @access  Private
 */
router.put('/profile', userController.updateProfile);

/**
 * @route   POST /api/users/sync-contacts
 * @desc    Synchroniser les contacts téléphoniques
 * @access  Private
 */
router.post('/sync-contacts', userController.syncContacts);

/**
 * @route   PUT /api/users/privacy
 */
router.put('/privacy', userController.updatePrivacySettings);

/**
 * @route   DELETE /api/users/account
 */
router.delete('/account', userController.deleteAccount);

/**
 * @route   PUT /api/users/push-token
 */
router.put('/push-token', userController.updatePushToken);

module.exports = router;
