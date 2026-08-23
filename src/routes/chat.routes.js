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
 * @route   PUT /api/chats/:chatId/favorite
 */
router.put('/:chatId/favorite', chatController.toggleFavorite);

/**
 * @route   PUT /api/chats/:chatId/priority
 */
router.put('/:chatId/priority', chatController.togglePriority);

/**
 * @route   DELETE /api/chats/:chatId
 */
router.delete('/:chatId', chatController.deleteChat);

/**
 * @route   GET /api/chats/:chatId
 */
router.get('/:chatId', chatController.getChatDetails);

/**
 * @route   PUT /api/chats/:chatId
 */
router.put('/:chatId', chatController.updateChat);

/**
 * @route   POST /api/chats/:chatId/members
 */
router.post('/:chatId/members', chatController.addMembers);

/**
 * @route   DELETE /api/chats/:chatId/members/:targetUserId
 */
router.delete('/:chatId/members/:targetUserId', chatController.removeMember);

/**
 * @route   PUT /api/chats/:chatId/members/:targetUserId/role
 */
router.put('/:chatId/members/:targetUserId/role', chatController.changeMemberRole);

module.exports = router;
