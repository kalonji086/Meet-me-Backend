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
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [userId]
    ),
    query(
      `SELECT s.*,
              (SELECT COUNT(*) FROM public.school_members sm WHERE sm.school_id = s.id AND sm.is_active = TRUE) AS members_count
       FROM public.school_schools s
       WHERE s.status IN ('approved', 'active')
       ORDER BY s.created_at DESC
       LIMIT 50`,
      []
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
    const [grades, assignments, profile] = await Promise.all([
      query('SELECT * FROM public.school_grades WHERE school_id = $1 AND student_id = (SELECT id FROM public.school_students WHERE user_id = $2 AND school_id = $1) ORDER BY created_at DESC', [schoolId, userId]),
      query('SELECT * FROM public.school_assignments WHERE school_id = $1 ORDER BY due_date ASC', [schoolId]),
      query('SELECT * FROM public.school_students WHERE school_id = $1 AND user_id = $2', [schoolId, userId])
    ]);
    dashboardData.grades = grades.rows;
    dashboardData.assignments = assignments.rows;
    dashboardData.profile = profile.rows[0];
  }
  else if (role === 'parent') {
    const [children, payments] = await Promise.all([
      query('SELECT * FROM public.school_students WHERE school_id = $1 AND parent_id = $2', [schoolId, userId]),
      query('SELECT * FROM public.school_payments WHERE school_id = $1 AND parent_id = $2 ORDER BY created_at DESC', [schoolId, userId])
    ]);
    dashboardData.children = children.rows;
    dashboardData.payments = payments.rows;
  }
  else if (role === 'teacher') {
    const [myClasses, myAssignments] = await Promise.all([
      query(`SELECT c.* FROM public.school_classes c
             JOIN public.school_teacher_classes tc ON c.id = tc.class_id
             JOIN public.school_teachers t ON tc.teacher_id = t.id
             WHERE t.user_id = $1 AND t.school_id = $2`, [userId, schoolId]),
      query('SELECT * FROM public.school_assignments WHERE school_id = $1 AND teacher_id = $2', [schoolId, userId])
    ]);
    dashboardData.classes = myClasses.rows;
    dashboardData.assignments = myAssignments.rows;
  }
  else if (role === 'director' || role === 'promoter') {
    const [allStudents, allTeachers, allPayments] = await Promise.all([
      query('SELECT COUNT(*) FROM public.school_students WHERE school_id = $1', [schoolId]),
      query('SELECT COUNT(*) FROM public.school_teachers WHERE school_id = $1', [schoolId]),
      query('SELECT SUM(amount) FROM public.school_payments WHERE school_id = $1 AND status = \'completed\'', [schoolId])
    ]);
    dashboardData.stats = {
      totalStudents: parseInt(allStudents.rows[0].count),
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

module.exports = {
  getSchoolOverview,
  createSchool,
  getDashboard,
  submitAssignment,
  addGrade,
  getSchools,
  createParentStudent,
  createClass,
  createTeacher,
  createAssignment,
  createPayment,
  sendMessage
};
