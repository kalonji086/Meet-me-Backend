const { query } = require('../config/db');
const { asyncHandler } = require('../middleware/error.middleware');
const logger = require('../utils/logger');
const socketService = require('../services/socket.service');

/**
 * @desc    Get all portfolio data (Public)
 * @route   GET /api/portfolio/public
 */
const getPublicData = asyncHandler(async (req, res) => {
  const [skills, experiences, services, team, profile, pages] = await Promise.all([
    query('SELECT * FROM public.web_portfolio_skills ORDER BY level DESC'),
    query('SELECT * FROM public.web_portfolio_experiences ORDER BY order_index ASC, created_at DESC'),
    query('SELECT * FROM public.web_portfolio_services ORDER BY created_at ASC'),
    query('SELECT * FROM public.web_portfolio_team ORDER BY order_index ASC, created_at ASC'),
    query('SELECT * FROM public.web_portfolio_profile LIMIT 1'),
    query('SELECT * FROM public.web_portfolio_pages WHERE is_active = TRUE')
  ]);

  res.json({
    success: true,
    data: {
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
 * @desc    Client Login to view quotes
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
 * @desc    Send/Get messages for a quote
 */
const handleChat = asyncHandler(async (req, res) => {
  const { quoteId } = req.params;
  const { content, senderType } = req.body;

  if (req.method === 'POST') {
    const result = await query(
      'INSERT INTO public.web_portfolio_messages (quote_id, sender_type, content) VALUES ($1, $2, $3) RETURNING *',
      [quoteId, senderType, content]
    );
    // Notify recipient
    socketService.broadcast('portfolio:new_message', result.rows[0]);
    return res.json({ success: true, data: result.rows[0] });
  }

  const messages = await query(
    'SELECT * FROM public.web_portfolio_messages WHERE quote_id = $1 ORDER BY created_at ASC',
    [quoteId]
  );
  res.json({ success: true, data: messages.rows });
});

/**
 * @desc    Admin reply to a quote
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

/**
 * @desc    Update Contract (Admin)
 */
const updateContract = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { content } = req.body;
  await query('UPDATE public.web_portfolio_quotes SET contract_content = $1, updated_at = NOW() WHERE id = $2', [content, id]);
  socketService.broadcast('portfolio:contract_updated', { quoteId: id, content });
  res.json({ success: true, message: 'Contrat mis à jour et envoyé au client.' });
});

/**
 * @desc    Sign Contract (Client)
 */
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
  res.json({ success: true, message: 'Contrat signé avec succès !' });
});

/**
 * @desc    Update Specifications (Client)
 */
const updateSpecs = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { specs } = req.body;
  await query('UPDATE public.web_portfolio_quotes SET specifications = $1, updated_at = NOW() WHERE id = $2', [specs, id]);
  socketService.broadcast('portfolio:specs_updated', { quoteId: id, specs });
  res.json({ success: true, message: 'Cahier des charges mis à jour.' });
});

/**
 * @desc    Update Portfolio Profile/Logo
 */
const updateProfile = asyncHandler(async (req, res) => {
  const {
    logoUrl, aboutPhotoUrl, aboutDescription,
    footerPolicy, footerConditions, footerBlog, footerCommunity, footerContact
  } = req.body;

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
         updated_at = NOW()
     RETURNING *`,
    [logoUrl, aboutPhotoUrl, aboutDescription, footerPolicy, footerConditions, footerBlog, footerCommunity, footerContact]
  );

  socketService.broadcast('portfolio:data_updated', { type: 'profile', data: result.rows[0] });

  res.json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Submit a quote request (Public)
 * @route   POST /api/portfolio/quote
 */
const submitQuote = asyncHandler(async (req, res) => {
  const { clientName, clientEmail, projectDescription, budget, specifications } = req.body;

  if (!clientName || !clientEmail) {
    return res.status(400).json({ success: false, error: 'Nom et Email requis' });
  }

  const result = await query(
    `INSERT INTO public.web_portfolio_quotes (client_name, client_email, project_description, budget, specifications)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [clientName, clientEmail, projectDescription, budget, specifications]
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
  const { action, id, name, level, icon, imageUrl, category } = req.body;

  if (action === 'add') {
    const resAdd = await query(
      'INSERT INTO public.web_portfolio_skills (name, level, icon, image_url, category) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, level || 50, icon || null, imageUrl || null, category || 'technical']
    );
    socketService.broadcast('portfolio:data_updated', { type: 'skill', action: 'add', data: resAdd.rows[0] });
    return res.json({ success: true, data: resAdd.rows[0] });
  }

  if (action === 'delete') {
    await query('DELETE FROM public.web_portfolio_skills WHERE id = $1', [id]);
    socketService.broadcast('portfolio:data_updated', { type: 'skill', action: 'delete', id });
    return res.json({ success: true, message: 'Compétence supprimée' });
  }

  res.status(400).json({ success: false, error: 'Action invalide' });
});

/**
 * @desc    Manage Experiences
 */
const manageExperience = asyncHandler(async (req, res) => {
  const { action, id, title, company, period, description, logoUrl, orderIndex } = req.body;

  if (action === 'add') {
    const resAdd = await query(
      'INSERT INTO public.web_portfolio_experiences (title, company, period, description, logo_url, order_index) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [title, company, period, description, logoUrl, orderIndex || 0]
    );
    socketService.broadcast('portfolio:data_updated', { type: 'experience', action: 'add', data: resAdd.rows[0] });
    return res.json({ success: true, data: resAdd.rows[0] });
  }

  if (action === 'delete') {
    await query('DELETE FROM public.web_portfolio_experiences WHERE id = $1', [id]);
    socketService.broadcast('portfolio:data_updated', { type: 'experience', action: 'delete', id });
    return res.json({ success: true, message: 'Expérience supprimée' });
  }

  res.status(400).json({ success: false, error: 'Action invalide' });
});

/**
 * @desc    Manage Services
 */
const manageService = asyncHandler(async (req, res) => {
  const { action, id, title, description, priceRange, icon, imageUrl } = req.body;

  if (action === 'add') {
    const resAdd = await query(
      'INSERT INTO public.web_portfolio_services (title, description, price_range, icon, image_url) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [title, description, priceRange, icon || null, imageUrl || null]
    );
    socketService.broadcast('portfolio:data_updated', { type: 'service', action: 'add', data: resAdd.rows[0] });
    return res.json({ success: true, data: resAdd.rows[0] });
  }

  if (action === 'delete') {
    await query('DELETE FROM public.web_portfolio_services WHERE id = $1', [id]);
    socketService.broadcast('portfolio:data_updated', { type: 'service', action: 'delete', id });
    return res.json({ success: true, message: 'Service supprimé' });
  }

  res.status(400).json({ success: false, error: 'Action invalide' });
});

/**
 * @desc    Manage Team Members
 */
const manageTeam = asyncHandler(async (req, res) => {
  const { action, id, name, role, bio, imageUrl, orderIndex } = req.body;

  if (action === 'add') {
    const resAdd = await query(
      'INSERT INTO public.web_portfolio_team (name, role, bio, image_url, order_index) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, role, bio, imageUrl || null, orderIndex || 0]
    );
    socketService.broadcast('portfolio:data_updated', { type: 'team', action: 'add', data: resAdd.rows[0] });
    return res.json({ success: true, data: resAdd.rows[0] });
  }

  if (action === 'delete') {
    await query('DELETE FROM public.web_portfolio_team WHERE id = $1', [id]);
    socketService.broadcast('portfolio:data_updated', { type: 'team', action: 'delete', id });
    return res.json({ success: true, message: 'Membre supprimé' });
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
  updateProfile,
  submitQuote,
  getClientQuotes,
  handleChat,
  replyToQuote,
  updateContract,
  signContract,
  updateSpecs,
  manageSkill,
  manageExperience,
  manageService,
  manageTeam,
  getQuotes,
  updateQuoteStatus,
  managePage,
  getCommunityGroups,
  getCommunityMessages,
  sendCommunityMessage,
  togglePinMessage
};

/**
 * @desc    Manage Portfolio Pages (Policy, Terms, etc.)
 */
async function managePage(req, res) {
  const { action, id, slug, title, content, isActive } = req.body;

  if (action === 'update') {
    const result = await query(
      `UPDATE public.web_portfolio_pages
       SET title = COALESCE($1, title), content = COALESCE($2, content), is_active = COALESCE($3, is_active), updated_at = NOW()
       WHERE id = $4 OR slug = $5 RETURNING *`,
      [title, content, isActive, id, slug]
    );
    socketService.broadcast('portfolio:data_updated', { type: 'page', data: result.rows[0] });
    return res.json({ success: true, data: result.rows[0] });
  }

  if (action === 'add') {
    const result = await query(
      `INSERT INTO public.web_portfolio_pages (slug, title, content) VALUES ($1, $2, $3) RETURNING *`,
      [slug, title, content]
    );
    return res.json({ success: true, data: result.rows[0] });
  }

  if (action === 'delete') {
    await query('DELETE FROM public.web_portfolio_pages WHERE id = $1', [id]);
    return res.json({ success: true, message: 'Page supprimée' });
  }

  res.status(400).json({ success: false, error: 'Action invalide' });
}

/**
 * @desc    Get public groups for community page
 */
async function getCommunityGroups(req, res) {
  try {
    const [groups, sports, annon] = await Promise.all([
      query("SELECT id, name, avatar_url, description FROM public.chats WHERE type = 'group' AND is_banned = FALSE ORDER BY created_at ASC"),
      query("SELECT * FROM public.live_sports ORDER BY created_at DESC LIMIT 5"),
      query("SELECT * FROM public.web_portfolio_announcements ORDER BY created_at DESC LIMIT 10")
    ]);
    res.json({
      success: true,
      data: {
        groups: groups.rows,
        sports: sports.rows,
        announcements: annon.rows
      }
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
}

/**
 * @desc    Get messages for a community group
 */
async function getCommunityMessages(req, res) {
  const { groupId } = req.params;
  try {
    const messages = await query(`
      SELECT m.*, p.full_name as sender_name, p.avatar_url as sender_avatar
      FROM public.messages m
      LEFT JOIN public.profiles p ON m.sender_id = p.id
      WHERE m.chat_id = $1
      ORDER BY m.created_at ASC LIMIT 100
    `, [groupId]);
    res.json({ success: true, data: messages.rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
}

/**
 * @desc    Send a message in community as visitor
 */
async function sendCommunityMessage(req, res) {
  const { groupId } = req.params;
  const { content, visitorName, type, fileUrl, fileName } = req.body;
  if (!content && !fileUrl) return res.status(400).json({ error: 'Message vide' });

  try {
    const result = await query(
      "INSERT INTO public.messages (chat_id, content, type, file_url, file_name, metadata) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
      [groupId, content, type || 'text', fileUrl || null, fileName || null, JSON.stringify({ visitorName: visitorName || 'Visiteur' })]
    );

    const msg = {
      ...result.rows[0],
      sender_name: visitorName || 'Visiteur',
      sender_avatar: null
    };

    socketService.broadcast('community:new_message', msg);
    res.json({ success: true, data: msg });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
}

/**
 * @desc    Toggle pin message
 */
async function togglePinMessage(req, res) {
  const { messageId } = req.params;
  const { isPinned } = req.body;
  try {
    await query("UPDATE public.messages SET is_pinned = $1 WHERE id = $2", [isPinned, messageId]);
    socketService.broadcast('community:message_pinned', { messageId, isPinned });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
}
