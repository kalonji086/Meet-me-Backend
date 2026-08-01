const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chat.controller');
const { authenticate, checkChatParticipation } = require('../middleware/auth.middleware');

// Protéger toutes les routes
router.use(authenticate);

/**
 * @route   GET /api/messages/:chatId
 * @desc    Obtenir les messages d'une conversation
 */
router.get('/:chatId', checkChatParticipation, chatController.getMessages);

/**
 * @route   PUT /api/messages/:chatId/read
 */
router.put('/:chatId/read', checkChatParticipation, chatController.markAsRead);

/**
 * @route   POST /api/messages
 * @desc    Envoyer un message
 */
router.post('/', chatController.sendMessage);

/**
 * @route   DELETE /api/messages/:messageId
 * @desc    Supprimer un message
 */
router.delete('/:messageId', chatController.deleteMessage);

module.exports = router;
