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
 * Helper to check if string is a valid UUID
 */
const isValidUUID = (str) => {
  if (!str || typeof str !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim());
};

/**
 * Helper to fetch school by promoter user_id
 */
const getPromoterSchool = async (userId) => {
  if (!isValidUUID(userId)) return null;

  let result = await query(
    "SELECT * FROM public.school_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
    [userId]
  );
  if (result.rows.length > 0) return result.rows[0];

  // Auto-create approved default school profile for promoter if missing
  try {
    const userProfile = await query("SELECT full_name, email, phone FROM public.profiles WHERE id = $1", [userId]);
    const userName = (userProfile.rows[0] && userProfile.rows[0].full_name) ? userProfile.rows[0].full_name : 'Promoteur';
    const userEmail = (userProfile.rows[0] && userProfile.rows[0].email) ? userProfile.rows[0].email : 'ecole@meetme.com';
    const userPhone = (userProfile.rows[0] && userProfile.rows[0].phone) ? userProfile.rows[0].phone : '';

    const newSchool = await query(`
      INSERT INTO public.school_requests (user_id, school_name, school_email, school_phone, school_type, status)
      VALUES ($1, $2, $3, $4, 'Complexe Scolaire', 'approuve')
      RETURNING *
    `, [userId, `École de ${userName}`, userEmail, userPhone]);

    return newSchool.rows[0];
  } catch (e) {
    logger.error('Error auto-creating school profile:', e.message);
    return null;
  }
};

/**
 * Auto-heal database columns for school module if table was created in an older schema version
 */
let columnsEnsured = false;
const ensureSchoolColumns = async () => {
  if (columnsEnsured) return;
  try {
    await query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'school_classes') THEN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_classes' AND column_name = 'staff_id') THEN
            ALTER TABLE public.school_classes ADD COLUMN staff_id UUID REFERENCES public.school_account_requests(id) ON DELETE SET NULL;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_classes' AND column_name = 'is_active') THEN
            ALTER TABLE public.school_classes ADD COLUMN is_active BOOLEAN DEFAULT TRUE;
          END IF;
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'school_students') THEN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_students' AND column_name = 'full_name') THEN
            ALTER TABLE public.school_students ADD COLUMN full_name TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_students' AND column_name = 'gender') THEN
            ALTER TABLE public.school_students ADD COLUMN gender TEXT DEFAULT 'M';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_students' AND column_name = 'birth_date') THEN
            ALTER TABLE public.school_students ADD COLUMN birth_date TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_students' AND column_name = 'access_code') THEN
            ALTER TABLE public.school_students ADD COLUMN access_code TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_students' AND column_name = 'class_id') THEN
            ALTER TABLE public.school_students ADD COLUMN class_id UUID REFERENCES public.school_classes(id) ON DELETE SET NULL;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_students' AND column_name = 'is_active') THEN
            ALTER TABLE public.school_students ADD COLUMN is_active BOOLEAN DEFAULT TRUE;
          END IF;

          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_students' AND column_name = 'name') THEN
            UPDATE public.school_students SET full_name = name WHERE full_name IS NULL AND name IS NOT NULL;
          END IF;
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'school_account_requests') THEN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_account_requests' AND column_name = 'generated_code') THEN
            ALTER TABLE public.school_account_requests ADD COLUMN generated_code TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_account_requests' AND column_name = 'status') THEN
            ALTER TABLE public.school_account_requests ADD COLUMN status TEXT DEFAULT 'en_attente';
          END IF;
        END IF;
      END $$;
    `);
    columnsEnsured = true;
  } catch (err) {
    logger.error('Error auto-healing school database columns:', err.message);
  }
};

/**
 * @desc    Get metrics / dashboard details for an approved school
 * @route   GET /api/school/dashboard
 * @access  Private
 */
const getSchoolDashboardData = asyncHandler(async (req, res) => {
  const userId = req.userId;

  const school = await getPromoterSchool(userId);
  if (!school) {
    return res.status(403).json({
      success: false,
      error: 'Accès refusé. Votre école n\'est pas encore enregistrée.'
    });
  }

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
 * @desc    Get all students of a school (with class info)
 */
const getStudents = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  await ensureSchoolColumns();

  try {
    const result = await query(`
      SELECT s.*, c.name as class_name
      FROM public.school_students s
      LEFT JOIN public.school_classes c ON s.class_id = c.id
      WHERE s.school_id = $1 ORDER BY s.full_name ASC
    `, [school.id]);

    res.json({ success: true, data: result.rows });
  } catch (e) {
    const result = await query(`
      SELECT s.*
      FROM public.school_students s
      WHERE s.school_id = $1 ORDER BY s.full_name ASC
    `, [school.id]);
    res.json({ success: true, data: result.rows });
  }
});

/**
 * @desc    Enroll or Update student
 */
const addStudent = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  await ensureSchoolColumns();

  const { id, fullName, gender, birthDate, classId, isActive } = req.body;

  if (!fullName || fullName.trim() === '') {
    return res.status(400).json({ success: false, error: 'Le nom complet de l\'élève est requis.' });
  }

  let cleanClassId = isValidUUID(classId) ? classId.trim() : null;
  if (cleanClassId) {
    const classCheck = await query('SELECT id FROM public.school_classes WHERE id = $1 AND school_id = $2', [cleanClassId, school.id]);
    if (classCheck.rows.length === 0) {
      cleanClassId = null;
    }
  }

  const cleanGender = gender || 'M';
  const cleanBirthDate = (birthDate && birthDate.toString().trim() !== '') ? birthDate : null;

  try {
    if (id && isValidUUID(id)) {
      const result = await query(`
        UPDATE public.school_students
        SET full_name = $1, gender = $2, birth_date = $3, class_id = $4, is_active = $5, updated_at = NOW()
        WHERE id = $6 AND school_id = $7 RETURNING *
      `, [fullName.trim(), cleanGender, cleanBirthDate, cleanClassId, isActive !== undefined ? isActive : true, id, school.id]);

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Élève introuvable.' });
      }
      return res.json({ success: true, data: result.rows[0] });
    }

    const accessCode = 'STU-' + Math.random().toString(36).substr(2, 6).toUpperCase();
    const result = await query(`
      INSERT INTO public.school_students (school_id, class_id, full_name, gender, birth_date, access_code)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
    `, [school.id, cleanClassId, fullName.trim(), cleanGender, cleanBirthDate, accessCode]);

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    logger.error('Error adding/updating student:', err.message);

    // Robust Fallback in case columns like birth_date or access_code are missing in older schema
    try {
      if (id && isValidUUID(id)) {
        const result = await query(`
          UPDATE public.school_students
          SET full_name = $1, gender = $2, class_id = $3
          WHERE id = $4 AND school_id = $5 RETURNING *
        `, [fullName.trim(), cleanGender, cleanClassId, id, school.id]);
        return res.json({ success: true, data: result.rows[0] });
      }

      const accessCode = 'STU-' + Math.random().toString(36).substr(2, 6).toUpperCase();
      const result = await query(`
        INSERT INTO public.school_students (school_id, class_id, full_name, gender, access_code)
        VALUES ($1, $2, $3, $4, $5) RETURNING *
      `, [school.id, cleanClassId, fullName.trim(), cleanGender, accessCode]);

      return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (fallbackErr) {
      logger.error('Fallback error adding student:', fallbackErr.message);
      return res.status(400).json({
        success: false,
        error: err.message || fallbackErr.message || 'Erreur lors de l\'enregistrement de l\'élève.'
      });
    }
  }
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
    if (staff.school_status !== 'approuve' && staff.school_status !== 'approuvé') {
      return res.status(403).json({ success: false, error: 'L\'école est actuellement suspendue.' });
    }

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
    if (student.school_status !== 'approuve' && student.school_status !== 'approuvé') {
      return res.status(403).json({ success: false, error: 'L\'école est actuellement suspendue.' });
    }

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
 * @desc    Get all classes of a school (with staff info)
 */
const getClasses = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  await ensureSchoolColumns();

  try {
    const result = await query(`
      SELECT c.*, sar.full_name as staff_name, sar.role as staff_role,
             (SELECT COUNT(*) FROM public.school_students s WHERE s.class_id = c.id) as student_count
      FROM public.school_classes c
      LEFT JOIN public.school_account_requests sar ON c.staff_id = sar.id
      WHERE c.school_id = $1 ORDER BY c.name ASC
    `, [school.id]);

    res.json({ success: true, data: result.rows });
  } catch (e) {
    const result = await query(`
      SELECT c.*,
             (SELECT COUNT(*) FROM public.school_students s WHERE s.class_id = c.id) as student_count
      FROM public.school_classes c
      WHERE c.school_id = $1 ORDER BY c.name ASC
    `, [school.id]);
    res.json({ success: true, data: result.rows });
  }
});

/**
 * @desc    Add or Update a class
 */
const addClass = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  await ensureSchoolColumns();

  const { id, name, level, staffId, isActive } = req.body;

  if (!name || name.trim() === '' || !level || level.trim() === '') {
    return res.status(400).json({ success: false, error: 'Le nom et le niveau de la classe sont requis.' });
  }

  let cleanStaffId = (staffId && staffId.toString().trim() !== '') ? staffId : null;
  if (cleanStaffId) {
    const staffCheck = await query('SELECT id FROM public.school_account_requests WHERE id = $1 AND school_id = $2', [cleanStaffId, school.id]);
    if (staffCheck.rows.length === 0) {
      cleanStaffId = null; // Reset to null if staffId does not exist in school_account_requests
    }
  }

  try {
    if (id) {
      const result = await query(`
        UPDATE public.school_classes
        SET name = $1, level = $2, staff_id = $3, is_active = $4
        WHERE id = $5 AND school_id = $6 RETURNING *
      `, [name.trim(), level.trim(), cleanStaffId, isActive !== undefined ? isActive : true, id, school.id]);

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Classe introuvable.' });
      }
      return res.json({ success: true, data: result.rows[0] });
    }

    const result = await query(`
      INSERT INTO public.school_classes (school_id, name, level, staff_id)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [school.id, name.trim(), level.trim(), cleanStaffId]);

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (e) {
    if (e.code === '23503') {
      // Foreign key violation error handling fallback
      if (id) {
        const result = await query(`
          UPDATE public.school_classes
          SET name = $1, level = $2, is_active = $3
          WHERE id = $4 AND school_id = $5 RETURNING *
        `, [name.trim(), level.trim(), isActive !== undefined ? isActive : true, id, school.id]);
        return res.json({ success: true, data: result.rows[0] });
      }

      const result = await query(`
        INSERT INTO public.school_classes (school_id, name, level)
        VALUES ($1, $2, $3) RETURNING *
      `, [school.id, name.trim(), level.trim()]);

      return res.status(201).json({ success: true, data: result.rows[0] });
    }

    if (id) {
      const result = await query(`
        UPDATE public.school_classes
        SET name = $1, level = $2, is_active = $3
        WHERE id = $4 AND school_id = $5 RETURNING *
      `, [name.trim(), level.trim(), isActive !== undefined ? isActive : true, id, school.id]);
      return res.json({ success: true, data: result.rows[0] });
    }

    const result = await query(`
      INSERT INTO public.school_classes (school_id, name, level)
      VALUES ($1, $2, $3) RETURNING *
    `, [school.id, name.trim(), level.trim()]);

    res.status(201).json({ success: true, data: result.rows[0] });
  }
});

/**
 * @desc    Delete a class
 */
const deleteClass = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  const { id } = req.params;
  await query('DELETE FROM public.school_classes WHERE id = $1 AND school_id = $2', [id, school.id]);
  res.json({ success: true, message: 'Classe supprimée' });
});

/**
 * @desc    Delete a student
 */
const deleteStudent = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  const { id } = req.params;
  await query('DELETE FROM public.school_students WHERE id = $1 AND school_id = $2', [id, school.id]);
  res.json({ success: true, message: 'Élève supprimé' });
});

/**
 * @desc    Get school schedules
 */
const getSchedules = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  const result = await query(`
    SELECT sch.*, c.name as class_name
    FROM public.school_schedules sch
    JOIN public.school_classes c ON sch.class_id = c.id
    WHERE sch.school_id = $1 ORDER BY sch.day_of_week, sch.start_time
  `, [school.id]);

  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Add a schedule slot
 */
const addSchedule = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  const { classId, dayOfWeek, startTime, endTime, subject, teacherName } = req.body;
  if (!classId || !dayOfWeek || !startTime || !endTime || !subject) {
    return res.status(400).json({ success: false, error: 'Veuillez remplir tous les champs obligatoires du cours.' });
  }

  const result = await query(`
    INSERT INTO public.school_schedules (school_id, class_id, day_of_week, start_time, end_time, subject, teacher_name)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
  `, [school.id, classId, dayOfWeek, startTime, endTime, subject, teacherName || null]);

  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Get all fees of a school
 */
const getFees = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  const result = await query(`
    SELECT f.*, s.full_name as student_name
    FROM public.school_fees f
    JOIN public.school_students s ON f.student_id = s.id
    WHERE f.school_id = $1 ORDER BY f.created_at DESC
  `, [school.id]);

  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Record or add fee invoice for a student
 */
const addFeeInvoice = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  const { studentId, amountDue, amountPaid, dueDate, status } = req.body;
  if (!studentId || amountDue === undefined) {
    return res.status(400).json({ success: false, error: 'L\'élève et le montant dû sont requis.' });
  }

  const result = await query(`
    INSERT INTO public.school_fees (school_id, student_id, amount_due, amount_paid, status, due_date)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
  `, [school.id, studentId, amountDue || 0, amountPaid || 0, status || 'non_paye', dueDate || null]);

  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Submit a staff account request from promoter
 */
const addAccountRequest = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  const { fullName, email, role, phone } = req.body;
  if (!fullName || !email || !role) {
    return res.status(400).json({ success: false, error: 'Champs obligatoires manquants (nom, email, rôle)' });
  }

  const generatedCode = 'SCH-' + Math.random().toString(36).substr(2, 6).toUpperCase();

  const result = await query(`
    INSERT INTO public.school_account_requests (school_id, full_name, email, role, phone, generated_code, status)
    VALUES ($1, $2, $3, $4, $5, $6, 'approuve') RETURNING *
  `, [school.id, fullName, email, role, phone, generatedCode]);

  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Get staff account requests for promoter view
 */
const getAccountRequests = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  const result = await query('SELECT * FROM public.school_account_requests WHERE school_id = $1 ORDER BY created_at DESC', [school.id]);
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
  loginByCode,
  deleteClass,
  deleteStudent
};
