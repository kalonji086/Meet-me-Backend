const { query } = require('../config/db');
const { asyncHandler } = require('../middleware/error.middleware');
const logger = require('../utils/logger');
const socketService = require('../services/socket.service');

const mailService = require('../services/mail.service');

/**
 * Helper: Get the portfolio ID managed by the current user
 */
const getManagedPortfolioId = async (req) => {
  if (req.user.is_global_admin) {
    return '00000000-0000-0000-0000-000000000000';
  }
  const res = await query('SELECT id FROM public.web_portfolios WHERE user_id = $1 LIMIT 1', [req.userId]);
  return res.rows[0]?.id || null;
};

/**
 * @desc    Get all portfolio data (Public)
 * @route   GET /api/portfolio/:slug/public
 */
const getPublicData = asyncHandler(async (req, res) => {
  const { slug } = req.params;
  const portfolioRes = await query('SELECT * FROM public.web_portfolios WHERE slug = $1 AND status = \'approved\'', [slug || 'together']);

  if (portfolioRes.rows.length === 0) {
    return res.status(404).json({ success: false, error: 'Portfolio non trouvé ou non approuvé.' });
  }

  const portfolio = portfolioRes.rows[0];
  const portfolioId = portfolio.id;

  const [skills, experiences, services, team, profile, pages] = await Promise.all([
    query('SELECT * FROM public.web_portfolio_skills WHERE portfolio_id = $1 ORDER BY level DESC', [portfolioId]),
    query('SELECT * FROM public.web_portfolio_experiences WHERE portfolio_id = $1 ORDER BY order_index ASC, created_at DESC', [portfolioId]),
    query('SELECT * FROM public.web_portfolio_services WHERE portfolio_id = $1 ORDER BY created_at ASC', [portfolioId]),
    query('SELECT * FROM public.web_portfolio_team WHERE portfolio_id = $1 ORDER BY order_index ASC, created_at ASC', [portfolioId]),
    query('SELECT * FROM public.web_portfolio_profile WHERE portfolio_id = $1 LIMIT 1', [portfolioId]),
    query('SELECT * FROM public.web_portfolio_pages WHERE portfolio_id = $1 AND is_active = TRUE', [portfolioId])
  ]);

  res.json({
    success: true,
    data: {
      config: portfolio,
      skills: skills.rows,
      experiences: experiences.rows,
      services: services.rows,
      team: team.rows,
      profile: profile.rows[0] || {},
      pages: pages.rows
    }
  });
});

/**
 * @desc    Submit a portfolio creation request
 */
const submitPortfolioRequest = asyncHandler(async (req, res) => {
  const { fullName, email, profession, desiredSlug, preferredColor, motivation, logoUrl, enabledModules } = req.body;

  // If user is authenticated, we use their ID, otherwise it's null (public request)
  const userId = req.userId || null;

  if (!desiredSlug || !fullName || !email) {
    return res.status(400).json({ success: false, error: 'Champs obligatoires manquants (Nom, Email, Slug).' });
  }

  const existing = await query('SELECT id FROM public.web_portfolios WHERE slug = $1', [desiredSlug.toLowerCase()]);
  if (existing.rows.length > 0) return res.status(400).json({ success: false, error: 'Ce nom de domaine (slug) est déjà utilisé.' });

  const result = await query(
    `INSERT INTO public.web_portfolio_requests (user_id, full_name, email, profession, desired_slug, preferred_color, motivation, logo_url, enabled_modules)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [userId, fullName, email, profession, desiredSlug.toLowerCase(), preferredColor || '#06b6d4', motivation, logoUrl || null, enabledModules || ['home', 'about', 'contact']]
  );

  const mainAdmin = await query('SELECT id FROM public.profiles WHERE email = $1', ['wecanconcept@gmail.com']);
  if (mainAdmin.rows.length > 0) {
    socketService.sendToUser(mainAdmin.rows[0].id, 'admin:new_portfolio_request', result.rows[0]);
  }

  res.status(201).json({ success: true, message: 'Votre demande a été envoyée avec succès !', data: result.rows[0] });
});

/**
 * @desc    Admin: Approve Portfolio Request
 */
const approvePortfolioRequest = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { action } = req.body;

  const requestRes = await query('SELECT * FROM public.web_portfolio_requests WHERE id = $1', [id]);
  if (requestRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Demande non trouvée.' });
  const request = requestRes.rows[0];

  if (action === 'approved') {
    // 1. Determine Owner and Generate Temporary Password
    let ownerId = request.user_id;
    const crypto = require('crypto');
    const bcrypt = require('bcryptjs');
    const tempPassword = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 chars
    const hashed = await bcrypt.hash(tempPassword, 10);

    if (!ownerId) {
        const userCheck = await query('SELECT id FROM public.profiles WHERE email = $1', [request.email]);
        if (userCheck.rows.length > 0) {
            ownerId = userCheck.rows[0].id;
            // Ensure they can log in with a fresh temp password as requested
            await query('UPDATE public.profiles SET password = $1, must_change_password = TRUE WHERE id = $2', [hashed, ownerId]);
        } else {
            const newUser = await query(
                'INSERT INTO public.profiles (id, full_name, email, password, username, is_verified, must_change_password) VALUES ($1, $2, $3, $4, $5, TRUE, TRUE) RETURNING id',
                [crypto.randomUUID(), request.full_name, request.email, hashed, request.desired_slug]
            );
            ownerId = newUser.rows[0].id;
        }
    } else {
        // Force update even if already registered to ensure they have the new credentials sent in email
        await query('UPDATE public.profiles SET password = $1, must_change_password = TRUE WHERE id = $2', [hashed, ownerId]);
    }

    const portfolioTitle = `Portfolio de ${request.full_name}`;

    const portfolio = await query(
      `INSERT INTO public.web_portfolios (user_id, slug, title, owner_name, theme_color, logo_url, enabled_modules, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved') RETURNING *`,
      [ownerId, request.desired_slug, portfolioTitle, request.full_name, request.preferred_color, request.logo_url, request.enabled_modules]
    );

    await query('INSERT INTO public.web_portfolio_profile (portfolio_id, about_description, logo_url) VALUES ($1, $2, $3)',
      [portfolio.rows[0].id, `Bienvenue sur mon portfolio professionnel. Je suis ${request.profession}.`, request.logo_url]);

    await query(`INSERT INTO public.web_portfolio_pages (portfolio_id, slug, title, content) VALUES
      ($1, 'policy', 'Politique de Confidentialité', '<h1>Politique de Confidentialité</h1><p>Contenu à rédiger...</p>'),
      ($1, 'terms', 'Conditions d''Utilisation', '<h1>Conditions d''Utilisation</h1><p>Contenu à rédiger...</p>')`,
      [portfolio.rows[0].id]);

    await query('UPDATE public.web_portfolio_requests SET status = \'approved\' WHERE id = $1', [id]);

    // 2. Send Email Notification
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
 * @desc    Client tracking quotes
 */
const getClientQuotes = asyncHandler(async (req, res) => {
  const { email, quoteId } = req.query;
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
  const { content, senderType } = req.body;

  if (req.method === 'POST') {
    const result = await query(
      'INSERT INTO public.web_portfolio_messages (quote_id, sender_type, content) VALUES ($1, $2, $3) RETURNING *',
      [quoteId, senderType, content]
    );
    socketService.broadcast('portfolio:new_message', result.rows[0]);
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
  const { signatureData } = req.body;
  const result = await query(
    `UPDATE public.web_portfolio_quotes
     SET contract_signature_data = $1, contract_signed_at = NOW(), is_contract_archived = TRUE, updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [signatureData, id]
  );
  socketService.broadcast('portfolio:contract_signed', result.rows[0]);
  res.json({ success: true, message: 'Contrat signé !' });
});

const updateSpecs = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { specs } = req.body;
  await query('UPDATE public.web_portfolio_quotes SET specifications = $1, updated_at = NOW() WHERE id = $2', [specs, id]);
  socketService.broadcast('portfolio:specs_updated', { quoteId: id, specs });
  res.json({ success: true, message: 'Cahier des charges mis à jour.' });
});

const submitQuote = asyncHandler(async (req, res) => {
  const { clientName, clientEmail, projectDescription, budget, specifications } = req.body;
  if (!clientName || !clientEmail) return res.status(400).json({ error: 'Nom et Email requis' });
  const result = await query(
    `INSERT INTO public.web_portfolio_quotes (client_name, client_email, project_description, budget, specifications)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [clientName, clientEmail, projectDescription, budget, specifications]
  );
  res.status(201).json({ success: true, data: result.rows[0] });
});

// --- ADMIN CRUD ---

const manageSkill = asyncHandler(async (req, res) => {
  const { action, id, name, level, icon, imageUrl, category } = req.body;
  const portfolioId = await getManagedPortfolioId(req);
  if (!portfolioId) return res.status(403).json({ error: 'Aucun portfolio associé à ce compte.' });

  if (action === 'add') {
    const resAdd = await query(
      'INSERT INTO public.web_portfolio_skills (name, level, icon, image_url, category, portfolio_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [name, level || 50, icon || null, imageUrl || null, category || 'technical', portfolioId]
    );
    return res.json({ success: true, data: resAdd.rows[0] });
  }
  if (action === 'delete') {
    await query('DELETE FROM public.web_portfolio_skills WHERE id = $1 AND portfolio_id = $2', [id, portfolioId]);
    return res.json({ success: true });
  }
  res.status(400).json({ error: 'Action invalide' });
});

const manageExperience = asyncHandler(async (req, res) => {
  const { action, id, title, company, period, description, logoUrl, orderIndex } = req.body;
  const portfolioId = await getManagedPortfolioId(req);
  if (!portfolioId) return res.status(403).json({ error: 'Accès refusé.' });

  if (action === 'add') {
    const resAdd = await query(
      'INSERT INTO public.web_portfolio_experiences (title, company, period, description, logo_url, order_index, portfolio_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [title, company, period, description, logoUrl, orderIndex || 0, portfolioId]
    );
    return res.json({ success: true, data: resAdd.rows[0] });
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
  const { logoUrl, aboutPhotoUrl, aboutDescription, footerPolicy, footerConditions, footerBlog, footerCommunity, footerContact } = req.body;
  const portfolioId = await getManagedPortfolioId(req);
  if (!portfolioId) return res.status(403).json({ error: 'Accès refusé.' });
  const result = await query(
    `UPDATE public.web_portfolio_profile
     SET logo_url = COALESCE($1, logo_url), about_photo_url = COALESCE($2, about_photo_url), about_description = COALESCE($3, about_description),
         footer_policy = COALESCE($4, footer_policy), footer_conditions = COALESCE($5, footer_conditions), footer_blog = COALESCE($6, footer_blog),
         footer_community = COALESCE($7, footer_community), footer_contact = COALESCE($8, footer_contact), updated_at = NOW()
     WHERE portfolio_id = $9 RETURNING *`,
    [logoUrl, aboutPhotoUrl, aboutDescription, footerPolicy, footerConditions, footerBlog, footerCommunity, footerContact, portfolioId]
  );
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
  getClientQuotes, handleChat, replyToQuote, updateContract, signContract, updateSpecs, submitQuote,
  manageSkill, manageExperience, manageService, manageTeam, getQuotes, updateQuoteStatusAdmin, updateProfileAdmin, managePage,
  getCommunityGroups, getCommunityMessages, sendCommunityMessage, togglePinMessage, getCommunityMembers,
  getPortfolioRequestDetail, deletePortfolioRequest, deletePortfolio
};
