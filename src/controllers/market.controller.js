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
  const result = await query(
    `SELECT p.*, b.business_name, b.logo_url, b.category, b.national_id_number, b.status as business_status
     FROM public.market_posts p
     JOIN public.market_businesses b ON p.business_id = b.id
     WHERE b.status = 'approved'
     ORDER BY p.created_at DESC LIMIT 50`
  );

  res.json({ success: true, data: result.rows });
});

module.exports = {
  registerBusiness,
  getMyBusiness,
  getDashboardStats,
  createPost,
  getDiscoveryFeed
};
