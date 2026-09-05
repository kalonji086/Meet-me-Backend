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

  // Enregistrer une vue (Asynchrone, ne bloque pas la réponse)
  const viewerId = req.userId || null;
  query('INSERT INTO public.job_views (job_id, viewer_id) VALUES ($1, $2)', [id, viewerId])
    .catch(err => logger.error('Error logging job view:', err.message));

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

/**
 * @desc    Get analytics for employer
 * @route   GET /api/employer/analytics
 */
const getAnalytics = asyncHandler(async (req, res) => {
  await ensureEmployerTables();
  const userId = req.userId;

  // Verify employer
  const empRes = await query('SELECT id FROM public.employer_profiles WHERE user_id = $1', [userId]);
  if (empRes.rows.length === 0) return res.status(403).json({ success: false, error: 'Accès restreint' });

  const employerId = empRes.rows[0].id;

  // 1. Vues totales
  const totalViewsRes = await query(`
    SELECT COUNT(*) as total
    FROM public.job_views jv
    JOIN public.job_postings jp ON jv.job_id = jp.id
    WHERE jp.employer_id = $1
  `, [employerId]);

  // 2. Candidatures totales
  const totalAppsRes = await query(`
    SELECT COUNT(*) as total
    FROM public.job_applications ja
    JOIN public.job_postings jp ON ja.job_id = jp.id
    WHERE jp.employer_id = $1
  `, [employerId]);

  // 3. Répartition par catégorie
  const catRes = await query(`
    SELECT category as label, COUNT(*) as value
    FROM public.job_postings
    WHERE employer_id = $1
    GROUP BY category
  `, [employerId]);

  // 4. Daily stats (Simplified to avoid complex JOINs with generate_series)
  const dailyViewsRes = await query(`
    SELECT date_trunc('day', jv.viewed_at) as day, COUNT(*) as count
    FROM public.job_views jv
    JOIN public.job_postings jp ON jv.job_id = jp.id
    WHERE jp.employer_id = $1 AND jv.viewed_at > now() - interval '7 days'
    GROUP BY day ORDER BY day
  `, [employerId]);

  const dailyAppsRes = await query(`
    SELECT date_trunc('day', ja.applied_at) as day, COUNT(*) as count
    FROM public.job_applications ja
    JOIN public.job_postings jp ON ja.job_id = jp.id
    WHERE jp.employer_id = $1 AND ja.applied_at > now() - interval '7 days'
    GROUP BY day ORDER BY day
  `, [employerId]);

  // Map results to 7-day array
  const dailyViews = Array(7).fill(0);
  const dailyApps = Array(7).fill(0);

  // (Optional: real mapping logic could go here, but for now we provide defaults if empty)
  dailyViewsRes.rows.forEach((r, i) => { if(i < 7) dailyViews[6-i] = parseInt(r.count); });
  dailyAppsRes.rows.forEach((r, i) => { if(i < 7) dailyApps[6-i] = parseInt(r.count); });

  const colors = ['#4CAF50', '#2196F3', '#FF9800', '#9C27B0', '#F44336'];
  const categories = catRes.rows.map((r, i) => ({
    label: r.label || 'Autre',
    value: parseInt(r.value),
    color: colors[i % colors.length]
  }));

  const stats = {
    totalViews: parseInt(totalViewsRes.rows[0]?.total || 0),
    totalApplications: parseInt(totalAppsRes.rows[0]?.total || 0),
    dailyViews,
    dailyApplications: dailyApps,
    categories
  };

  res.json({
    success: true,
    data: stats
  });
});

/**
 * @desc    Export employer data
 */
const exportData = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const empRes = await query('SELECT * FROM public.employer_profiles WHERE user_id = $1', [userId]);
  if (empRes.rows.length === 0) return res.status(403).json({ success: false, error: 'Accès restreint' });

  const employer = empRes.rows[0];
  const jobs = await query('SELECT * FROM public.job_postings WHERE employer_id = $1', [employer.id]);

  const exportPayload = {
    company: employer.company_name,
    industry: employer.industry,
    exported_at: new Date(),
    job_postings: jobs.rows
  };

  res.json({
    success: true,
    data: exportPayload,
    message: 'Données exportées avec succès (Format JSON)'
  });
});

/**
 * @desc    Update employer settings
 */
const updateSettings = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { companyName, industry, logoUrl } = req.body;

  const result = await query(
    `UPDATE public.employer_profiles
     SET company_name = COALESCE($1, company_name),
         industry = COALESCE($2, industry),
         logo_url = COALESCE($3, logo_url)
     WHERE user_id = $4
     RETURNING *`,
    [companyName, industry, logoUrl, userId]
  );

  if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Profil non trouvé' });

  res.json({
    success: true,
    data: result.rows[0],
    message: 'Paramètres mis à jour'
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
  getMyJobs,
  getAnalytics,
  exportData,
  updateSettings,
  ensureEmployerTables
};

async function ensureEmployerTables() {
  try {
    // Split queries to ensure compatibility
    await query(`
      CREATE TABLE IF NOT EXISTS public.job_views (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          job_id UUID REFERENCES public.job_postings(id) ON DELETE CASCADE,
          viewer_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
          viewed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS public.job_applications (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          job_id UUID REFERENCES public.job_postings(id) ON DELETE CASCADE,
          applicant_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
          cover_letter TEXT,
          resume_url TEXT,
          status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'shortlisted', 'rejected', 'hired')),
          applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // Ensure category column exists (legacy fix)
    await query('ALTER TABLE public.job_postings ADD COLUMN IF NOT EXISTS category TEXT DEFAULT \'other\'');

  } catch (e) {
    logger.error('Error ensuring employer tables:', e.message);
  }
}
