const { query } = require('../config/db');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/error.middleware');

/**
 * @desc    Submit business registration for Market
 * @route   POST /api/market/register
 * @access  Private
 */
const registerBusiness = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const {
    category,
    businessName,
    shortDescription,
    fullDescription,
    logoUrl,
    bannerUrl,
    contactInfo,
    addressCity,
    addressCommune,
    addressProvince,
    addressQuarter,
    addressPostalCode,
    idCardUrl,
    nationalIdNumber,
    rccmNumber,
    employeeCount,
    capitalAmount
  } = req.body;

  // Validation minimaliste (à renforcer selon les besoins)
  if (!category || !businessName) {
    return res.status(400).json({ success: false, error: 'La catégorie et le nom du business sont requis' });
  }

  // Vérifier si déjà enregistré
  const existing = await query('SELECT id FROM public.market_businesses WHERE user_id = $1', [userId]);
  if (existing.rows.length > 0) {
    return res.status(400).json({ success: false, error: 'Vous avez déjà une demande en cours ou un business enregistré' });
  }

  const result = await query(
    `INSERT INTO public.market_businesses (
      user_id, category, business_name, short_description, full_description,
      logo_url, banner_url, contact_info, address_city, address_commune,
      address_province, address_quarter, address_postal_code, id_card_url,
      national_id_number, rccm_number, employee_count, capital_amount
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    RETURNING *`,
    [
      userId, category, businessName, shortDescription, fullDescription,
      logoUrl, bannerUrl, contactInfo, addressCity, addressCommune,
      addressProvince, addressQuarter, addressPostalCode, idCardUrl,
      nationalIdNumber, rccmNumber, employeeCount, capitalAmount
    ]
  );

  res.status(201).json({
    success: true,
    data: result.rows[0],
    message: 'Votre demande a été soumise avec succès et est en attente de vérification.'
  });
});

/**
 * @desc    Get current user's business status
 * @route   GET /api/market/my-business
 * @access  Private
 */
const getMyBusiness = asyncHandler(async (req, res) => {
  const userId = req.userId;

  const result = await query(
    'SELECT * FROM public.market_businesses WHERE user_id = $1',
    [userId]
  );

  res.json({
    success: true,
    data: result.rows[0] || null
  });
});

/**
 * @desc    Get dashboard statistics for a business
 */
const getDashboardStats = asyncHandler(async (req, res) => {
  const userId = req.userId;

  const businessRes = await query('SELECT * FROM public.market_businesses WHERE user_id = $1', [userId]);
  if (businessRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Business non trouvé' });

  const business = businessRes.rows[0];
  const bId = business.id;

  // Stats de base
  const postsCount = await query('SELECT COUNT(*) FROM public.market_posts WHERE business_id = $1', [bId]);
  const reviewsCount = await query('SELECT COUNT(*) FROM public.market_reviews WHERE business_id = $1', [bId]);
  const avgRating = await query('SELECT AVG(rating) FROM public.market_reviews WHERE business_id = $1', [bId]);
  const followersCount = await query('SELECT COUNT(*) FROM public.market_subscriptions WHERE business_id = $1', [bId]);

  let specificStats = {};

  if (business.category === 'Boutique') {
    const pendingOrders = await query('SELECT COUNT(*) FROM public.market_orders WHERE business_id = $1 AND status = \'pending\'', [bId]);
    const totalSales = await query('SELECT SUM(total_amount) FROM public.market_orders WHERE business_id = $1 AND status = \'delivered\'', [bId]);
    specificStats = {
      pendingOrders: parseInt(pendingOrders.rows[0].count),
      totalSales: parseFloat(totalSales.rows[0].sum || 0)
    };
  } else {
    const pendingRequests = await query('SELECT COUNT(*) FROM public.market_requests WHERE business_id = $1 AND status = \'pending\'', [bId]);
    specificStats = {
      pendingRequests: parseInt(pendingRequests.rows[0].count)
    };
  }

  res.json({
    success: true,
    data: {
      business,
      stats: {
        posts: parseInt(postsCount.rows[0].count),
        reviews: parseInt(reviewsCount.rows[0].count),
        rating: parseFloat(avgRating.rows[0].avg || 0),
        followers: parseInt(followersCount.rows[0].count),
        ...specificStats
      }
    }
  });
});

/**
 * @desc    Create a new market post
 */
const createPost = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { title, content, images, type } = req.body;

  const business = await query('SELECT id FROM public.market_businesses WHERE user_id = $1', [userId]);
  if (business.rows.length === 0) return res.status(403).json({ success: false, error: 'Accès refusé' });

  const result = await query(
    'INSERT INTO public.market_posts (business_id, title, content, images, type) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [business.rows[0].id, title, content, images || [], type || 'announcement']
  );

  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Get discovery feed (Third Phase)
 */
const getDiscoveryFeed = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const result = await query(
    `SELECT p.*, b.business_name, b.logo_url, b.category, b.national_id_number, b.status as business_status,
     (SELECT COUNT(*) FROM public.market_post_likes WHERE post_id = p.id) as likes_count,
     (SELECT COUNT(*) FROM public.market_post_comments WHERE post_id = p.id) as comments_count,
     EXISTS(SELECT 1 FROM public.market_post_likes WHERE post_id = p.id AND user_id = $1) as is_liked
     FROM public.market_posts p
     JOIN public.market_businesses b ON p.business_id = b.id
     WHERE b.status = 'approved'
     ORDER BY p.created_at DESC LIMIT 50`,
    [userId]
  );

  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Toggle like on a post
 */
const toggleLike = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { postId } = req.params;

  const existing = await query('SELECT id FROM public.market_post_likes WHERE post_id = $1 AND user_id = $2', [postId, userId]);

  let liked = false;
  if (existing.rows.length > 0) {
    await query('DELETE FROM public.market_post_likes WHERE id = $1', [existing.rows[0].id]);
  } else {
    await query('INSERT INTO public.market_post_likes (post_id, user_id) VALUES ($1, $2)', [postId, userId]);
    liked = true;
  }

  // Real-time update via Socket
  const postRes = await query('SELECT business_id FROM public.market_posts WHERE id = $1', [postId]);
  if (postRes.rows.length > 0) {
    const bizRes = await query('SELECT user_id FROM public.market_businesses WHERE id = $1', [postRes.rows[0].business_id]);
    const socketService = require('../services/socket.service');
    socketService.broadcast('market:post_update', { postId, likesCount: liked ? 1 : -1 });
    if (liked) {
       socketService.sendToUser(bizRes.rows[0].user_id, 'market:new_like', { postId });
    }
  }

  res.json({ success: true, liked });
});

/**
 * @desc    Add a comment to a post
 */
const addComment = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { postId } = req.params;
  const { content } = req.body;

  const result = await query(
    'INSERT INTO public.market_post_comments (post_id, user_id, content) VALUES ($1, $2, $3) RETURNING *',
    [postId, userId, content]
  );

  // Real-time update
  const socketService = require('../services/socket.service');
  socketService.broadcast('market:new_comment_global', { postId, comment: result.rows[0] });

  const postRes = await query('SELECT business_id FROM public.market_posts WHERE id = $1', [postId]);
  const bizRes = await query('SELECT user_id FROM public.market_businesses WHERE id = $1', [postRes.rows[0].business_id]);
  socketService.sendToUser(bizRes.rows[0].user_id, 'market:new_comment', { postId, content });

  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Toggle subscription to a business
 */
const toggleSubscription = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { businessId } = req.params;

  const existing = await query('SELECT id FROM public.market_subscriptions WHERE business_id = $1 AND user_id = $2', [businessId, userId]);

  let subscribed = false;
  if (existing.rows.length > 0) {
    await query('DELETE FROM public.market_subscriptions WHERE id = $1', [existing.rows[0].id]);
  } else {
    await query('INSERT INTO public.market_subscriptions (business_id, user_id) VALUES ($1, $2)', [businessId, userId]);
    subscribed = true;
  }

  // Notify owner
  const bizRes = await query('SELECT user_id FROM public.market_businesses WHERE id = $1', [businessId]);
  const socketService = require('../services/socket.service');
  socketService.sendToUser(bizRes.rows[0].user_id, 'market:new_follower', { subscribed });

  res.json({ success: true, subscribed });
});

/**
 * @desc    Get business details by ID
 */
const getBusinessById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.userId;

  const result = await query(
    `SELECT id, user_id, category, business_name, short_description, full_description, logo_url, banner_url, contact_info, address_city, address_commune, address_province, address_quarter, national_id_number, status,
     (SELECT COUNT(*) FROM public.market_subscriptions WHERE business_id = $1) as followers_count,
     EXISTS(SELECT 1 FROM public.market_subscriptions WHERE business_id = $1 AND user_id = $2) as is_subscribed
     FROM public.market_businesses WHERE id = $1`,
    [id, userId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ success: false, error: 'Business non trouvé' });
  }

  res.json({
    success: true,
    data: result.rows[0]
  });
});

/**
 * @desc    Get business orders (for Boutiques)
 */
const getOrders = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const business = await query('SELECT id FROM public.market_businesses WHERE user_id = $1', [userId]);
  if (business.rows.length === 0) return res.status(403).json({ success: false, error: 'Accès refusé' });

  const result = await query(
    `SELECT o.*, p.full_name as customer_name, p.avatar_url as customer_avatar
     FROM public.market_orders o
     JOIN public.profiles p ON o.user_id = p.id
     WHERE o.business_id = $1 ORDER BY o.created_at DESC`,
    [business.rows[0].id]
  );

  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Get business quote requests (for Artisans)
 */
const getRequests = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const business = await query('SELECT id FROM public.market_businesses WHERE user_id = $1', [userId]);
  if (business.rows.length === 0) return res.status(403).json({ success: false, error: 'Accès refusé' });

  const result = await query(
    `SELECT r.*, p.full_name as customer_name, p.avatar_url as customer_avatar
     FROM public.market_requests r
     JOIN public.profiles p ON r.user_id = p.id
     WHERE r.business_id = $1 ORDER BY r.created_at DESC`,
    [business.rows[0].id]
  );

  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Get business inventory (for Boutiques)
 */
const getInventory = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const business = await query('SELECT id FROM public.market_businesses WHERE user_id = $1', [userId]);
  if (business.rows.length === 0) return res.status(403).json({ success: false, error: 'Accès refusé' });

  const result = await query(
    'SELECT * FROM public.market_inventory WHERE business_id = $1 ORDER BY item_name ASC',
    [business.rows[0].id]
  );

  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Add or update inventory item
 */
const updateInventory = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { itemName, quantity, price, action } = req.body; // action: 'add', 'remove', 'create'

  const business = await query('SELECT id FROM public.market_businesses WHERE user_id = $1', [userId]);
  if (business.rows.length === 0) return res.status(403).json({ success: false, error: 'Accès refusé' });
  const bId = business.rows[0].id;

  const existing = await query('SELECT id, quantity FROM public.market_inventory WHERE business_id = $1 AND item_name = $2', [bId, itemName]);

  if (action === 'create' || existing.rows.length === 0) {
    await query(
      'INSERT INTO public.market_inventory (business_id, item_name, quantity, price) VALUES ($1, $2, $3, $4)',
      [bId, itemName, quantity, price || 0]
    );
  } else {
    const newQty = action === 'add' ? existing.rows[0].quantity + quantity : Math.max(0, existing.rows[0].quantity - quantity);
    await query(
      'UPDATE public.market_inventory SET quantity = $1, updated_at = NOW() WHERE id = $2',
      [newQty, existing.rows[0].id]
    );
  }

  res.json({ success: true });
});

/**
 * @desc    Get business documents (Portfolio)
 */
const getDocuments = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const business = await query('SELECT id FROM public.market_businesses WHERE user_id = $1', [userId]);
  if (business.rows.length === 0) return res.status(403).json({ success: false, error: 'Accès refusé' });

  const result = await query(
    'SELECT * FROM public.market_documents WHERE business_id = $1 ORDER BY created_at DESC',
    [business.rows[0].id]
  );

  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Upload a business document
 */
const uploadDocument = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { name, fileUrl, fileSize, mimeType } = req.body;

  const business = await query('SELECT id FROM public.market_businesses WHERE user_id = $1', [userId]);
  if (business.rows.length === 0) return res.status(403).json({ success: false, error: 'Accès refusé' });

  const result = await query(
    'INSERT INTO public.market_documents (business_id, name, file_url, file_size, mime_type) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [business.rows[0].id, name, fileUrl, fileSize, mimeType]
  );

  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Create a quote (Devis)
 */
const createQuote = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { requestId, customerId, title, amount, fileUrl, items, status = 'sent' } = req.body;

  const business = await query('SELECT id FROM public.market_businesses WHERE user_id = $1', [userId]);
  if (business.rows.length === 0) return res.status(403).json({ success: false, error: 'Accès refusé' });

  const result = await query(
    `INSERT INTO public.market_quotes (business_id, request_id, customer_id, title, amount, file_url, items, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [business.rows[0].id, requestId, customerId, title, amount, fileUrl, items || [], status]
  );

  // Si c'est en réponse à une requête, on peut mettre à jour le statut de la requête
  if (requestId) {
    await query('UPDATE public.market_requests SET status = $1 WHERE id = $2', ['accepted', requestId]);
  }

  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Get business chats
 */
const getBusinessChats = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const result = await query(
    `SELECT c.*, p.full_name as other_name, p.avatar_url as other_avatar,
     (SELECT content FROM public.messages m WHERE m.chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
     (SELECT created_at FROM public.messages m WHERE m.chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_at
     FROM public.chats c
     JOIN public.chat_participants cp1 ON c.id = cp1.chat_id AND cp1.user_id = $1
     JOIN public.chat_participants cp2 ON c.id = cp2.chat_id AND cp2.user_id != $1
     JOIN public.profiles p ON cp2.user_id = p.id
     WHERE c.type = 'private'
     ORDER BY c.last_message_at DESC NULLS LAST LIMIT 20`,
    [userId]
  );

  res.json({ success: true, data: result.rows });
});

module.exports = {
  registerBusiness,
  getMyBusiness,
  getDashboardStats,
  createPost,
  getDiscoveryFeed,
  getBusinessById,
  getOrders,
  getRequests,
  getInventory,
  getBusinessChats,
  getDocuments,
  uploadDocument,
  createQuote
};
