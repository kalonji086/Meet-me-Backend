const express = require('express');
const router = express.Router();
const portfolioController = require('../controllers/portfolio.controller');
const { authenticate, isAdmin } = require('../middleware/auth.middleware');

// Public access
router.get('/public', portfolioController.getPublicData);
router.post('/quote', portfolioController.submitQuote);
router.get('/client/tracking', portfolioController.getClientQuotes);
router.get('/chat/:quoteId', portfolioController.handleChat);
router.post('/chat/:quoteId', portfolioController.handleChat);
router.post('/client/quotes/:id/sign', portfolioController.signContract);
router.put('/client/quotes/:id/specs', portfolioController.updateSpecs);

// Community Public access
router.get('/community/groups', portfolioController.getCommunityGroups);
router.get('/community/groups/:groupId/messages', portfolioController.getCommunityMessages);
router.post('/community/groups/:groupId/messages', portfolioController.sendCommunityMessage);

// Admin restricted access
router.use(authenticate);
router.use(isAdmin);

router.post('/admin/skills', portfolioController.manageSkill);
router.post('/admin/experiences', portfolioController.manageExperience);
router.post('/admin/services', portfolioController.manageService);
router.post('/admin/team', portfolioController.manageTeam);
router.put('/admin/profile', portfolioController.updateProfile);
router.get('/admin/quotes', portfolioController.getQuotes);
router.put('/admin/quotes/:id', portfolioController.updateQuoteStatus);
router.post('/admin/quotes/:id/reply', portfolioController.replyToQuote);
router.put('/admin/quotes/:id/contract', portfolioController.updateContract);

module.exports = router;
