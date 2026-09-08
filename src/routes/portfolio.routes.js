const express = require('express');
const router = express.Router();
const portfolioController = require('../controllers/portfolio.controller');
const { authenticate, isAdmin } = require('../middleware/auth.middleware');
const { asyncHandler } = require('../middleware/error.middleware');

// Public access
router.get('/public', portfolioController.getPublicData); // Default (Together Tech)
router.get('/:slug/public', portfolioController.getPublicData); // Custom Portfolio
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
router.put('/community/messages/:messageId/pin', portfolioController.togglePinMessage);

// Request a new portfolio (Publicly accessible)
const uploadController = require('../controllers/upload.controller');
router.post('/upload-logo', uploadController.uploadMiddleware.singleFile, (req, res, next) => {
    // Public upload for logo
    req.userId = '00000000-0000-0000-0000-000000000000'; // System ID
    next();
}, asyncHandler(uploadController.uploadFile));

router.post('/request', portfolioController.submitPortfolioRequest);

// Admin restricted access
router.use(authenticate);

// Admin only (Global Admin)
router.get('/admin/requests', isAdmin, portfolioController.getPortfolioRequests);
router.post('/admin/requests/:id/approve', isAdmin, portfolioController.approvePortfolioRequest);
router.get('/admin/all', isAdmin, portfolioController.getAllPortfolios);
router.put('/admin/:id/status', isAdmin, portfolioController.togglePortfolioStatus);

// Portfolio Management (Any authorized admin/owner)
router.post('/admin/skills', portfolioController.manageSkill);
router.post('/admin/experiences', portfolioController.manageExperience);
router.post('/admin/services', portfolioController.manageService);
router.post('/admin/team', portfolioController.manageTeam);
router.post('/admin/pages', portfolioController.managePage);
router.put('/admin/profile', portfolioController.updateProfileAdmin);
router.get('/admin/quotes', portfolioController.getQuotes);
router.put('/admin/quotes/:id', portfolioController.updateQuoteStatusAdmin);
router.post('/admin/quotes/:id/reply', portfolioController.replyToQuote);
router.put('/admin/quotes/:id/contract', portfolioController.updateContract);

module.exports = router;
