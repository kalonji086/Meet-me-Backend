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
 * @desc    Get market discovery feed (posts)
 */
router.get('/feed', marketController.getDiscoveryFeed);

/**
 * @route   GET /api/market/discovery
 * @desc    Get list of businesses for discovery
 */
router.get('/discovery', marketController.getDiscoveryBusinesses);

/**
 * @route   POST /api/market/posts/:postId/like
 */
router.post('/posts/:postId/like', marketController.toggleLike);

/**
 * @route   POST /api/market/posts/:postId/comment
 */
router.post('/posts/:postId/comment', marketController.addComment);

/**
 * @route   GET /api/market/posts/:postId/comments
 */
router.get('/posts/:postId/comments', marketController.getPostComments);

/**
 * @route   POST /api/market/business/:businessId/subscribe
 */
router.post('/business/:businessId/subscribe', marketController.toggleSubscription);

/**
 * @route   GET /api/market/business/:id
 * @desc    Get business details
 */
router.get('/business/:id', marketController.getBusinessById);

/**
 * @route   GET /api/market/orders
 */
router.get('/orders', marketController.getOrders);

/**
 * @route   POST /api/market/orders
 */
router.post('/orders', marketController.createOrder);

/**
 * @route   PUT /api/market/orders/:orderId
 */
router.put('/orders/:orderId', marketController.updateOrder);

/**
 * @route   GET /api/market/requests
 */
router.get('/requests', marketController.getRequests);

/**
 * @route   GET /api/market/inventory
 */
router.get('/inventory', marketController.getInventory);

/**
 * @route   GET /api/market/inventory/logs
 */
router.get('/inventory/logs', marketController.getInventoryLogs);

/**
 * @route   POST /api/market/inventory
 */
router.post('/inventory', marketController.updateInventory);

/**
 * @route   DELETE /api/market/inventory/:itemId
 */
router.delete('/inventory/:itemId', marketController.deleteInventoryItem);

/**
 * @route   GET /api/market/chats
 */
router.get('/chats', marketController.getBusinessChats);

/**
 * @route   GET /api/market/documents
 */
router.get('/documents', marketController.getDocuments);

/**
 * @route   POST /api/market/documents
 */
router.post('/documents', marketController.uploadDocument);

/**
 * @route   POST /api/market/quotes
 */
router.post('/quotes', marketController.createQuote);

module.exports = router;
