const { query } = require('../config/db');
const { asyncHandler } = require('../middleware/error.middleware');
const logger = require('../utils/logger');
const socketService = require('../services/socket.service');

const mailService = require('../services/mail.service');

/**
 * Helper: Get the portfolio ID managed by the current user
 */
const getManagedPortfolioId = async (req) => {
  if (req.user.is_global_admin || (req.user.is_delegated && req.user.allowed_modules && req.user.allowed_modules.includes('portfolio'))) {
    return '00000000-0000-0000-0000-000000000000';
  }
  const res = await query('SELECT id FROM public.web_portfolios WHERE user_id = $1 LIMIT 1', [req.userId]);
  return res.rows[0]?.id || null;
};

/**
 * @desc    Get all portfolio data (Public)
 */
const getPublicData = asyncHandler(async (req, res) => {
  const { slug } = req.params;
  const portfolio = await query("SELECT * FROM public.web_portfolios WHERE slug = $1 AND status = 'approved'", [slug || 'together']);
  if (portfolio.rows.length === 0) return res.status(404).json({ error: 'Portfolio non trouvé' });

  const portfolioId = portfolio.rows[0].id;
  const [skills, experiences, services, team, profile, pages] = await Promise.all([
    query('SELECT * FROM public.web_portfolio_skills WHERE portfolio_id = $1 ORDER BY level DESC', [portfolioId]),
    query('SELECT * FROM public.web_portfolio_experiences WHERE portfolio_id = $1 ORDER BY order_index ASC', [portfolioId]),
    query('SELECT * FROM public.web_portfolio_services WHERE portfolio_id = $1 ORDER BY created_at ASC', [portfolioId]),
    query('SELECT * FROM public.web_portfolio_team WHERE portfolio_id = $1 ORDER BY order_index ASC', [portfolioId]),
    query('SELECT * FROM public.web_portfolio_profile WHERE portfolio_id = $1', [portfolioId]),
    query('SELECT * FROM public.web_portfolio_pages WHERE portfolio_id = $1 AND is_active = TRUE', [portfolioId])
  ]);

  res.json({
    success: true,
    data: {
      config: portfolio.rows[0],
      skills: skills.rows,
      experiences: experiences.rows,
      services: services.rows,
      team: team.rows,
      profile: profile.rows[0],
      pages: pages.rows
    }
  });
});

const submitPortfolioRequest = asyncHandler(async (req, res) => {
  const { fullName, email, profession, desiredSlug, preferredColor, motivation, enabledModules, logoUrl } = req.body;
  const userId = req.user ? req.user.id : null;

  const check = await query('SELECT id FROM public.web_portfolios WHERE slug = $1', [desiredSlug]);
  if (check.rows.length > 0) return res.status(400).json({ error: 'Cet identifiant (URL) est déjà utilisé.' });

  const result = await query(
    `INSERT INTO public.web_portfolio_requests (user_id, full_name, email, profession, desired_slug, preferred_color, motivation, enabled_modules, logo_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [userId, fullName, email, profession, desiredSlug, preferredColor, motivation, enabledModules, logoUrl]
  );

  res.status(201).json({ success: true, data: result.rows[0] });
});

const approvePortfolioRequest = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { action } = req.body; // 'approved' or 'rejected'

  const reqRes = await query('SELECT * FROM public.web_portfolio_requests WHERE id = $1', [id]);
  if (reqRes.rows.length === 0) return res.status(404).json({ error: 'Demande introuvable.' });
  const request = reqRes.rows[0];

  if (action === 'approved') {
    const ownerId = request.user_id || '00000000-0000-0000-0000-000000000000';
    // 1. Create Portfolio
    const portRes = await query(
      `INSERT INTO public.web_portfolios (user_id, slug, title, owner_name, theme_color, logo_url, enabled_modules, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved') RETURNING id`,
      [ownerId, request.desired_slug, `Portfolio de ${request.full_name}`, request.full_name, request.preferred_color, request.logo_url, request.enabled_modules]
    );

    const portfolioId = portRes.rows[0].id;
    const portfolioTitle = `Portfolio de ${request.full_name}`;

    // 2. Create Profile entry
    await query(
      `INSERT INTO public.web_portfolio_profile (portfolio_id, logo_url, about_description)
       VALUES ($1, $2, $3)`,
      [portfolioId, request.logo_url, request.motivation || `Bienvenue sur le portfolio de ${request.full_name}.`]
    );

    // Update request status
    await query('UPDATE public.web_portfolio_requests SET status = \'approved\' WHERE id = $1', [id]);

    // Handle temporary account if user didn't exist? (Optional, based on need)
    const tempPassword = Math.random().toString(36).slice(-8);

    // 3. Send Email Notification
    await mailService.sendPortfolioApprovalEmail(
        request.email,
        request.full_name,
        portfolioTitle,
        request.desired_slug,
        request.preferred_color || '#06b6d4',
        tempPassword // Pass temp password to email
    );

    socketService.emitToUser(ownerId, 'portfolio:request_approved', { slug: request.desired_slug });
  } else {
    await query('UPDATE public.web_portfolio_requests SET status = \'rejected\' WHERE id = $1', [id]);
  }

  res.json({ success: true, message: `Demande de portfolio ${action}.` });
});

/**
 * @desc    Admin: Delete Portfolio Request
 */
const deletePortfolioRequest = asyncHandler(async (req, res) => {
    const { id } = req.params;
    await query('DELETE FROM public.web_portfolio_requests WHERE id = $1', [id]);
    res.json({ success: true, message: 'Demande supprimée.' });
});

/**
 * @desc    Admin: Get single portfolio request detail
 */
const getPortfolioRequestDetail = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await query('SELECT * FROM public.web_portfolio_requests WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Demande introuvable.' });
    res.json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Admin: Delete active portfolio
 */
const deletePortfolio = asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Manual cascading cleanup for safety
    await query('DELETE FROM public.web_portfolio_profile WHERE portfolio_id = $1', [id]);
    await query('DELETE FROM public.web_portfolio_skills WHERE portfolio_id = $1', [id]);
    await query('DELETE FROM public.web_portfolio_experiences WHERE portfolio_id = $1', [id]);
    await query('DELETE FROM public.web_portfolio_services WHERE portfolio_id = $1', [id]);
    await query('DELETE FROM public.web_portfolio_team WHERE portfolio_id = $1', [id]);
    await query('DELETE FROM public.web_portfolio_pages WHERE portfolio_id = $1', [id]);
    await query('DELETE FROM public.web_portfolio_quotes WHERE portfolio_id = $1', [id]);
    await query('DELETE FROM public.web_portfolio_announcements WHERE portfolio_id = $1', [id]);

    await query('DELETE FROM public.web_portfolios WHERE id = $1', [id]);
    res.json({ success: true, message: 'Portfolio et toutes ses données supprimés définitivement.' });
});

/**
 * @desc    Get all portfolio requests (Admin)
 */
const getPortfolioRequests = asyncHandler(async (req, res) => {
  const result = await query('SELECT * FROM public.web_portfolio_requests ORDER BY created_at DESC');
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Get all portfolios (Admin)
 */
const getAllPortfolios = asyncHandler(async (req, res) => {
  const result = await query('SELECT * FROM public.web_portfolios ORDER BY created_at DESC');
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Toggle Portfolio Status
 */
const togglePortfolioStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  await query('UPDATE public.web_portfolios SET status = $1, updated_at = NOW() WHERE id = $2', [status, id]);
  res.json({ success: true, message: 'Statut du portfolio mis à jour.' });
});

/**
 * @desc    Request a tracking code by email
 */
const requestTrackingCode = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis' });

  // Vérifier si des devis existent pour cet email pour éviter de spammer
  const check = await query('SELECT count(*) FROM public.web_portfolio_quotes WHERE client_email = $1', [email]);
  if (parseInt(check.rows[0].count) === 0) {
    return res.status(404).json({ error: 'Aucune demande trouvée pour cet email.' });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 30 * 60000); // 30 mins

  await query(
    'INSERT INTO public.web_portfolio_tracking_codes (email, code, expires_at) VALUES ($1, $2, $3)',
    [email, code, expiresAt]
  );

  await mailService.sendTrackingCodeEmail(email, code);
  res.json({ success: true, message: 'Code envoyé par email.' });
});

/**
 * @desc    Client tracking quotes (Secured with code)
 */
const getClientQuotes = asyncHandler(async (req, res) => {
  const { email, code, quoteId } = req.query;

  if (!email || !code) return res.status(400).json({ error: 'Email et code requis' });

  // Vérifier le code
  const codeCheck = await query(
    'SELECT * FROM public.web_portfolio_tracking_codes WHERE email = $1 AND code = $2 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
    [email, code]
  );

  if (codeCheck.rows.length === 0) {
    return res.status(401).json({ error: 'Code invalide ou expiré.' });
  }

  const result = await query(
    'SELECT * FROM public.web_portfolio_quotes WHERE client_email = $1 AND (id::text = $2 OR $2 IS NULL) ORDER BY created_at DESC',
    [email, quoteId]
  );
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Handle chat messages
 */
const handleChat = asyncHandler(async (req, res) => {
  const { quoteId } = req.params;
  const { content, senderType, email, code } = req.body;

  // Sécurité pour les visiteurs
  if (!req.user && senderType === 'client') {
    if (!email || !code) return res.status(401).json({ error: 'Identification requise' });
    const codeCheck = await query('SELECT 1 FROM public.web_portfolio_tracking_codes WHERE email = $1 AND code = $2 AND expires_at > NOW()', [email, code]);
    if (codeCheck.rows.length === 0) return res.status(401).json({ error: 'Session expirée' });
    const ownership = await query('SELECT 1 FROM public.web_portfolio_quotes WHERE id = $1 AND client_email = $2', [quoteId, email]);
    if (ownership.rows.length === 0) return res.status(403).json({ error: 'Accès refusé' });
  }

  if (req.method === 'POST') {
    if (!content) return res.status(400).json({ error: 'Message vide' });
    const result = await query(
      'INSERT INTO public.web_portfolio_messages (quote_id, sender_type, content) VALUES ($1, $2, $3) RETURNING *',
      [quoteId, senderType || 'client', content]
    );
    socketService.broadcast('portfolio:new_message', { ...result.rows[0], quoteId });
    return res.json({ success: true, data: result.rows[0] });
  }

  const messages = await query('SELECT * FROM public.web_portfolio_messages WHERE quote_id = $1 ORDER BY created_at ASC', [quoteId]);
  res.json({ success: true, data: messages.rows });
});

/**
 * @desc    Admin reply to quote
 */
const replyToQuote = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, message, price, duration } = req.body;
  const result = await query(
    `UPDATE public.web_portfolio_quotes
     SET status = $1, admin_reply_message = $2, final_price = $3, estimated_duration = $4, updated_at = NOW()
     WHERE id = $5 RETURNING *`,
    [status, message, price, duration, id]
  );
  socketService.broadcast('portfolio:quote_updated', result.rows[0]);
  res.json({ success: true, message: 'Réponse envoyée au client.' });
});

const updateContract = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { content } = req.body;
  await query('UPDATE public.web_portfolio_quotes SET contract_content = $1, updated_at = NOW() WHERE id = $2', [content, id]);
  socketService.broadcast('portfolio:contract_updated', { quoteId: id, content });
  res.json({ success: true, message: 'Contrat mis à jour.' });
});

const signContract = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { email, code } = req.body;

  if (!req.user) {
    if (!email || !code) return res.status(401).json({ error: 'Identification requise' });
    const codeCheck = await query('SELECT 1 FROM public.web_portfolio_tracking_codes WHERE email = $1 AND code = $2 AND expires_at > NOW()', [email, code]);
    if (codeCheck.rows.length === 0) return res.status(401).json({ error: 'Session expirée' });
  }

  const result = await query(
    `UPDATE public.web_portfolio_quotes
     SET contract_signed_at = NOW(), is_contract_archived = TRUE, status = 'signed', updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id]
  );
  socketService.broadcast('portfolio:contract_signed', result.rows[0]);
  res.json({ success: true, message: 'Contrat signé !' });
});

const updateSpecs = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { specs, email, code } = req.body;

  if (!req.user) {
    if (!email || !code) return res.status(401).json({ error: 'Identification requise' });
    const codeCheck = await query('SELECT 1 FROM public.web_portfolio_tracking_codes WHERE email = $1 AND code = $2 AND expires_at > NOW()', [email, code]);
    if (codeCheck.rows.length === 0) return res.status(401).json({ error: 'Session expirée' });
  }

  await query('UPDATE public.web_portfolio_quotes SET specifications = $1, updated_at = NOW() WHERE id = $2', [specs, id]);
  socketService.broadcast('portfolio:specs_updated', { quoteId: id, specs });
  res.json({ success: true, message: 'Cahier des charges mis à jour.' });
});

const submitQuote = asyncHandler(async (req, res) => {
  const { clientName, clientEmail, projectDescription, budget, specifications, portfolioId } = req.body;
  if (!clientName || !clientEmail) return res.status(400).json({ error: 'Nom et Email requis' });
  if (portfolioId) {
    const portfolio = await query("SELECT id FROM public.web_portfolios WHERE id = $1 AND status = 'approved'", [portfolioId]);
    if (portfolio.rows.length === 0) return res.status(400).json({ error: 'Portfolio invalide' });
  }
  const result = await query(
    `INSERT INTO public.web_portfolio_quotes (client_name, client_email, project_description, budget, specifications, portfolio_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [clientName, clientEmail, projectDescription, budget, specifications, portfolioId || '00000000-0000-0000-0000-000000000000']
  );

  const mainAdmin = await query('SELECT id FROM public.profiles WHERE email = $1', ['wecanconcept@gmail.com']);
  if (mainAdmin.rows.length > 0) {
      socketService.sendToUser(mainAdmin.rows[0].id, 'admin:new_web_quote', result.rows[0]);
  }

  res.status(201).json({ success: true, data: result.rows[0] });
});

// --- NEW COMMUNITY SOCIAL LOGIC ---

const getCommunityPosts = asyncHandler(async (req, res) => {
    const { slug } = req.params;
    const portfolio = await query('SELECT id FROM public.web_portfolios WHERE slug = $1', [slug || 'together']);
    if (portfolio.rows.length === 0) return res.status(404).json({ error: 'Portfolio non trouvé' });
    const pId = portfolio.rows[0].id;

    const result = await query(`
        SELECT p.*,
        (SELECT count(*) FROM public.community_post_likes WHERE post_id = p.id) as likes_count,
        (SELECT count(*) FROM public.community_post_comments WHERE post_id = p.id) as comments_count
        FROM public.community_posts p
        WHERE p.portfolio_id = $1
        ORDER BY p.created_at DESC`, [pId]);
    res.json({ success: true, data: result.rows });
});

const createCommunityPost = asyncHandler(async (req, res) => {
    const { slug, content, imageUrl, authorName } = req.body;
    const portfolio = await query('SELECT id FROM public.web_portfolios WHERE slug = $1', [slug || 'together']);
    if (portfolio.rows.length === 0) return res.status(404).json({ error: 'Portfolio non trouvé' });
    const pId = portfolio.rows[0].id;

    const result = await query(
        `INSERT INTO public.community_posts (portfolio_id, author_name, content, image_url)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [pId, authorName || 'Visiteur', content, imageUrl]
    );

    socketService.broadcast('community:new_post', { ...result.rows[0], slug });
    res.json({ success: true, data: result.rows[0] });
});

const likeCommunityPost = asyncHandler(async (req, res) => {
    const { postId } = req.params;
    const userId = req.userId || '00000000-0000-0000-0000-000000000000'; // Fallback for public likes if needed, but best with auth

    await query('INSERT INTO public.community_post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [postId, userId]);
    const count = await query('SELECT count(*) FROM public.community_post_likes WHERE post_id = $1', [postId]);

    socketService.broadcast('community:post_liked', { postId, likes: count.rows[0].count });
    res.json({ success: true, likes: count.rows[0].count });
});

const commentCommunityPost = asyncHandler(async (req, res) => {
    const { postId } = req.params;
    const { content, authorName } = req.body;

    const result = await query(
        'INSERT INTO public.community_post_comments (post_id, author_name, content) VALUES ($1, $2, $3) RETURNING *',
        [postId, authorName || 'Anonyme', content]
    );

    socketService.broadcast('community:new_comment', { postId, comment: result.rows[0] });
    res.json({ success: true, data: result.rows[0] });
});

const submitCommunitySupport = asyncHandler(async (req, res) => {
    const { email, name, subject, message } = req.body;
    // Create an appeal record for admin
    const result = await query(
        `INSERT INTO public.appeals (contact_email, type, category, reason, status)
         VALUES ($1, 'helpdesk', 'support_community', $2, 'pending') RETURNING *`,
        [email, `[${subject}] ${message}`]
    );

    const mainAdmin = await query('SELECT id FROM public.profiles WHERE email = $1', ['wecanconcept@gmail.com']);
    if (mainAdmin.rows.length > 0) {
        socketService.sendToUser(mainAdmin.rows[0].id, 'admin:new_appeal', result.rows[0]);
    }

    res.json({ success: true, message: 'Votre ticket de support a été créé. Un administrateur vous répondra par mail.' });
});

// --- ADMIN CRUD ---

const manageSkill = asyncHandler(async (req, res) => {
  const { action, id, name, level, icon, imageUrl, category, description, yearsExperience } = req.body;
  const portfolioId = await getManagedPortfolioId(req);
  if (!portfolioId) return res.status(403).json({ error: 'Aucun portfolio associé à ce compte.' });

  if (action === 'add') {
    const resAdd = await query(
      'INSERT INTO public.web_portfolio_skills (name, level, icon, image_url, category, description, years_experience, portfolio_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [name, level || 50, icon || null, imageUrl || null, category || 'technical', description || null, yearsExperience || 1, portfolioId]
    );
    return res.json({ success: true, data: resAdd.rows[0] });
  }
  if (action === 'update') {
    const resUp = await query(
      `UPDATE public.web_portfolio_skills
       SET name = COALESCE($1, name), level = COALESCE($2, level), icon = COALESCE($3, icon),
           image_url = COALESCE($4, image_url), category = COALESCE($5, category),
           description = COALESCE($6, description), years_experience = COALESCE($7, years_experience)
       WHERE id = $8 AND portfolio_id = $9 RETURNING *`,
      [name, level, icon, imageUrl, category, description, yearsExperience, id, portfolioId]
    );
    return res.json({ success: true, data: resUp.rows[0] });
  }
  if (action === 'delete') {
    await query('DELETE FROM public.web_portfolio_skills WHERE id = $1 AND portfolio_id = $2', [id, portfolioId]);
    return res.json({ success: true });
  }
  res.status(400).json({ error: 'Action invalide' });
});

const manageExperience = asyncHandler(async (req, res) => {
  const { action, id, title, company, period, description, logoUrl, orderIndex, projectUrl, isInProgress, projectStatus, downloadsCount, starsCount } = req.body;
  const portfolioId = await getManagedPortfolioId(req);
  if (!portfolioId) return res.status(403).json({ error: 'Accès refusé.' });

  if (action === 'add') {
    const resAdd = await query(
      `INSERT INTO public.web_portfolio_experiences (title, company, period, description, logo_url, order_index, portfolio_id, project_url, is_in_progress, project_status, downloads_count, stars_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [title, company, period, description, logoUrl, orderIndex || 0, portfolioId, projectUrl, isInProgress || false, projectStatus || 'published', downloadsCount || '0', starsCount || '5.0']
    );
    return res.json({ success: true, data: resAdd.rows[0] });
  }
  if (action === 'update') {
    const resUp = await query(
      `UPDATE public.web_portfolio_experiences
       SET title = COALESCE($1, title), company = COALESCE($2, company), period = COALESCE($3, period),
           description = COALESCE($4, description), logo_url = COALESCE($5, logo_url), order_index = COALESCE($6, order_index),
           project_url = COALESCE($7, project_url), is_in_progress = COALESCE($8, is_in_progress),
           project_status = COALESCE($9, project_status), downloads_count = COALESCE($10, downloads_count), stars_count = COALESCE($11, stars_count)
       WHERE id = $12 AND portfolio_id = $13 RETURNING *`,
      [title, company, period, description, logoUrl, orderIndex, projectUrl, isInProgress, projectStatus, downloadsCount, starsCount, id, portfolioId]
    );
    return res.json({ success: true, data: resUp.rows[0] });
  }
  if (action === 'delete') {
    await query('DELETE FROM public.web_portfolio_experiences WHERE id = $1 AND portfolio_id = $2', [id, portfolioId]);
    return res.json({ success: true });
  }
  res.status(400).json({ error: 'Action invalide' });
});

const manageService = asyncHandler(async (req, res) => {
  const { action, id, title, description, priceRange, icon, imageUrl } = req.body;
  const portfolioId = await getManagedPortfolioId(req);
  if (!portfolioId) return res.status(403).json({ error: 'Accès refusé.' });

  if (action === 'add') {
    const resAdd = await query(
      'INSERT INTO public.web_portfolio_services (title, description, price_range, icon, image_url, portfolio_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [title, description, priceRange, icon || null, imageUrl || null, portfolioId]
    );
    return res.json({ success: true, data: resAdd.rows[0] });
  }
  if (action === 'delete') {
    await query('DELETE FROM public.web_portfolio_services WHERE id = $1 AND portfolio_id = $2', [id, portfolioId]);
    return res.json({ success: true });
  }
  res.status(400).json({ error: 'Action invalide' });
});

const manageTeam = asyncHandler(async (req, res) => {
  const { action, id, name, role, bio, imageUrl, orderIndex } = req.body;
  const portfolioId = await getManagedPortfolioId(req);
  if (!portfolioId) return res.status(403).json({ error: 'Accès refusé.' });

  if (action === 'add') {
    const resAdd = await query(
      'INSERT INTO public.web_portfolio_team (name, role, bio, image_url, order_index, portfolio_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [name, role, bio, imageUrl || null, orderIndex || 0, portfolioId]
    );
    return res.json({ success: true, data: resAdd.rows[0] });
  }
  if (action === 'update') {
    const resUp = await query(
      `UPDATE public.web_portfolio_team
       SET name = COALESCE($1, name), role = COALESCE($2, role), bio = COALESCE($3, bio),
           image_url = COALESCE($4, image_url), order_index = COALESCE($5, order_index)
       WHERE id = $6 AND portfolio_id = $7 RETURNING *`,
      [name, role, bio, imageUrl, orderIndex, id, portfolioId]
    );
    return res.json({ success: true, data: resUp.rows[0] });
  }
  if (action === 'delete') {
    await query('DELETE FROM public.web_portfolio_team WHERE id = $1 AND portfolio_id = $2', [id, portfolioId]);
    return res.json({ success: true });
  }
  res.status(400).json({ error: 'Action invalide' });
});

const getQuotes = asyncHandler(async (req, res) => {
  const portfolioId = await getManagedPortfolioId(req);
  if (!portfolioId) return res.status(403).json({ error: 'Accès refusé.' });
  const result = await query('SELECT * FROM public.web_portfolio_quotes WHERE portfolio_id = $1 ORDER BY created_at DESC', [portfolioId]);
  res.json({ success: true, data: result.rows });
});

const updateQuoteStatusAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const portfolioId = await getManagedPortfolioId(req);
  if (!portfolioId) return res.status(403).json({ error: 'Accès refusé.' });
  await query('UPDATE public.web_portfolio_quotes SET status = $1 WHERE id = $2 AND portfolio_id = $3', [status, id, portfolioId]);
  res.json({ success: true });
});

const updateProfileAdmin = asyncHandler(async (req, res) => {
  const {
    logoUrl, aboutPhotoUrl, aboutDescription,
    footerPolicy, footerConditions, footerBlog,
    footerCommunity, footerContact, backgroundUrl,
    backgroundAnimation, heroImageUrl,
    socialFacebook, socialGithub, socialWhatsapp,
    socialInstagram, socialTwitter,
    socialFacebookIcon, socialGithubIcon, socialWhatsappIcon,
    socialInstagramIcon, socialTwitterIcon
  } = req.body;

  const portfolioId = await getManagedPortfolioId(req);
  if (!portfolioId) return res.status(403).json({ error: 'Accès refusé.' });

  // Security: Check if delegated admin needs approval
  const adminController = require('./admin.controller');
  const canExecute = await adminController.processSensitiveAction(req, 'update_portfolio_identity', portfolioId, 'Portfolio Identity', req.body, 'portfolio', 'edit_identity');
  if (!canExecute) return res.json({ success: true, pending: true, message: 'Votre mise à jour d\'identité a été envoyée pour approbation à l\'Administrateur Principal.' });

  const result = await query(
    `UPDATE public.web_portfolio_profile
     SET logo_url = COALESCE($1, logo_url),
         about_photo_url = COALESCE($2, about_photo_url),
         about_description = COALESCE($3, about_description),
         footer_policy = COALESCE($4, footer_policy),
         footer_conditions = COALESCE($5, footer_conditions),
         footer_blog = COALESCE($6, footer_blog),
         footer_community = COALESCE($7, footer_community),
         footer_contact = COALESCE($8, footer_contact),
         background_url = COALESCE($9, background_url),
         background_animation = COALESCE($10, background_animation),
         hero_image_url = COALESCE($11, hero_image_url),
         social_facebook = COALESCE($12, social_facebook),
         social_github = COALESCE($13, social_github),
         social_whatsapp = COALESCE($14, social_whatsapp),
         social_instagram = COALESCE($15, social_instagram),
         social_twitter = COALESCE($16, social_twitter),
         social_facebook_icon = COALESCE($17, social_facebook_icon),
         social_github_icon = COALESCE($18, social_github_icon),
         social_whatsapp_icon = COALESCE($19, social_whatsapp_icon),
         social_instagram_icon = COALESCE($20, social_instagram_icon),
         social_twitter_icon = COALESCE($21, social_twitter_icon),
         updated_at = NOW()
     WHERE portfolio_id = $22 RETURNING *`,
    [
      logoUrl, aboutPhotoUrl, aboutDescription,
      footerPolicy, footerConditions, footerBlog,
      footerCommunity, footerContact, backgroundUrl,
      backgroundAnimation, heroImageUrl,
      socialFacebook, socialGithub, socialWhatsapp,
      socialInstagram, socialTwitter,
      socialFacebookIcon, socialGithubIcon, socialWhatsappIcon,
      socialInstagramIcon, socialTwitterIcon,
      portfolioId
    ]
  );

  socketService.broadcast('portfolio:data_updated', { portfolioId });
  res.json({ success: true, data: result.rows[0] });
});

const managePage = asyncHandler(async (req, res) => {
  const { action, id, slug, title, content, isActive } = req.body;
  const portfolioId = await getManagedPortfolioId(req);
  if (!portfolioId) return res.status(403).json({ error: 'Accès refusé.' });

  if (action === 'update') {
    const result = await query(
      `UPDATE public.web_portfolio_pages SET title = COALESCE($1, title), content = COALESCE($2, content), is_active = COALESCE($3, is_active), updated_at = NOW()
       WHERE (id = $4 OR slug = $5) AND portfolio_id = $6 RETURNING *`,
      [title, content, isActive, id, slug, portfolioId]
    );
    return res.json({ success: true, data: result.rows[0] });
  }
  if (action === 'add') {
    const result = await query(`INSERT INTO public.web_portfolio_pages (slug, title, content, portfolio_id) VALUES ($1, $2, $3, $4) RETURNING *`, [slug, title, content, portfolioId]);
    return res.json({ success: true, data: result.rows[0] });
  }
  if (action === 'delete') {
    await query('DELETE FROM public.web_portfolio_pages WHERE id = $1 AND portfolio_id = $2', [id, portfolioId]);
    return res.json({ success: true });
  }
  res.status(400).json({ error: 'Action invalide' });
});

const manageBlogPost = asyncHandler(async (req, res) => {
    const { action, id, title, slug, content, theme, imageUrl, isExternal, externalUrl, ctaText, ctaUrl, status } = req.body;
    const portfolioId = await getManagedPortfolioId(req);
    if (!portfolioId) return res.status(403).json({ error: 'Accès refusé.' });

    if (action === 'add') {
        const result = await query(
            `INSERT INTO public.web_portfolio_blog_posts (portfolio_id, title, slug, content, theme, image_url, is_external, external_url, cta_text, cta_url, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
            [portfolioId, title, slug, content, theme || 'futuristic', imageUrl, isExternal || false, externalUrl, ctaText, ctaUrl, status || 'published']
        );
        return res.json({ success: true, data: result.rows[0] });
    }
    if (action === 'update') {
        const result = await query(
            `UPDATE public.web_portfolio_blog_posts
             SET title = COALESCE($1, title), slug = COALESCE($2, slug), content = COALESCE($3, content),
                 theme = COALESCE($4, theme), image_url = COALESCE($5, image_url), is_external = COALESCE($6, is_external),
                 external_url = COALESCE($7, external_url), cta_text = COALESCE($8, cta_text), cta_url = COALESCE($9, cta_url),
                 status = COALESCE($10, status), updated_at = NOW()
             WHERE id = $11 AND portfolio_id = $12 RETURNING *`,
            [title, slug, content, theme, imageUrl, isExternal, externalUrl, ctaText, ctaUrl, status, id, portfolioId]
        );
        return res.json({ success: true, data: result.rows[0] });
    }
    if (action === 'delete') {
        await query('DELETE FROM public.web_portfolio_blog_posts WHERE id = $1 AND portfolio_id = $2', [id, portfolioId]);
        return res.json({ success: true });
    }
    res.status(400).json({ error: 'Action invalide' });
});

const getBlogPosts = asyncHandler(async (req, res) => {
    const { slug } = req.params;
    const portfolio = await query('SELECT id FROM public.web_portfolios WHERE slug = $1', [slug || 'together']);
    if (portfolio.rows.length === 0) return res.status(404).json({ error: 'Portfolio non trouvé' });
    const pId = portfolio.rows[0].id;

    const result = await query(`
        SELECT p.*,
        (SELECT count(*) FROM public.web_portfolio_blog_likes WHERE post_id = p.id) as likes_count,
        (SELECT count(*) FROM public.web_portfolio_blog_comments WHERE post_id = p.id) as comments_count
        FROM public.web_portfolio_blog_posts p
        WHERE p.portfolio_id = $1 AND p.status = 'published'
        ORDER BY p.created_at DESC`, [pId]);
    res.json({ success: true, data: result.rows });
});

const getBlogPostsAdmin = asyncHandler(async (req, res) => {
    const portfolioId = await getManagedPortfolioId(req);
    if (!portfolioId) return res.status(403).json({ error: 'Accès refusé.' });

    const result = await query(`
        SELECT p.*,
        (SELECT count(*) FROM public.web_portfolio_blog_likes WHERE post_id = p.id) as likes_count,
        (SELECT count(*) FROM public.web_portfolio_blog_comments WHERE post_id = p.id) as comments_count
        FROM public.web_portfolio_blog_posts p
        WHERE p.portfolio_id = $1
        ORDER BY p.created_at DESC`, [portfolioId]);
    res.json({ success: true, data: result.rows });
});

const getPostComments = asyncHandler(async (req, res) => {
    const { postId } = req.params;
    const result = await query(`
        SELECT c.*, p.avatar_url as author_avatar
        FROM public.web_portfolio_blog_comments c
        LEFT JOIN public.profiles p ON c.author_id = p.id
        WHERE c.post_id = $1
        ORDER BY c.created_at ASC`, [postId]);
    res.json({ success: true, data: result.rows });
});

const likeBlogPost = asyncHandler(async (req, res) => {
    const { postId } = req.params;
    const { visitorId } = req.body;
    const userId = req.user ? req.user.id : null;

    if (userId) {
        await query('INSERT INTO public.web_portfolio_blog_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [postId, userId]);
    } else if (visitorId) {
        // Enregistrer le like anonyme avec le visitorId unique du stockage local du navigateur
        await query('INSERT INTO public.web_portfolio_blog_likes (post_id, user_id, visitor_id) VALUES ($1, NULL, $2) ON CONFLICT DO NOTHING', [postId, visitorId]);
    } else {
        await query('INSERT INTO public.web_portfolio_blog_likes (post_id, user_id) VALUES ($1, \'00000000-0000-0000-0000-000000000000\') ON CONFLICT DO NOTHING', [postId]);
    }

    const countRes = await query('SELECT count(*) FROM public.web_portfolio_blog_likes WHERE post_id = $1', [postId]);
    const finalCount = parseInt(countRes.rows[0].count);

    socketService.broadcast('blog:post_liked', { postId, likes: finalCount });
    res.json({ success: true, likes: finalCount });
});

const commentBlogPost = asyncHandler(async (req, res) => {
    const { postId } = req.params;
    const { content, authorName, parentId, imageUrl, stickerUrl } = req.body;
    const userId = req.user ? req.user.id : null;

    const result = await query(
        `INSERT INTO public.web_portfolio_blog_comments (post_id, author_id, author_name, content, parent_id, image_url, sticker_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [postId, userId, authorName || 'Visiteur', content || '', parentId || null, imageUrl || null, stickerUrl || null]
    );

    const comment = { ...result.rows[0], author_avatar: req.user?.avatar_url || null };
    socketService.broadcast('blog:new_comment', { postId, comment });
    res.json({ success: true, data: comment });
});

const getCommunityGroups = asyncHandler(async (req, res) => {
  const [groups, sports, annon] = await Promise.all([
    query("SELECT id, name, avatar_url, description FROM public.chats WHERE type = 'group' AND is_banned = FALSE ORDER BY created_at ASC"),
    query("SELECT * FROM public.live_sports ORDER BY created_at DESC LIMIT 5"),
    query("SELECT * FROM public.web_portfolio_announcements ORDER BY created_at DESC LIMIT 10")
  ]);
  res.json({ success: true, data: { groups: groups.rows, sports: sports.rows, announcements: annon.rows } });
});

const getCommunityMessages = asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const messages = await query(`SELECT m.*, p.full_name as sender_name, p.avatar_url as sender_avatar FROM public.messages m LEFT JOIN public.profiles p ON m.sender_id = p.id WHERE m.chat_id = $1 ORDER BY m.created_at ASC LIMIT 100`, [groupId]);
  res.json({ success: true, data: messages.rows });
});

const sendCommunityMessage = asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const { content, visitorName, type, fileUrl, fileName } = req.body;
  if (!content && !fileUrl) return res.status(400).json({ error: 'Message vide' });
  const result = await query(`INSERT INTO public.messages (chat_id, content, type, file_url, file_name, metadata) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [groupId, content, type || 'text', fileUrl || null, fileName || null, JSON.stringify({ visitorName: visitorName || 'Visiteur' })]);
  const msg = { ...result.rows[0], sender_name: visitorName || 'Visiteur', sender_avatar: null };
  socketService.broadcast('community:new_message', msg);
  res.json({ success: true, data: msg });
});

const togglePinMessage = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const { isPinned } = req.body;
  await query("UPDATE public.messages SET is_pinned = $1 WHERE id = $2", [isPinned, messageId]);
  socketService.broadcast('community:message_pinned', { messageId, isPinned });
  res.json({ success: true });
});

/**
 * @desc    Get members for community (Publicly visible info)
 */
const getCommunityMembers = asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT full_name, avatar_url, status
    FROM public.profiles
    WHERE is_global_admin = FALSE
    ORDER BY status = 'online' DESC, full_name ASC
    LIMIT 50
  `);
  res.json({ success: true, data: result.rows });
});

module.exports = {
  getPublicData, submitPortfolioRequest, approvePortfolioRequest, getPortfolioRequests, getAllPortfolios, togglePortfolioStatus,
  requestTrackingCode, getClientQuotes, handleChat, replyToQuote, updateContract, signContract, updateSpecs, submitQuote,
  manageSkill, manageExperience, manageService, manageTeam, getQuotes, updateQuoteStatusAdmin, updateProfileAdmin, managePage,
  getCommunityGroups, getCommunityMessages, sendCommunityMessage, togglePinMessage, getCommunityMembers,
  getPortfolioRequestDetail, deletePortfolioRequest, deletePortfolio,
  getCommunityPosts, createCommunityPost, likeCommunityPost, commentCommunityPost, submitCommunitySupport,
  manageBlogPost, getBlogPosts, getBlogPostsAdmin, getPostComments, likeBlogPost, commentBlogPost
};
