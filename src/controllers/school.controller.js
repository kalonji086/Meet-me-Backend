const { query } = require('../config/db');
const { asyncHandler } = require('../middleware/error.middleware');
const socketService = require('../services/socket.service');
const logger = require('../utils/logger');

/**
 * @desc    Get global overview and world schools
 */
const getSchoolOverview = asyncHandler(async (req, res) => {
  const userId = req.userId;

  const [schoolMembership, worldSchools, myStudents, pendingAssignments] = await Promise.all([
    query(
      `SELECT sm.role, sm.is_active, s.*
       FROM public.school_members sm
       JOIN public.school_schools s ON s.id = sm.school_id
       WHERE sm.user_id = $1 AND sm.is_active = TRUE
       ORDER BY s.created_at DESC, s.updated_at DESC
       LIMIT 1`,
      [userId]
    ),
    query(
      `SELECT s.*,
              (SELECT COUNT(*) FROM public.school_members sm WHERE sm.school_id = s.id AND sm.is_active = TRUE) AS members_count
       FROM public.school_schools s
       WHERE s.status IN ('approved', 'active') OR s.created_by = $1
       ORDER BY s.created_at DESC
       LIMIT 50`,
      [userId]
    ),
    query(
      `SELECT COUNT(*) AS total_students
       FROM public.school_students st
       WHERE st.parent_id = $1 OR st.user_id = $1`,
      [userId]
    ),
    query(
      `SELECT COUNT(*) AS total_assignments
       FROM public.school_assignments sa
       JOIN public.school_members sm ON sm.school_id = sa.school_id
       WHERE sm.user_id = $1 AND sm.is_active = TRUE AND sa.due_date > NOW()`,
      [userId]
    )
  ]);

  res.json({
    success: true,
    data: {
      role: schoolMembership.rows[0]?.role || 'none',
      mySchool: schoolMembership.rows[0] || null,
      worldSchools: worldSchools.rows,
      stats: {
        totalStudents: parseInt(myStudents.rows[0]?.total_students || 0),
        activeAssignments: parseInt(pendingAssignments.rows[0]?.total_assignments || 0)
      }
    }
  });
});

/**
 * @desc    Submit a request to create a new school (Promoter Dashboard)
 */
const createSchool = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { name, schoolType, country, city, address, contactEmail, phone, logoUrl, description } = req.body;

  if (!name || !country) {
    return res.status(400).json({ success: false, error: 'Le nom et le pays de l’école sont requis.' });
  }

  const schoolResult = await query(
    `INSERT INTO public.school_schools (
      name, school_type, country, city, address, contact_email, phone, logo_url, description, status, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10)
     RETURNING *`,
    [name, schoolType || 'private', country, city || '', address || '', contactEmail || '', phone || '', logoUrl || '', description || '', userId]
  );

  const school = schoolResult.rows[0];

  // Auto-assign as promoter
  await query(
    `INSERT INTO public.school_members (school_id, user_id, role, is_active)
     VALUES ($1, $2, 'promoter', TRUE)`,
    [school.id, userId]
  );

  // Notify Principal Admin
  socketService.broadcast('admin:new_school_request', { schoolName: school.name, promoterId: userId });

  res.status(201).json({
    success: true,
    message: 'Votre école a été créée et est en attente de validation par l’administrateur principal.',
    data: school
  });
});

/**
 * @desc    Dashboard logic for each role (Real-time updates)
 */
const getDashboard = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { schoolId } = req.query;

  if (!schoolId) return res.status(400).json({ success: false, error: 'ID de l’école requis' });

  // Verify membership
  const memberRes = await query(
    'SELECT role, is_active FROM public.school_members WHERE school_id = $1 AND user_id = $2',
    [schoolId, userId]
  );

  if (memberRes.rows.length === 0 || !memberRes.rows[0].is_active) {
    return res.status(403).json({ success: false, error: 'Accès refusé à cet établissement' });
  }

  const role = memberRes.rows[0].role;
  let dashboardData = { role };

  // Fetch role-specific data
  if (role === 'student') {
    const [grades, assignments, profile, schoolInfo, fees] = await Promise.all([
      query('SELECT * FROM public.school_grades WHERE school_id = $1 AND student_id = (SELECT id FROM public.school_students WHERE user_id = $2 AND school_id = $1) ORDER BY created_at DESC', [schoolId, userId]),
      query('SELECT a.*, p.full_name as teacher_name FROM public.school_assignments a LEFT JOIN public.profiles p ON a.teacher_id = p.id WHERE a.school_id = $1 AND a.class_id = (SELECT class_id FROM public.school_students WHERE user_id = $2 AND school_id = $1) ORDER BY a.due_date ASC', [schoolId, userId]),
      query('SELECT s.*, (SELECT COUNT(*) FROM public.school_students WHERE class_id = s.class_id) as classmates_count FROM public.school_students s WHERE s.school_id = $1 AND s.user_id = $2', [schoolId, userId]),
      query('SELECT s.name, p.full_name as director_name FROM public.school_schools s LEFT JOIN public.profiles p ON s.director_id = p.id WHERE s.id = $1', [schoolId]),
      query('SELECT * FROM public.school_fees_config WHERE school_id = $1 ORDER BY created_at ASC', [schoolId])
    ]);
    dashboardData.grades = grades.rows;
    dashboardData.assignments = assignments.rows;
    dashboardData.profile = profile.rows[0];
    dashboardData.schoolInfo = schoolInfo.rows[0];
    dashboardData.fees = fees.rows;
  }
  else if (role === 'teacher') {
    const [myClasses, myAssignments, myStudents] = await Promise.all([
      query(`SELECT c.* FROM public.school_classes c
             JOIN public.school_teacher_classes tc ON c.id = tc.class_id
             JOIN public.school_teachers t ON tc.teacher_id = t.id
             WHERE t.user_id = $1 AND t.school_id = $2`, [userId, schoolId]),
      query('SELECT * FROM public.school_assignments WHERE school_id = $1 AND teacher_id = $2', [schoolId, userId]),
      query(`SELECT s.*, (s.created_at > NOW() - INTERVAL '3 days') as is_new
             FROM public.school_students s
             JOIN public.school_teacher_classes tc ON s.class_id = tc.class_id
             JOIN public.school_teachers t ON tc.teacher_id = t.id
             WHERE t.user_id = $1 AND t.school_id = $2`, [userId, schoolId])
    ]);
    dashboardData.classes = myClasses.rows;
    dashboardData.assignments = myAssignments.rows;
    dashboardData.students = myStudents.rows;
  }
  else if (role === 'director' || role === 'promoter') {
    const [allStudents, allTeachers, allPayments] = await Promise.all([
      query("SELECT s.*, (s.created_at > NOW() - INTERVAL '3 days') as is_new FROM public.school_students s WHERE s.school_id = $1", [schoolId]),
      query('SELECT COUNT(*) FROM public.school_teachers WHERE school_id = $1', [schoolId]),
      query('SELECT SUM(amount) FROM public.school_payments WHERE school_id = $1 AND status = \'completed\'', [schoolId])
    ]);
    dashboardData.students = allStudents.rows;
    dashboardData.stats = {
      totalStudents: allStudents.rows.length,
      totalTeachers: parseInt(allTeachers.rows[0].count),
      revenue: parseFloat(allPayments.rows[0].sum || 0)
    };
  }

  res.json({ success: true, data: dashboardData });
});

/**
 * @desc    Submit an assignment (Student)
 */
const submitAssignment = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { assignmentId, content, fileUrl } = req.body;

  // Find student ID linked to this user
  const studentRes = await query('SELECT id FROM public.school_students WHERE user_id = $1', [userId]);
  if (studentRes.rows.length === 0) return res.status(403).json({ success: false, error: 'Profil élève non trouvé' });

  const result = await query(
    `INSERT INTO public.school_submissions (assignment_id, student_id, content, file_url)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [assignmentId, studentRes.rows[0].id, content, fileUrl]
  );

  // Notify teacher
  const assignRes = await query('SELECT teacher_id FROM public.school_assignments WHERE id = $1', [assignmentId]);
  if (assignRes.rows.length > 0 && assignRes.rows[0].teacher_id) {
    socketService.sendToUser(assignRes.rows[0].teacher_id, 'school:new_submission', { assignmentId });
  }

  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Grade a student (Teacher)
 */
const addGrade = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { schoolId, studentId, classId, subject, score, maxScore, comment } = req.body;

  const result = await query(
    `INSERT INTO public.school_grades (school_id, student_id, teacher_id, class_id, subject, score, max_score, comment)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [schoolId, studentId, userId, classId, subject, score, maxScore || 20, comment]
  );

  // Notify student and parent in real-time
  const studentInfo = await query('SELECT user_id, parent_id FROM public.school_students WHERE id = $1', [studentId]);
  if (studentInfo.rows.length > 0) {
    if (studentInfo.rows[0].user_id) {
      socketService.sendToUser(studentInfo.rows[0].user_id, 'school:new_grade', { subject, score });
    }
    if (studentInfo.rows[0].parent_id) {
      socketService.sendToUser(studentInfo.rows[0].parent_id, 'school:child_new_grade', { subject, score });
    }
  }

  res.status(201).json({ success: true, data: result.rows[0] });
});

const getSchools = asyncHandler(async (req, res) => {
  const { country, city, type } = req.query;

  let sql = `SELECT * FROM public.school_schools WHERE status IN ('approved', 'active')`;
  const params = [];
  let index = 1;

  if (country) {
    sql += ` AND country ILIKE $${index}`;
    params.push(`%${country}%`);
    index += 1;
  }

  if (city) {
    sql += ` AND city ILIKE $${index}`;
    params.push(`%${city}%`);
    index += 1;
  }

  if (type) {
    sql += ` AND school_type ILIKE $${index}`;
    params.push(`%${type}%`);
    index += 1;
  }

  sql += ' ORDER BY created_at DESC';

  const result = await query(sql, params);
  res.json({ success: true, data: result.rows });
});

const createParentStudent = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { schoolId, firstName, lastName, age, gradeLevel, classId } = req.body;

  if (!schoolId || !firstName || !lastName) {
    return res.status(400).json({ success: false, error: 'Les informations de l’élève sont incomplètes.' });
  }

  const result = await query(
    `INSERT INTO public.school_students (school_id, parent_id, first_name, last_name, age, grade_level, class_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
     RETURNING *`,
    [schoolId, userId, firstName, lastName, age || 0, gradeLevel || '', classId || null]
  );

  res.status(201).json({ success: true, data: result.rows[0], message: 'Élève ajouté avec succès.' });
});

const createClass = asyncHandler(async (req, res) => {
  const { schoolId, name, level, capacity } = req.body;
  if (!schoolId || !name) return res.status(400).json({ success: false, error: 'Nom de classe et école requis' });

  const result = await query(
    `INSERT INTO public.school_classes (school_id, name, level, capacity)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [schoolId, name, level || '', capacity || 30]
  );
  res.status(201).json({ success: true, data: result.rows[0] });
});

const createTeacher = asyncHandler(async (req, res) => {
  const { schoolId, userId, fullName, subject, email, phone } = req.body;
  if (!schoolId || !fullName) return res.status(400).json({ success: false, error: 'Nom et école requis' });

  const result = await query(
    `INSERT INTO public.school_teachers (school_id, user_id, full_name, subject, email, phone)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [schoolId, userId, fullName, subject || '', email || '', phone || '']
  );
  res.status(201).json({ success: true, data: result.rows[0] });
});

const createAssignment = asyncHandler(async (req, res) => {
  const { schoolId, classId, title, description, dueDate } = req.body;
  const teacherId = req.userId;

  const result = await query(
    `INSERT INTO public.school_assignments (school_id, class_id, teacher_id, title, description, due_date)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [schoolId, classId, teacherId, title, description || '', dueDate]
  );
  res.status(201).json({ success: true, data: result.rows[0] });
});

const createPayment = asyncHandler(async (req, res) => {
  const { schoolId, studentId, parentId, amount, reference, status } = req.body;
  const result = await query(
    `INSERT INTO public.school_payments (school_id, student_id, parent_id, amount, reference, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [schoolId, studentId, parentId || req.userId, amount, reference, status || 'pending']
  );
  res.status(201).json({ success: true, data: result.rows[0] });
});

const sendMessage = asyncHandler(async (req, res) => {
  const { schoolId, recipientId, message } = req.body;
  const senderId = req.userId;

  const result = await query(
    `INSERT INTO public.school_messages (school_id, sender_id, recipient_id, message)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [schoolId, senderId, recipientId, message]
  );

  socketService.sendToUser(recipientId, 'school:new_message', { from: senderId, message });
  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Get user's current school membership
 */
const getMySchool = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const result = await query(
    `SELECT s.*, sm.role
     FROM public.school_members sm
     JOIN public.school_schools s ON s.id = sm.school_id
     WHERE sm.user_id = $1 AND sm.is_active = TRUE
     ORDER BY s.created_at DESC
     LIMIT 1`,
    [userId]
  );

  res.json({ success: true, data: result.rows[0] || null });
});

/**
 * @desc    Request creation of a staff account (Promoter only)
 */
const requestStaffAccount = asyncHandler(async (req, res) => {
  const promoterId = req.userId;
  const { schoolId, fullName, email, roleRequested } = req.body;

  if (!schoolId || !fullName || !email || !roleRequested) {
    return res.status(400).json({ success: false, error: 'Toutes les informations sont requises.' });
  }

  // Verify requester is promoter of the school
  const check = await query('SELECT id FROM public.school_members WHERE school_id = $1 AND user_id = $2 AND role = \'promoter\'', [schoolId, promoterId]);
  if (check.rows.length === 0) return res.status(403).json({ success: false, error: 'Accès refusé' });

  const result = await query(
    `INSERT INTO public.school_staff_requests (school_id, promoter_id, full_name, email, role_requested)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [schoolId, promoterId, fullName, email, roleRequested]
  );

  // Notify Principal Admin
  socketService.broadcast('admin:new_staff_request', { schoolId, fullName, role: roleRequested });

  res.status(201).json({ success: true, message: 'Demande de compte staff envoyée à l’administrateur.' });
});

/**
 * @desc    Submit an enrollment request to a school (Parent)
 */
const submitEnrollmentRequest = asyncHandler(async (req, res) => {
  const parentId = req.userId;
  const { schoolId, firstName, lastName, age, level } = req.body;

  if (!schoolId || !firstName || !lastName) {
    return res.status(400).json({ success: false, error: 'Champs obligatoires manquants.' });
  }

  const result = await query(
    `INSERT INTO public.school_enrollment_requests (school_id, parent_id, student_first_name, student_last_name, student_age, previous_level)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [schoolId, parentId, firstName, lastName, age, level]
  );

  // Notify Promoter
  const school = await query('SELECT created_by, name FROM public.school_schools WHERE id = $1', [schoolId]);
  if (school.rows.length > 0) {
    socketService.sendToUser(school.rows[0].created_by, 'school:new_enrollment', {
      schoolName: school.rows[0].name,
      studentName: `${firstName} ${lastName}`
    });
  }

  res.status(201).json({ success: true, message: 'Demande d’inscription envoyée avec succès.' });
});

/**
 * @desc    Approve enrollment and assign class (Promoter)
 */
const handleEnrollment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, classId } = req.body; // 'approved' or 'rejected'

  const requestRes = await query('SELECT * FROM public.school_enrollment_requests WHERE id = $1', [id]);
  if (requestRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Demande non trouvée' });
  const request = requestRes.rows[0];

  if (status === 'approved') {
    if (!classId) return res.status(400).json({ success: false, error: 'Veuillez assigner une classe.' });

    // 1. Create the student profile
    const student = await query(
      `INSERT INTO public.school_students (school_id, parent_id, first_name, last_name, age, grade_level, class_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [request.school_id, request.parent_id, request.student_first_name, request.student_last_name, request.student_age, request.previous_level, classId]
    );

    // 2. Mark request as approved
    await query("UPDATE public.school_enrollment_requests SET status = 'approved' WHERE id = $1", [id]);

    socketService.emitToUser(request.parent_id, 'school:enrollment_approved', { studentId: student.rows[0].id });
  } else {
    await query("UPDATE public.school_enrollment_requests SET status = 'rejected' WHERE id = $1", [id]);
  }

  res.json({ success: true, message: 'Statut mis à jour.' });
});

/**
 * @desc    Get school full profile for visitors
 */
const getSchoolProfile = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const school = await query('SELECT * FROM public.school_schools WHERE id = $1', [id]);
  const announcements = await query('SELECT * FROM public.school_announcements WHERE school_id = $1 ORDER BY created_at DESC', [id]);
  const classes = await query('SELECT id, name, level FROM public.school_classes WHERE school_id = $1', [id]);

  if (school.rows.length === 0) return res.status(404).json({ success: false, error: 'École non trouvée' });

  res.json({
    success: true,
    data: {
      school: school.rows[0],
      announcements: announcements.rows,
      classes: classes.rows
    }
  });
});

/**
 * @desc    Get all pending enrollment requests for a school (Promoter/Director)
 */
const getEnrollmentRequests = asyncHandler(async (req, res) => {
  const { schoolId } = req.query;
  const userId = req.userId;

  // Verify access
  const check = await query('SELECT id FROM public.school_members WHERE school_id = $1 AND user_id = $2 AND role IN (\'promoter\', \'director\')', [schoolId, userId]);
  if (check.rows.length === 0) return res.status(403).json({ success: false, error: 'Accès refusé' });

  const result = await query(
    `SELECT er.*, p.full_name as parent_name, p.avatar_url as parent_avatar
     FROM public.school_enrollment_requests er
     JOIN public.profiles p ON er.parent_id = p.id
     WHERE er.school_id = $1 AND er.status = 'pending'
     ORDER BY er.created_at DESC`,
    [schoolId]
  );

  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Get all classes for a school
 */
const getSchoolClasses = asyncHandler(async (req, res) => {
  const { schoolId } = req.query;
  const result = await query('SELECT * FROM public.school_classes WHERE school_id = $1 ORDER BY level ASC, name ASC', [schoolId]);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Get school schedules (Calendar)
 */
const getSchedules = asyncHandler(async (req, res) => {
  const { schoolId, classId } = req.query;
  const userId = req.userId;

  let sql = `SELECT * FROM public.school_schedules WHERE 1=1`;
  const params = [];

  if (schoolId) {
    sql += ` AND class_id IN (SELECT id FROM public.school_classes WHERE school_id = $1)`;
    params.push(schoolId);
  }

  if (classId) {
    sql += ` AND class_id = $${params.length + 1}`;
    params.push(classId);
  }

  sql += ` ORDER BY day_of_week ASC, start_time ASC`;

  const result = await query(sql, params);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Get school advanced statistics
 */
const getStats = asyncHandler(async (req, res) => {
  const { schoolId } = req.query;
  const userId = req.userId;

  // Verify access (Promoter or Director only)
  const check = await query('SELECT id FROM public.school_members WHERE school_id = $1 AND user_id = $2 AND role IN (\'promoter\', \'director\')', [schoolId, userId]);
  if (check.rows.length === 0) return res.status(403).json({ success: false, error: 'Accès refusé' });

  const [students, teachers, classes, payments] = await Promise.all([
    query('SELECT COUNT(*) FROM public.school_students WHERE school_id = $1', [schoolId]),
    query('SELECT COUNT(*) FROM public.school_teachers WHERE school_id = $1', [schoolId]),
    query('SELECT COUNT(*) FROM public.school_classes WHERE school_id = $1', [schoolId]),
    query(`SELECT
            SUM(amount) as total_revenue,
            COUNT(*) filter (where status = 'completed') as paid_count,
            COUNT(*) filter (where status = 'pending') as pending_count
           FROM public.school_payments WHERE school_id = $1`, [schoolId])
  ]);

  res.json({
    success: true,
    data: {
      totalStudents: parseInt(students.rows[0].count),
      totalTeachers: parseInt(teachers.rows[0].count),
      totalClasses: parseInt(classes.rows[0].count),
      revenue: parseFloat(payments.rows[0].total_revenue || 0),
      payments: {
        paid: parseInt(payments.rows[0].paid_count),
        pending: parseInt(payments.rows[0].pending_count)
      }
    }
  });
});

module.exports = {
  getSchoolOverview,
  createSchool,
  getDashboard,
  getMySchool,
  submitAssignment,
  addGrade,
  getSchools,
  createParentStudent,
  createClass,
  createTeacher,
  createAssignment,
  createPayment,
  sendMessage,
  requestStaffAccount,
  submitEnrollmentRequest,
  handleEnrollment,
  getSchoolProfile,
  getEnrollmentRequests,
  getSchoolClasses,
  getSchedules,
  getStats
};
