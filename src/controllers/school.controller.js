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

  // Données réelles tirées de la table school_requests
  const school = schoolCheck.rows[0];

  // Requêtes réelles pour mettre à jour les métriques à la volée
  const studentsCount = await query('SELECT COUNT(*) FROM public.school_students WHERE school_id = $1', [school.id]);
  const classesCount = await query('SELECT COUNT(*) FROM public.school_classes WHERE school_id = $1', [school.id]);
  const revenueSum = await query("SELECT SUM(amount_paid) FROM public.school_fees WHERE school_id = $1", [school.id]);

  res.json({
    success: true,
    school: school,
    stats: {
      totalStudents: parseInt(studentsCount.rows[0].count) || 0,
      totalTeachers: school.total_teachers || 0,
      totalClasses: parseInt(classesCount.rows[0].count) || 0,
      monthlyRevenue: (revenueSum.rows[0].sum || 0) + ' $'
    }
  });
});

/**
 * @desc    Get all students of a school
 */
const getStudents = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await query("SELECT id FROM public.school_requests WHERE user_id = $1 AND status = 'approuve'", [userId]);
  if (school.rows.length === 0) return res.status(403).json({ success: false, error: 'École introuvable' });

  const result = await query(`
    SELECT s.*, c.name as class_name
    FROM public.school_students s
    LEFT JOIN public.school_classes c ON s.class_id = c.id
    WHERE s.school_id = $1 ORDER BY s.created_at DESC
  `, [school.rows[0].id]);

  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Enroll a student
 */
const addStudent = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await query("SELECT id FROM public.school_requests WHERE user_id = $1 AND status = 'approuve'", [userId]);
  if (school.rows.length === 0) return res.status(403).json({ success: false, error: 'École introuvable' });

  const { fullName, gender, birthDate, classId } = req.body;
  const accessCode = 'STU-' + Math.random().toString(36).substr(2, 6).toUpperCase();

  const result = await query(`
    INSERT INTO public.school_students (school_id, class_id, full_name, gender, birth_date, access_code)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
  `, [school.rows[0].id, classId || null, fullName, gender, birthDate, accessCode]);

  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Universal school login by unique code
 */
const loginByCode = asyncHandler(async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ success: false, error: 'Code requis' });

  // 1. Check if it's a staff member
  const staffCheck = await query(`
    SELECT sar.*, sr.school_name, sr.status as school_status
    FROM public.school_account_requests sar
    JOIN public.school_requests sr ON sar.school_id = sr.id
    WHERE sar.generated_code = $1 AND sar.status = 'approuve'
  `, [code]);

  if (staffCheck.rows.length > 0) {
    const staff = staffCheck.rows[0];
    if (staff.school_status !== 'approuve') return res.status(403).json({ success: false, error: 'L\'école est actuellement suspendue.' });

    return res.json({
      success: true,
      type: 'staff',
      role: staff.role,
      user: {
        id: staff.id,
        fullName: staff.full_name,
        schoolName: staff.school_name,
        schoolId: staff.school_id
      }
    });
  }

  // 2. Check if it's a student
  const studentCheck = await query(`
    SELECT s.*, sr.school_name, sr.status as school_status, c.name as class_name
    FROM public.school_students s
    JOIN public.school_requests sr ON s.school_id = sr.id
    LEFT JOIN public.school_classes c ON s.class_id = c.id
    WHERE s.access_code = $1
  `, [code]);

  if (studentCheck.rows.length > 0) {
    const student = studentCheck.rows[0];
    if (student.school_status !== 'approuve') return res.status(403).json({ success: false, error: 'L\'école est actuellement suspendue.' });

    return res.json({
      success: true,
      type: 'student',
      role: 'eleve',
      user: {
        id: student.id,
        fullName: student.full_name,
        schoolName: student.school_name,
        className: student.class_name,
        schoolId: student.school_id
      }
    });
  }

  res.status(404).json({ success: false, error: 'Code invalide ou compte non encore approuvé.' });
});

/**
 * @desc    Get all classes of a school
 */
const getClasses = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await query("SELECT id FROM public.school_requests WHERE user_id = $1 AND status = 'approuve'", [userId]);
  if (school.rows.length === 0) return res.status(403).json({ success: false, error: 'École introuvable' });

  const result = await query('SELECT * FROM public.school_classes WHERE school_id = $1 ORDER BY name ASC', [school.rows[0].id]);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Add a class
 */
const addClass = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await query("SELECT id FROM public.school_requests WHERE user_id = $1 AND status = 'approuve'", [userId]);
  if (school.rows.length === 0) return res.status(403).json({ success: false, error: 'École introuvable' });

  const { name, level } = req.body;
  const result = await query(`
    INSERT INTO public.school_classes (school_id, name, level)
    VALUES ($1, $2, $3) RETURNING *
  `, [school.rows[0].id, name, level]);

  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Get school schedules
 */
const getSchedules = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await query("SELECT id FROM public.school_requests WHERE user_id = $1 AND status = 'approuve'", [userId]);
  if (school.rows.length === 0) return res.status(403).json({ success: false, error: 'École introuvable' });

  const result = await query(`
    SELECT sch.*, c.name as class_name
    FROM public.school_schedules sch
    JOIN public.school_classes c ON sch.class_id = c.id
    WHERE sch.school_id = $1 ORDER BY sch.day_of_week, sch.start_time
  `, [school.rows[0].id]);

  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Add a schedule slot
 */
const addSchedule = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await query("SELECT id FROM public.school_requests WHERE user_id = $1 AND status = 'approuve'", [userId]);
  if (school.rows.length === 0) return res.status(403).json({ success: false, error: 'École introuvable' });

  const { classId, dayOfWeek, startTime, endTime, subject, teacherName } = req.body;
  const result = await query(`
    INSERT INTO public.school_schedules (school_id, class_id, day_of_week, start_time, end_time, subject, teacher_name)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
  `, [school.rows[0].id, classId, dayOfWeek, startTime, endTime, subject, teacherName]);

  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Get all fees of a school
 */
const getFees = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await query("SELECT id FROM public.school_requests WHERE user_id = $1 AND status = 'approuve'", [userId]);
  if (school.rows.length === 0) return res.status(403).json({ success: false, error: 'École introuvable' });

  const result = await query(`
    SELECT f.*, s.full_name as student_name
    FROM public.school_fees f
    JOIN public.school_students s ON f.student_id = s.id
    WHERE f.school_id = $1 ORDER BY f.created_at DESC
  `, [school.rows[0].id]);

  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Record or add fee invoice for a student
 */
const addFeeInvoice = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await query("SELECT id FROM public.school_requests WHERE user_id = $1 AND status = 'approuve'", [userId]);
  if (school.rows.length === 0) return res.status(403).json({ success: false, error: 'École introuvable' });

  const { studentId, amountDue, amountPaid, dueDate, status } = req.body;
  const result = await query(`
    INSERT INTO public.school_fees (school_id, student_id, amount_due, amount_paid, status, due_date)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
  `, [school.rows[0].id, studentId, amountDue, amountPaid || 0, status || 'non_paye', dueDate]);

  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Submit a staff account request from promoter
 */
const addAccountRequest = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await query("SELECT id FROM public.school_requests WHERE user_id = $1 AND status = 'approuve'", [userId]);
  if (school.rows.length === 0) return res.status(403).json({ success: false, error: 'École introuvable ou non approuvée' });

  const { fullName, email, role, phone } = req.body;
  if (!fullName || !email || !role) {
    return res.status(400).json({ success: false, error: 'Champs obligatoires manquants' });
  }

  const generatedCode = 'SCH-' + Math.random().toString(36).substr(2, 6).toUpperCase();

  const result = await query(`
    INSERT INTO public.school_account_requests (school_id, full_name, email, role, phone, generated_code)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
  `, [school.rows[0].id, fullName, email, role, phone, generatedCode]);

  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Get staff account requests for promoter view
 */
const getAccountRequests = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await query("SELECT id FROM public.school_requests WHERE user_id = $1 AND status = 'approuve'", [userId]);
  if (school.rows.length === 0) return res.status(403).json({ success: false, error: 'École introuvable' });

  const result = await query('SELECT * FROM public.school_account_requests WHERE school_id = $1 ORDER BY created_at DESC', [school.rows[0].id]);
  res.json({ success: true, data: result.rows });
});

module.exports = {
  submitSchoolRequest,
  getSchoolStatus,
  approveSchoolRequest,
  getSchoolDashboardData,
  getStudents,
  addStudent,
  getClasses,
  addClass,
  getSchedules,
  addSchedule,
  getFees,
  addFeeInvoice,
  addAccountRequest,
  getAccountRequests,
  loginByCode
};
