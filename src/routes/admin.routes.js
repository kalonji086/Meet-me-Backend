const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { authenticate, isAdmin } = require('../middleware/auth.middleware');

router.use(authenticate);
router.use(isAdmin);

router.get('/stats', adminController.getStats);
router.get('/users', adminController.getUsers);
router.delete('/users/:userId', adminController.deleteUser);
router.put('/users/:userId/lock', adminController.toggleUserLock);

router.get('/groups', adminController.getGroups);
router.get('/groups/:chatId/members', adminController.getGroupMembers);
router.put('/groups/:chatId/ban', adminController.toggleGroupBan);
router.delete('/groups/:chatId', adminController.deleteGroup);

router.get('/appeals', adminController.getAppeals);
router.post('/appeals/:id/reply', adminController.replyToAppeal);

router.post('/broadcast', adminController.broadcastMessage);

module.exports = router;
