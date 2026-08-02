const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { authenticate, isAdmin } = require('../middleware/auth.middleware');

// Sécuriser TOUTES les routes admin
router.use(authenticate);
router.use(isAdmin);

/**
 * @route   GET /api/admin/stats
 */
router.get('/stats', adminController.getStats);

/**
 * @route   GET /api/admin/users
 */
router.get('/users', adminController.getUsers);

/**
 * @route   PUT /api/admin/users/:userId/lock
 */
router.put('/users/:userId/lock', adminController.toggleUserLock);

/**
 * @route   GET /api/admin/groups
 */
router.get('/groups', adminController.getGroups);

/**
 * @route   POST /api/admin/broadcast
 */
router.post('/broadcast', adminController.broadcastMessage);

module.exports = router;
