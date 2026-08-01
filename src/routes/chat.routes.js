const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chat.controller');
const { authenticate } = require('../middleware/auth.middleware');

// Protéger toutes les routes
router.use(authenticate);

/**
 * @route   GET /api/chats
 * @desc    Obtenir les conversations de l'utilisateur
 */
router.get('/', chatController.getChats);

/**
 * @route   POST /api/chats
 * @desc    Créer une nouvelle conversation
 */
router.post('/', chatController.createChat);

/**
 * @route   PUT /api/chats/:chatId/archive
 */
router.put('/:chatId/archive', chatController.toggleArchive);

/**
 * @route   DELETE /api/chats/:chatId
 */
router.delete('/:chatId', chatController.deleteChat);

module.exports = router;
