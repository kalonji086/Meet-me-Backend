const express = require('express');
const router = express.Router();
const marketController = require('../controllers/market.controller');
const { authenticate } = require('../middleware/auth.middleware');

router.use(authenticate);

/**
 * @route   POST /api/market/register
 * @desc    Submit business registration
 */
router.post('/register', marketController.registerBusiness);

/**
 * @route   GET /api/market/my-business
 * @desc    Get user's business registration status
 */
router.get('/my-business', marketController.getMyBusiness);

/**
 * @route   GET /api/market/dashboard
 * @desc    Get business dashboard stats
 */
router.get('/dashboard', marketController.getDashboardStats);

/**
 * @route   POST /api/market/posts
 * @desc    Create a new post
 */
router.post('/posts', marketController.createPost);

/**
 * @route   GET /api/market/feed
 * @desc    Get market discovery feed
 */
router.get('/feed', marketController.getDiscoveryFeed);

module.exports = router;
