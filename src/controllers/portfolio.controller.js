const { query } = require('../config/db');
const { asyncHandler } = require('../middleware/error.middleware');
const logger = require('../utils/logger');
const socketService = require('../services/socket.service');

/**
 * @desc    Get all portfolio data (Public)
 * @route   GET /api/portfolio/public
 */
const getPublicData = asyncHandler(async (req, res) => {
  const [skills, experiences, services] = await Promise.all([
    query('SELECT * FROM public.web_portfolio_skills ORDER BY level DESC'),
    query('SELECT * FROM public.web_portfolio_experiences ORDER BY order_index ASC, created_at DESC'),
    query('SELECT * FROM public.web_portfolio_services ORDER BY created_at ASC')
  ]);

  res.json({
    success: true,
    data: {
      skills: skills.rows,
      experiences: experiences.rows,
      services: services.rows
    }
  });
});

/**
 * @desc    Submit a quote request (Public)
 * @route   POST /api/portfolio/quote
 */
const submitQuote = asyncHandler(async (req, res) => {
  const { clientName, clientEmail, projectDescription, budget } = req.body;

  if (!clientName || !clientEmail) {
    return res.status(400).json({ success: false, error: 'Nom et Email requis' });
  }

  const result = await query(
    `INSERT INTO public.web_portfolio_quotes (client_name, client_email, project_description, budget)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [clientName, clientEmail, projectDescription, budget]
  );

  // Notify Main Admin via Socket
  const mainAdmin = await query('SELECT id FROM public.profiles WHERE email = $1', ['wecanconcept@gmail.com']);
  if (mainAdmin.rows.length > 0) {
    socketService.sendToUser(mainAdmin.rows[0].id, 'admin:new_web_quote', result.rows[0]);
  }

  res.status(201).json({
    success: true,
    message: 'Votre demande a été envoyée avec succès. Nous vous contacterons bientôt.',
    data: result.rows[0]
  });
});

// --- ADMIN CRUD FUNCTIONS ---

/**
 * @desc    Manage Skills
 */
const manageSkill = asyncHandler(async (req, res) => {
  const { action, id, name, level, icon, category } = req.body;

  if (action === 'add') {
    const resAdd = await query(
      'INSERT INTO public.web_portfolio_skills (name, level, icon, category) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, level || 50, icon, category || 'technical']
    );
    return res.json({ success: true, data: resAdd.rows[0] });
  }

  if (action === 'delete') {
    await query('DELETE FROM public.web_portfolio_skills WHERE id = $1', [id]);
    return res.json({ success: true, message: 'Compétence supprimée' });
  }

  if (action === 'update') {
    const resUpd = await query(
      'UPDATE public.web_portfolio_skills SET name = $1, level = $2, icon = $3, category = $4 WHERE id = $5 RETURNING *',
      [name, level, icon, category, id]
    );
    return res.json({ success: true, data: resUpd.rows[0] });
  }

  res.status(400).json({ success: false, error: 'Action invalide' });
});

/**
 * @desc    Manage Experiences
 */
const manageExperience = asyncHandler(async (req, res) => {
  const { action, id, title, company, period, description, orderIndex } = req.body;

  if (action === 'add') {
    const resAdd = await query(
      'INSERT INTO public.web_portfolio_experiences (title, company, period, description, order_index) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [title, company, period, description, orderIndex || 0]
    );
    return res.json({ success: true, data: resAdd.rows[0] });
  }

  if (action === 'delete') {
    await query('DELETE FROM public.web_portfolio_experiences WHERE id = $1', [id]);
    return res.json({ success: true, message: 'Expérience supprimée' });
  }

  res.status(400).json({ success: false, error: 'Action invalide' });
});

/**
 * @desc    Manage Services
 */
const manageService = asyncHandler(async (req, res) => {
  const { action, id, title, description, priceRange, icon } = req.body;

  if (action === 'add') {
    const resAdd = await query(
      'INSERT INTO public.web_portfolio_services (title, description, price_range, icon) VALUES ($1, $2, $3, $4) RETURNING *',
      [title, description, priceRange, icon]
    );
    return res.json({ success: true, data: resAdd.rows[0] });
  }

  if (action === 'delete') {
    await query('DELETE FROM public.web_portfolio_services WHERE id = $1', [id]);
    return res.json({ success: true, message: 'Service supprimé' });
  }

  res.status(400).json({ success: false, error: 'Action invalide' });
});

/**
 * @desc    Get all quotes (Admin)
 */
const getQuotes = asyncHandler(async (req, res) => {
  const result = await query('SELECT * FROM public.web_portfolio_quotes ORDER BY created_at DESC');
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Update quote status
 */
const updateQuoteStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  await query('UPDATE public.web_portfolio_quotes SET status = $1 WHERE id = $2', [status, id]);
  res.json({ success: true, message: 'Statut mis à jour' });
});

module.exports = {
  getPublicData,
  submitQuote,
  manageSkill,
  manageExperience,
  manageService,
  getQuotes,
  updateQuoteStatus
};
