const express = require('express');
const router = express.Router();
const portfolioController = require('../controllers/portfolio.controller');
const { authenticate, isAdmin } = require('../middleware/auth.middleware');

// Public access
router.get('/public', portfolioController.getPublicData);
router.post('/quote', portfolioController.submitQuote);

// Admin restricted access
router.use(authenticate);
router.use(isAdmin);

router.post('/admin/skills', portfolioController.manageSkill);
router.post('/admin/experiences', portfolioController.manageExperience);
router.post('/admin/services', portfolioController.manageService);
router.get('/admin/quotes', portfolioController.getQuotes);
router.put('/admin/quotes/:id', portfolioController.updateQuoteStatus);

module.exports = router;
