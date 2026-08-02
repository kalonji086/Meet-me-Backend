const express = require('express');
const router = express.Router();
const callController = require('../controllers/call.controller');
const { authenticate } = require('../middleware/auth.middleware');

// Toutes les routes d'appel sont protégées
router.use(authenticate);

/**
 * @route   POST /api/calls/generate-token
 */
router.post('/generate-token', callController.generateToken);

module.exports = router;
