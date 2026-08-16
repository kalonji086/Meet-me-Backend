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

module.exports = {
  registerBusiness,
  getMyBusiness
};
