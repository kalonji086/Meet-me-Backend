const { query } = require('../config/db');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/error.middleware');
const socketService = require('../services/socket.service');

/**
 * @desc    Submit a new school request
 * @route   POST /api/school/request
 * @access  Private
 */
const submitSchoolRequest = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const {
    schoolName,
    schoolEmail,
    schoolPhone,
    schoolAddress,
    schoolType,
    description
  } = req.body;

  if (!schoolName || !schoolEmail) {
    return res.status(400).json({
      success: false,
      error: 'Veuillez remplir les informations obligatoires (Nom de l\'école, Email)'
    });
  }

  // Check if a request already exists for this promoter
  const existing = await query('SELECT id, status FROM public.school_requests WHERE user_id = $1', [userId]);
  if (existing.rows.length > 0) {
    return res.status(400).json({
      success: false,
      error: `Une demande pour votre école est déjà ${existing.rows[0].status === 'en_attente' ? 'en cours d\'examen' : 'enregistrée'}.`
    });
  }

  const result = await query(
    `INSERT INTO public.school_requests (
      user_id, school_name, school_email, school_phone, school_address, school_type, description
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *`,
    [userId, schoolName, schoolEmail, schoolPhone, schoolAddress, schoolType, description]
  );

  const request = result.rows[0];

  // Notify admin in real-time if needed via web socket
  socketService.broadcast('admin:new_school_request', {
    id: request.id,
    school_name: request.school_name,
    user_id: userId
  });

  res.status(201).json({
    success: true,
    data: request,
    message: 'Votre demande de création d\'école a été soumise avec succès.'
  });
});

/**
 * @desc    Get current user's school request status
 * @route   GET /api/school/status
 * @access  Private
 */
const getSchoolStatus = asyncHandler(async (req, res) => {
  const userId = req.userId;

  const result = await query(
    'SELECT * FROM public.school_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [userId]
  );

  if (result.rows.length === 0) {
    return res.json({
      success: true,
      hasRequest: false,
      status: null
    });
  }

  res.json({
    success: true,
    hasRequest: true,
    data: result.rows[0]
  });
});

/**
 * @desc    Approve a school request
 * @route   PUT /api/school/approve/:requestId
 * @access  Private/Admin
 */
const approveSchoolRequest = asyncHandler(async (req, res) => {
  const { requestId } = req.params;

  const check = await query('SELECT id, user_id FROM public.school_requests WHERE id = $1', [requestId]);
  if (check.rows.length === 0) {
    return res.status(404).json({ success: false, error: 'Demande introuvable.' });
  }

  await query(
    "UPDATE public.school_requests SET status = 'approuve', updated_at = NOW() WHERE id = $1",
    [requestId]
  );

  res.json({
    success: true,
    message: 'La demande d\'école a été approuvée avec succès.'
  });
});

/**
 * @desc    Get metrics / dashboard details for an approved school
 * @route   GET /api/school/dashboard
 * @access  Private
 */
const getSchoolDashboardData = asyncHandler(async (req, res) => {
  const userId = req.userId;

  const schoolCheck = await query("SELECT * FROM public.school_requests WHERE user_id = $1 AND status = 'approuve'", [userId]);
  if (schoolCheck.rows.length === 0) {
    return res.status(403).json({
      success: false,
      error: 'Accès refusé. Votre école n\'est pas encore approuvée ou n\'existe pas.'
    });
  }

  // Données factices / initiales pour la gestion de l'école
  res.json({
    success: true,
    school: schoolCheck.rows[0],
    stats: {
      totalStudents: 120,
      totalTeachers: 12,
      totalClasses: 6,
      monthlyRevenue: '4,500 $'
    }
  });
});

module.exports = {
  submitSchoolRequest,
  getSchoolStatus,
  approveSchoolRequest,
  getSchoolDashboardData
};
