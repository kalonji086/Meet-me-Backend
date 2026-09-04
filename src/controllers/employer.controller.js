const { query } = require('../config/db');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/error.middleware');
const mailService = require('../services/mail.service');
const socketService = require('../services/socket.service');

/**
 * @desc    Submit a new employer request
 * @route   POST /api/employer/request
 * @access  Private
 */
const submitEmployerRequest = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const {
    companyName,
    companyEmail,
    companyPhone,
    companyAddress,
    companyWebsite,
    industry,
    companySize,
    hiringNeeds
  } = req.body;

  if (!companyName || !companyEmail || !industry) {
    return res.status(400).json({
      success: false,
      error: 'Veuillez remplir les informations obligatoires (Nom, Email, Secteur)'
    });
  }

  // Check if a request already exists for this user
  const existing = await query('SELECT id, status FROM public.employer_requests WHERE user_id = $1', [userId]);
  if (existing.rows.length > 0) {
    return res.status(400).json({
      success: false,
      error: `Une demande est déjà ${existing.rows[0].status === 'pending' ? 'en cours d\'examen' : 'enregistrée'}.`
    });
  }

  const result = await query(
    `INSERT INTO public.employer_requests (
      user_id, company_name, company_email, company_phone, company_address,
      company_website, industry, company_size, hiring_needs
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *`,
    [
      userId, companyName, companyEmail, companyPhone, companyAddress,
      companyWebsite, industry, companySize, hiringNeeds
    ]
  );

  const request = result.rows[0];

  // Notify admin in real-time
  socketService.broadcast('admin:new_employer_request', {
    id: request.id,
    company_name: request.company_name,
    user_id: userId
  });

  res.status(201).json({
    success: true,
    data: request,
    message: 'Votre demande employeur a été soumise avec succès et est en cours d\'examen.'
  });
});

/**
 * @desc    Get current user's employer status
 * @route   GET /api/employer/status
 * @access  Private
 */
const getEmployerStatus = asyncHandler(async (req, res) => {
  const userId = req.userId;

  const requestRes = await query(
    'SELECT * FROM public.employer_requests WHERE user_id = $1',
    [userId]
  );

  const profileRes = await query(
    'SELECT * FROM public.employer_profiles WHERE user_id = $1',
    [userId]
  );

  res.json({
    success: true,
    data: {
      request: requestRes.rows[0] || null,
      profile: profileRes.rows[0] || null
    }
  });
});

/**
 * @desc    Post a new job (Amazon-style)
 * @route   POST /api/employer/jobs
 * @access  Private (Employer only)
 */
const postJob = asyncHandler(async (req, res) => {
  const userId = req.userId;

  // Verify user is an approved employer
  const profileRes = await query('SELECT id FROM public.employer_profiles WHERE user_id = $1', [userId]);
  if (profileRes.rows.length === 0) {
    return res.status(403).json({ success: false, error: 'Accès réservé aux employeurs approuvés' });
  }

  const employerId = profileRes.rows[0].id;
  const {
    title,
    description,
    location,
    jobType,
    salaryRange,
    requirements,
    benefits,
    category
  } = req.body;

  try {
    // Validation des champs obligatoires
    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, error: 'Le titre est requis' });
    }
    if (!description || !description.trim()) {
      return res.status(400).json({ success: false, error: 'La description est requise' });
    }
    if (!location || !location.trim()) {
      return res.status(400).json({ success: false, error: 'La localisation est requise' });
    }

    // Validation de la longueur
    if (title.trim().length < 5) {
      return res.status(400).json({ success: false, error: 'Le titre doit contenir au moins 5 caractères' });
    }
    if (description.trim().length < 50) {
      return res.status(400).json({ success: false, error: 'La description doit contenir au moins 50 caractères' });
    }

    // Ensure requirements and benefits are arrays
    const requirementsArray = Array.isArray(requirements) ? requirements : (typeof requirements === 'string' ? requirements.split('\n').filter(r => r.trim()) : []);
    const benefitsArray = Array.isArray(benefits) ? benefits : (typeof benefits === 'string' ? benefits.split('\n').filter(b => b.trim()) : []);

    const result = await query(
      `INSERT INTO public.job_postings (
        employer_id, title, description, location, job_type, salary_range, requirements, benefits, category
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [employerId, title.trim(), description.trim(), location.trim(), jobType || 'CDI', salaryRange || 'Négociable', requirementsArray, benefitsArray, category || 'other']
    );

    res.status(201).json({
      success: true,
      data: result.rows[0],
      message: 'Offre d\'emploi publiée avec succès'
    });
  } catch (error) {
    logger.error('Error in postJob:', error.message);
    res.status(500).json({ success: false, error: 'Une erreur serveur est survenue lors de la publication' });
  }
});

/**
 * @desc    Get all job postings (Discovery)
 * @route   GET /api/employer/jobs
 * @access  Public
 */
const getAllJobs = asyncHandler(async (req, res) => {
  const { category, search } = req.query;

  let sql = `
    SELECT j.*, e.company_name, e.company_email, e.industry, e.logo_url as company_logo
    FROM public.job_postings j
    JOIN public.employer_profiles e ON j.employer_id = e.id
    WHERE j.status = 'active'
  `;

  const params = [];

  if (category && category !== 'all') {
    sql += ` AND j.category = $${params.length + 1}`;
    params.push(category);
  }

  if (search) {
    sql += ` AND (j.title ILIKE $${params.length + 1} OR e.company_name ILIKE $${params.length + 1})`;
    params.push(`%${search}%`);
  }

  sql += ` ORDER BY j.created_at DESC`;

  const result = await query(sql, params);

  res.json({
    success: true,
    data: result.rows
  });
});

/**
 * @desc    Get job by ID with details
 * @route   GET /api/employer/jobs/:id
 */
const getJobById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const result = await query(
    `SELECT j.*, e.company_name, e.company_email, e.industry, e.logo_url as company_logo, e.user_id as employer_user_id
     FROM public.job_postings j
     JOIN public.employer_profiles e ON j.employer_id = e.id
     WHERE j.id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ success: false, error: 'Offre d\'emploi non trouvée' });
  }

  res.json({
    success: true,
    data: result.rows[0]
  });
});

/**
 * @desc    Add a comment to a job posting
 */
const addJobComment = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { jobId } = req.params;
  const { content } = req.body;

  if (!content) return res.status(400).json({ success: false, error: 'Contenu requis' });

  const result = await query(
    `INSERT INTO public.job_comments (job_id, user_id, content)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [jobId, userId, content]
  );

  const comment = result.rows[0];

  // Get user info for real-time update
  const user = await query('SELECT full_name, avatar_url FROM public.profiles WHERE id = $1', [userId]);

  const commentWithUser = {
    ...comment,
    user: user.rows[0].full_name,
    avatar: user.rows[0].avatar_url
  };

  // Broadcast to anyone viewing this job (if we had specific job rooms, but for now broadcast)
  socketService.broadcast(`job:new_comment:${jobId}`, commentWithUser);

  res.status(201).json({
    success: true,
    data: commentWithUser
  });
});

/**
 * @desc    Get comments for a job
 */
const getJobComments = asyncHandler(async (req, res) => {
  const { jobId } = req.params;

  const result = await query(
    `SELECT c.*, p.full_name as user, p.avatar_url as avatar
     FROM public.job_comments c
     JOIN public.profiles p ON c.user_id = p.id
     WHERE c.job_id = $1
     ORDER BY c.created_at DESC`,
    [jobId]
  );

  res.json({
    success: true,
    data: result.rows
  });
});

/**
 * @desc    Admin: Approve employer request
 */
const approveRequest = asyncHandler(async (req, res) => {
  const { requestId } = req.params;
  const adminId = req.userId; // Middleware should ensure this is an admin

  const requestRes = await query('SELECT * FROM public.employer_requests WHERE id = $1', [requestId]);
  if (requestRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Demande introuvable' });

  const request = requestRes.rows[0];

  // Update status
  await query(
    'UPDATE public.employer_requests SET status = \'approved\', updated_at = NOW() WHERE id = $1',
    [requestId]
  );

  // Create profile
  const profileResult = await query(
    `INSERT INTO public.employer_profiles (user_id, request_id, company_name, company_email, industry)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET is_active = true
     RETURNING *`,
    [request.user_id, requestId, request.company_name, request.company_email, request.industry]
  );

  // Get user info for email
  const userRes = await query('SELECT full_name, email FROM public.profiles WHERE id = $1', [request.user_id]);
  const user = userRes.rows[0];

  // Send email via mailService
  await mailService.sendEmployerApprovalEmail(user.email, user.full_name, request.company_name);

  // Notify user via Socket
  socketService.sendToUser(request.user_id, 'employer:request_approved', {
    companyName: request.company_name
  });

  res.json({
    success: true,
    message: 'Demande approuvée et profil employeur créé'
  });
});

/**
 * @desc    Get current employer's job postings
 * @route   GET /api/employer/me/jobs
 * @access  Private (Employer only)
 */
const getMyJobs = asyncHandler(async (req, res) => {
  const userId = req.userId;

  // Verify user is an employer
  const employerRes = await query('SELECT id FROM public.employer_profiles WHERE user_id = $1', [userId]);
  if (employerRes.rows.length === 0) {
    return res.status(403).json({ success: false, error: 'Accès réservé aux employeurs' });
  }

  const employerId = employerRes.rows[0].id;

  const result = await query(
    `SELECT j.*, e.company_name, e.company_email, e.industry, e.logo_url as company_logo
     FROM public.job_postings j
     JOIN public.employer_profiles e ON j.employer_id = e.id
     WHERE j.employer_id = $1
     ORDER BY j.created_at DESC`,
    [employerId]
  );

  res.json({
    success: true,
    data: result.rows
  });
});

/**
 * @desc    Search for talents (users with completed profiles)
 * @route   GET /api/employer/talents
 * @access  Private (Employer only)
 */
const searchTalents = asyncHandler(async (req, res) => {
  const { search } = req.query;
  const userId = req.userId;

  // Verify user is an employer
  const employerRes = await query('SELECT id FROM public.employer_profiles WHERE user_id = $1', [userId]);
  if (employerRes.rows.length === 0) {
    return res.status(403).json({ success: false, error: 'Accès réservé aux employeurs' });
  }

  let sql = `
    SELECT id, full_name, username, avatar_url, country, city, bio, is_verified
    FROM public.profiles
    WHERE is_global_admin = FALSE AND id != $1
  `;
  const params = [userId];

  if (search) {
    sql += ` AND (full_name ILIKE $2 OR username ILIKE $2 OR bio ILIKE $2 OR city ILIKE $2)`;
    params.push(`%${search}%`);
  }

  sql += ` LIMIT 50`;

  const result = await query(sql, params);

  res.json({
    success: true,
    data: result.rows
  });
});

module.exports = {
  submitEmployerRequest,
  getEmployerStatus,
  postJob,
  getAllJobs,
  getJobById,
  addJobComment,
  getJobComments,
  approveRequest,
  searchTalents,
  getMyJobs
};
