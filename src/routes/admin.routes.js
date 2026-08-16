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

router.get('/reports', adminController.getReports);
router.put('/reports/:id/resolve', adminController.resolveReport);

router.get('/analytics', adminController.getAnalytics);

router.get('/campaigns', adminController.getCampaigns);
router.post('/campaigns', adminController.createCampaign);
router.put('/campaigns/:id', adminController.updateCampaign);
router.delete('/campaigns/:id', adminController.deleteCampaign);

router.get('/audit-logs', adminController.getAuditLogs);

router.post('/broadcast', adminController.broadcastMessage);

router.get('/app-config', adminController.getAppConfig);
router.post('/app-config', adminController.updateAppConfig);
router.delete('/app-config/:id', adminController.deleteAppConfig);

router.get('/legal', adminController.getLegalDocs);
router.post('/legal', adminController.updateLegalDoc);
router.delete('/legal/:type', adminController.deleteLegalDoc);

router.get('/verifications', adminController.getVerificationRequests);
router.put('/verifications/:id', adminController.handleVerification);

router.get('/market-requests', adminController.getMarketRequests);
router.put('/market-requests/:id', adminController.handleMarketRequest);
router.put('/market-requests/:id/toggle-block', adminController.toggleMarketBlock);
router.delete('/market-requests/:id', adminController.deleteMarketBusiness);

// Market Groups Management
router.post('/market-groups', adminController.createOfficialGroup);
router.get('/market-groups/members', adminController.getMarketGroupMembers);
router.post('/market-groups/remove-member', adminController.removeMarketGroupMember);

module.exports = router;
