const { query } = require('../config/db');
const { asyncHandler } = require('../middleware/error.middleware');

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
       LIMIT 20`,
      [userId]
    ),
    query(
      `SELECT COUNT(*) AS total_students
       FROM public.school_students st
       JOIN public.school_members sm ON sm.school_id = st.school_id
       WHERE sm.user_id = $1 AND sm.is_active = TRUE`,
      [userId]
    ),
    query(
      `SELECT COUNT(*) AS total_assignments
       FROM public.school_assignments sa
       JOIN public.school_members sm ON sm.school_id = sa.school_id
       WHERE sm.user_id = $1 AND sm.is_active = TRUE`,
      [userId]
    )
  ]);

  const dashboard = {
    role: schoolMembership.rows[0]?.role || 'parent',
    school: schoolMembership.rows[0] || null,
    stats: {
      totalSchools: worldSchools.rows.length,
      totalStudents: parseInt(myStudents.rows[0]?.total_students || 0, 10),
      totalAssignments: parseInt(pendingAssignments.rows[0]?.total_assignments || 0, 10),
      totalMembers: schoolMembership.rows[0]
        ? await query('SELECT COUNT(*) AS total_members FROM public.school_members WHERE school_id = $1 AND is_active = TRUE', [schoolMembership.rows[0].id]).then(r => parseInt(r.rows[0].total_members || 0, 10))
        : 0
    }
  };

  res.json({
    success: true,
    data: {
      dashboard,
      worldSchools: worldSchools.rows,
      mySchool: schoolMembership.rows[0] || null
    }
  });
});

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

  await query(
    `INSERT INTO public.school_members (school_id, user_id, role, is_active)
     VALUES ($1, $2, 'promoter', TRUE)`,
    [school.id, userId]
  );

  res.status(201).json({
    success: true,
    message: 'École créée avec succès. Elle est en attente de validation.',
    data: school
  });
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

const getDashboard = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const membership = await query(
    `SELECT sm.role, sm.school_id
     FROM public.school_members sm
     WHERE sm.user_id = $1 AND sm.is_active = TRUE
     ORDER BY sm.created_at DESC
     LIMIT 1`,
    [userId]
  );

  if (membership.rows.length === 0) {
    return res.json({ success: true, data: { role: 'parent', school: null, stats: {}, students: [], teachers: [], classes: [], assignments: [], grades: [], payments: [], messages: [] } });
  }

  const schoolId = membership.rows[0].school_id;
  const role = membership.rows[0].role;

  const [school, students, teachers, classes, assignments, grades, payments, messages] = await Promise.all([
    query('SELECT * FROM public.school_schools WHERE id = $1', [schoolId]),
    query('SELECT * FROM public.school_students WHERE school_id = $1 ORDER BY created_at DESC LIMIT 20', [schoolId]),
    query('SELECT * FROM public.school_teachers WHERE school_id = $1 ORDER BY created_at DESC LIMIT 20', [schoolId]),
    query('SELECT * FROM public.school_classes WHERE school_id = $1 ORDER BY created_at DESC LIMIT 20', [schoolId]),
    query('SELECT * FROM public.school_assignments WHERE school_id = $1 ORDER BY due_date ASC LIMIT 20', [schoolId]),
    query('SELECT * FROM public.school_grades WHERE school_id = $1 ORDER BY created_at DESC LIMIT 20', [schoolId]),
    query('SELECT * FROM public.school_payments WHERE school_id = $1 ORDER BY created_at DESC LIMIT 20', [schoolId]),
    query('SELECT * FROM public.school_messages WHERE school_id = $1 ORDER BY created_at DESC LIMIT 20', [schoolId])
  ]);

  const stats = {
    students: students.rows.length,
    teachers: teachers.rows.length,
    classes: classes.rows.length,
    assignments: assignments.rows.length,
    payments: payments.rows.length,
    messages: messages.rows.length,
    grades: grades.rows.length
  };

  res.json({
    success: true,
    data: {
      role,
      school: school.rows[0] || null,
      stats,
      students: students.rows,
      teachers: teachers.rows,
      classes: classes.rows,
      assignments: assignments.rows,
      grades: grades.rows,
      payments: payments.rows,
      messages: messages.rows
    }
  });
});

const createParentStudent = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { schoolId, firstName, lastName, age, gradeLevel, classId } = req.body;

  if (!schoolId || !firstName || !lastName) {
    return res.status(400).json({ success: false, error: 'Les informations de l’élève sont incomplètes.' });
  }

  const schoolCheck = await query('SELECT id FROM public.school_schools WHERE id = $1', [schoolId]);
  if (schoolCheck.rows.length === 0) {
    return res.status(404).json({ success: false, error: 'École introuvable.' });
  }

  const result = await query(
    `INSERT INTO public.school_students (school_id, parent_id, first_name, last_name, age, grade_level, class_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
     RETURNING *`,
    [schoolId, userId, firstName, lastName, age || 0, gradeLevel || '', classId || null,]
  );

  res.status(201).json({ success: true, data: result.rows[0], message: 'Élève ajouté avec succès.' });
});

const createClass = asyncHandler(async (req, res) => {
  const { schoolId, name, level, capacity } = req.body;

  if (!schoolId || !name) {
    return res.status(400).json({ success: false, error: 'Le nom de la classe et l’école sont requis.' });
  }

  const result = await query(
    `INSERT INTO public.school_classes (school_id, name, level, capacity)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [schoolId, name, level || '', capacity || 30]
  );

  res.status(201).json({ success: true, data: result.rows[0], message: 'Classe créée.' });
});

const createTeacher = asyncHandler(async (req, res) => {
  const { schoolId, fullName, subject, email, phone } = req.body;

  if (!schoolId || !fullName) {
    return res.status(400).json({ success: false, error: 'Le professeur et l’école sont requis.' });
  }

  const result = await query(
    `INSERT INTO public.school_teachers (school_id, full_name, subject, email, phone)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [schoolId, fullName, subject || '', email || '', phone || '']
  );

  res.status(201).json({ success: true, data: result.rows[0], message: 'Enseignant ajouté.' });
});

const createAssignment = asyncHandler(async (req, res) => {
  const { schoolId, classId, teacherId, title, description, dueDate } = req.body;

  if (!schoolId || !title) {
    return res.status(400).json({ success: false, error: 'Le devoir nécessite un titre et une école.' });
  }

  const result = await query(
    `INSERT INTO public.school_assignments (school_id, class_id, teacher_id, title, description, due_date)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [schoolId, classId || null, teacherId || null, title, description || '', dueDate || null]
  );

  res.status(201).json({ success: true, data: result.rows[0], message: 'Devoir créé.' });
});

const createGrade = asyncHandler(async (req, res) => {
  const { schoolId, studentId, teacherId, classId, subject, score, comment } = req.body;

  if (!schoolId || !studentId || !subject || score === undefined) {
    return res.status(400).json({ success: false, error: 'Les notes sont incomplètes.' });
  }

  const result = await query(
    `INSERT INTO public.school_grades (school_id, student_id, teacher_id, class_id, subject, score, comment)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [schoolId, studentId, teacherId || null, classId || null, subject, score, comment || '']
  );

  res.status(201).json({ success: true, data: result.rows[0], message: 'Note ajoutée.' });
});

const createPayment = asyncHandler(async (req, res) => {
  const { schoolId, studentId, parentId, amount, reference, status } = req.body;

  if (!schoolId || !amount) {
    return res.status(400).json({ success: false, error: 'Le montant et l’école sont requis.' });
  }

  const result = await query(
    `INSERT INTO public.school_payments (school_id, student_id, parent_id, amount, reference, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [schoolId, studentId || null, parentId || req.userId, amount, reference || '', status || 'pending']
  );

  res.status(201).json({ success: true, data: result.rows[0], message: 'Paiement enregistré.' });
});

const sendMessage = asyncHandler(async (req, res) => {
  const { schoolId, recipientId, channel, message } = req.body;

  if (!schoolId || !message) {
    return res.status(400).json({ success: false, error: 'Le message est vide.' });
  }

  const result = await query(
    `INSERT INTO public.school_messages (school_id, sender_id, recipient_id, channel, message)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [schoolId, req.userId, recipientId || null, channel || 'school', message]
  );

  res.status(201).json({ success: true, data: result.rows[0], message: 'Message envoyé.' });
});

module.exports = {
  getSchoolOverview,
  createSchool,
  getSchools,
  getMySchool,
  getDashboard,
  createParentStudent,
  createClass,
  createTeacher,
  createAssignment,
  createGrade,
  createPayment,
  sendMessage
};
