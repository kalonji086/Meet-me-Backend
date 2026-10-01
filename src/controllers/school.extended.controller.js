const { query } = require('../config/db');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/error.middleware');
const socketService = require('../services/socket.service');

// Importer les fonctions du contrôleur original
const schoolController = require('./school.controller');

/**
 * Helper pour obtenir l'école du promoteur (réutilisé du contrôleur original)
 */
const getPromoterSchool = async (userId) => {
  const isValidUUID = (str) => {
    if (!str || typeof str !== 'string') return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim());
  };

  if (!isValidUUID(userId)) return null;

  let result = await query(
    "SELECT * FROM public.school_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
    [userId]
  );
  if (result.rows.length > 0) return result.rows[0];

  return null;
};

/**
 * @desc    Get all subjects for a school
 * @route   GET /api/school/subjects
 * @access  Private
 */
const getSubjects = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  const result = await query(
    'SELECT * FROM public.school_subjects WHERE school_id = $1 ORDER BY name ASC',
    [school.id]
  );

  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Add or update a subject
 * @route   POST /api/school/subjects
 * @access  Private
 */
const addSubject = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  const { id, name, code, teacherName, isActive } = req.body;

  if (!name || name.trim() === '') {
    return res.status(400).json({ success: false, error: 'Le nom de la matière est requis.' });
  }

  try {
    if (id) {
      const result = await query(
        `UPDATE public.school_subjects
         SET name = $1, code = $2, teacher_name = $3, is_active = $4
         WHERE id = $5 AND school_id = $6 RETURNING *`,
        [name.trim(), code || null, teacherName || null, isActive !== undefined ? isActive : true, id, school.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Matière introuvable.' });
      }
      return res.json({ success: true, data: result.rows[0] });
    }

    const result = await query(
      `INSERT INTO public.school_subjects (school_id, name, code, teacher_name, is_active)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [school.id, name.trim(), code || null, teacherName || null, true]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    logger.error('Error adding/updating subject:', err.message);
    res.status(400).json({
      success: false,
      error: err.message || 'Erreur lors de l\'enregistrement de la matière.'
    });
  }
});

/**
 * @desc    Get all evaluations for a school
 * @route   GET /api/school/evaluations
 * @access  Private
 */
const getEvaluations = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  const { classId, subjectId } = req.query;

  let queryStr = `
    SELECT e.*,
           c.name as class_name,
           s.name as subject_name,
           (SELECT COUNT(*) FROM public.school_grades g WHERE g.evaluation_id = e.id) as grades_count
    FROM public.school_evaluations e
    LEFT JOIN public.school_classes c ON e.class_id = c.id
    LEFT JOIN public.school_subjects s ON e.subject_id = s.id
    WHERE e.school_id = $1
  `;
  const params = [school.id];
  let paramCount = 1;

  if (classId) {
    paramCount++;
    queryStr += ` AND e.class_id = $${paramCount}`;
    params.push(classId);
  }

  if (subjectId) {
    paramCount++;
    queryStr += ` AND e.subject_id = $${paramCount}`;
    params.push(subjectId);
  }

  queryStr += ' ORDER BY e.evaluation_date DESC';

  const result = await query(queryStr, params);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Create a new evaluation
 * @route   POST /api/school/evaluations
 * @access  Private
 */
const addEvaluation = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  const { title, type, classId, subjectId, maxScore, evaluationDate, description } = req.body;

  if (!title || !type || !evaluationDate) {
    return res.status(400).json({ success: false, error: 'Titre, type et date d\'évaluation sont requis.' });
  }

  // Vérifier que la classe existe dans cette école
  if (classId) {
    const classCheck = await query(
      'SELECT id FROM public.school_classes WHERE id = $1 AND school_id = $2',
      [classId, school.id]
    );
    if (classCheck.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'Classe invalide.' });
    }
  }

  // Vérifier que la matière existe dans cette école
  if (subjectId) {
    const subjectCheck = await query(
      'SELECT id FROM public.school_subjects WHERE id = $1 AND school_id = $2',
      [subjectId, school.id]
    );
    if (subjectCheck.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'Matière invalide.' });
    }
  }

  const result = await query(
    `INSERT INTO public.school_evaluations
     (school_id, class_id, subject_id, title, type, max_score, evaluation_date, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [school.id, classId || null, subjectId || null, title.trim(), type, maxScore || 20, evaluationDate, description || null]
  );

  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Get grades for an evaluation
 * @route   GET /api/school/evaluations/:evaluationId/grades
 * @access  Private
 */
const getEvaluationGrades = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  const { evaluationId } = req.params;

  // Vérifier que l'évaluation appartient à cette école
  const evalCheck = await query(
    'SELECT id FROM public.school_evaluations WHERE id = $1 AND school_id = $2',
    [evaluationId, school.id]
  );
  if (evalCheck.rows.length === 0) {
    return res.status(404).json({ success: false, error: 'Évaluation introuvable.' });
  }

  const result = await query(
    `SELECT g.*,
            s.full_name as student_name,
            s.class_id,
            c.name as class_name
     FROM public.school_grades g
     JOIN public.school_students s ON g.student_id = s.id
     LEFT JOIN public.school_classes c ON s.class_id = c.id
     WHERE g.evaluation_id = $1
     ORDER BY s.full_name ASC`,
    [evaluationId]
  );

  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Add or update grades for an evaluation
 * @route   POST /api/school/evaluations/:evaluationId/grades
 * @access  Private
 */
const addEvaluationGrades = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  const { evaluationId } = req.params;
  const { grades } = req.body; // Array de { studentId, score, comment }

  if (!Array.isArray(grades) || grades.length === 0) {
    return res.status(400).json({ success: false, error: 'Les notes sont requises.' });
  }

  // Vérifier que l'évaluation appartient à cette école
  const evalCheck = await query(
    'SELECT id, max_score FROM public.school_evaluations WHERE id = $1 AND school_id = $2',
    [evaluationId, school.id]
  );
  if (evalCheck.rows.length === 0) {
    return res.status(404).json({ success: false, error: 'Évaluation introuvable.' });
  }

  const maxScore = evalCheck.rows[0].max_score || 20;
  const results = [];

  for (const grade of grades) {
    const { studentId, score, comment } = grade;

    // Vérifier que l'élève appartient à cette école
    const studentCheck = await query(
      'SELECT id FROM public.school_students WHERE id = $1 AND school_id = $2',
      [studentId, school.id]
    );
    if (studentCheck.rows.length === 0) {
      results.push({ studentId, error: 'Élève introuvable dans cette école' });
      continue;
    }

    // Vérifier que le score est valide
    const numericScore = parseFloat(score);
    if (isNaN(numericScore) || numericScore < 0 || numericScore > maxScore) {
      results.push({ studentId, error: `Score invalide. Doit être entre 0 et ${maxScore}` });
      continue;
    }

    try {
      // Essayer de mettre à jour si la note existe déjà
      const updateResult = await query(
        `UPDATE public.school_grades
         SET score = $1, comment = $2
         WHERE evaluation_id = $3 AND student_id = $4
         RETURNING *`,
        [numericScore, comment || null, evaluationId, studentId]
      );

      if (updateResult.rows.length > 0) {
        results.push({ studentId, success: true, data: updateResult.rows[0] });
      } else {
        // Sinon insérer une nouvelle note
        const insertResult = await query(
          `INSERT INTO public.school_grades (evaluation_id, student_id, score, comment)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [evaluationId, studentId, numericScore, comment || null]
        );
        results.push({ studentId, success: true, data: insertResult.rows[0] });
      }
    } catch (err) {
      logger.error(`Error processing grade for student ${studentId}:`, err.message);
      results.push({ studentId, error: err.message });
    }
  }

  // Publier l'évaluation après ajout des notes
  await query(
    'UPDATE public.school_evaluations SET is_published = TRUE WHERE id = $1',
    [evaluationId]
  );

  res.json({
    success: true,
    message: 'Notes enregistrées avec succès',
    results,
    published: true
  });
});

/**
 * @desc    Get student attendance
 * @route   GET /api/school/attendance
 * @access  Private
 */
const getAttendance = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  const { startDate, endDate, classId, studentId } = req.query;

  let queryStr = `
    SELECT a.*,
           s.full_name as student_name,
           c.name as class_name
    FROM public.school_attendance a
    JOIN public.school_students s ON a.student_id = s.id
    LEFT JOIN public.school_classes c ON a.class_id = c.id
    WHERE a.school_id = $1
  `;
  const params = [school.id];
  let paramCount = 1;

  if (startDate) {
    paramCount++;
    queryStr += ` AND a.date >= $${paramCount}`;
    params.push(startDate);
  }

  if (endDate) {
    paramCount++;
    queryStr += ` AND a.date <= $${paramCount}`;
    params.push(endDate);
  }

  if (classId) {
    paramCount++;
    queryStr += ` AND a.class_id = $${paramCount}`;
    params.push(classId);
  }

  if (studentId) {
    paramCount++;
    queryStr += ` AND a.student_id = $${paramCount}`;
    params.push(studentId);
  }

  queryStr += ' ORDER BY a.date DESC, s.full_name ASC';

  const result = await query(queryStr, params);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Record attendance
 * @route   POST /api/school/attendance
 * @access  Private
 */
const recordAttendance = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  const { date, records } = req.body; // Array de { studentId, status, reason }

  if (!date || !Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ success: false, error: 'Date et enregistrements de présence requis.' });
  }

  const results = [];

  for (const record of records) {
    const { studentId, status, reason, classId } = record;

    // Vérifier que l'élève appartient à cette école
    const studentCheck = await query(
      'SELECT id, class_id FROM public.school_students WHERE id = $1 AND school_id = $2',
      [studentId, school.id]
    );
    if (studentCheck.rows.length === 0) {
      results.push({ studentId, error: 'Élève introuvable dans cette école' });
      continue;
    }

    const studentClassId = classId || studentCheck.rows[0].class_id;

    // Vérifier que le statut est valide
    const validStatuses = ['present', 'absent', 'excused', 'late'];
    if (!validStatuses.includes(status)) {
      results.push({ studentId, error: 'Statut de présence invalide' });
      continue;
    }

    try {
      // Vérifier s'il y a déjà un enregistrement pour cette date
      const existing = await query(
        'SELECT id FROM public.school_attendance WHERE student_id = $1 AND date = $2',
        [studentId, date]
      );

      if (existing.rows.length > 0) {
        // Mettre à jour l'enregistrement existant
        const updateResult = await query(
          `UPDATE public.school_attendance
           SET status = $1, reason = $2, class_id = $3
           WHERE id = $4 RETURNING *`,
          [status, reason || null, studentClassId || null, existing.rows[0].id]
        );
        results.push({ studentId, success: true, data: updateResult.rows[0], updated: true });
      } else {
        // Créer un nouvel enregistrement
        const insertResult = await query(
          `INSERT INTO public.school_attendance
           (school_id, student_id, class_id, date, status, reason, verified_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [school.id, studentId, studentClassId || null, date, status, reason || null, 'system']
        );
        results.push({ studentId, success: true, data: insertResult.rows[0], created: true });
      }
    } catch (err) {
      logger.error(`Error recording attendance for student ${studentId}:`, err.message);
      results.push({ studentId, error: err.message });
    }
  }

  res.json({
    success: true,
    message: 'Présences enregistrées avec succès',
    date,
    results
  });
});

/**
 * @desc    Get attendance statistics
 * @route   GET /api/school/attendance/stats
 * @access  Private
 */
const getAttendanceStats = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  const { startDate, endDate } = req.query;

  // Calculer les statistiques de présence
  const statsQuery = `
    SELECT
      COUNT(*) as total_records,
      SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) as present_count,
      SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) as absent_count,
      SUM(CASE WHEN status = 'excused' THEN 1 ELSE 0 END) as excused_count,
      SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) as late_count
    FROM public.school_attendance
    WHERE school_id = $1
    ${startDate ? 'AND date >= $2' : ''}
    ${endDate ? 'AND date <= $3' : ''}
  `;

  const params = [school.id];
  if (startDate) params.push(startDate);
  if (endDate) params.push(endDate);

  const statsResult = await query(statsQuery, params);
  const stats = statsResult.rows[0];

  // Obtenir les élèves avec le plus d'absences
  const frequentAbsencesQuery = `
    SELECT s.id, s.full_name, c.name as class_name,
           COUNT(CASE WHEN a.status = 'absent' THEN 1 END) as absences_count
    FROM public.school_attendance a
    JOIN public.school_students s ON a.student_id = s.id
    LEFT JOIN public.school_classes c ON s.class_id = c.id
    WHERE a.school_id = $1 AND a.status = 'absent'
    GROUP BY s.id, s.full_name, c.name
    ORDER BY absences_count DESC
    LIMIT 10
  `;

  const frequentAbsences = await query(frequentAbsencesQuery, [school.id]);

  res.json({
    success: true,
    stats: {
      total: parseInt(stats.total_records) || 0,
      present: parseInt(stats.present_count) || 0,
      absent: parseInt(stats.absent_count) || 0,
      excused: parseInt(stats.excused_count) || 0,
      late: parseInt(stats.late_count) || 0,
      presenceRate: stats.total_records > 0 ?
        ((parseInt(stats.present_count) + parseInt(stats.late_count)) / parseInt(stats.total_records) * 100).toFixed(1) : 0
    },
    frequentAbsences: frequentAbsences.rows
  });
});

/**
 * @desc    Get school resources
 * @route   GET /api/school/resources
 * @access  Private
 */
const getResources = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  const { classId, subjectId, fileType } = req.query;

  let queryStr = `
    SELECT r.*,
           c.name as class_name,
           s.name as subject_name
    FROM public.school_resources r
    LEFT JOIN public.school_classes c ON r.class_id = c.id
    LEFT JOIN public.school_subjects s ON r.subject_id = s.id
    WHERE r.school_id = $1
  `;
  const params = [school.id];
  let paramCount = 1;

  if (classId) {
    paramCount++;
    queryStr += ` AND r.class_id = $${paramCount}`;
    params.push(classId);
  }

  if (subjectId) {
    paramCount++;
    queryStr += ` AND r.subject_id = $${paramCount}`;
    params.push(subjectId);
  }

  if (fileType) {
    paramCount++;
    queryStr += ` AND r.file_type = $${paramCount}`;
    params.push(fileType);
  }

  queryStr += ' ORDER BY r.created_at DESC';

  const result = await query(queryStr, params);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Add a resource
 * @route   POST /api/school/resources
 * @access  Private
 */
const addResource = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  const { title, description, fileUrl, fileType, fileSize, classId, subjectId, isPublic } = req.body;

  if (!title || !fileUrl) {
    return res.status(400).json({ success: false, error: 'Titre et URL du fichier sont requis.' });
  }

  // Vérifier les références si fournies
  if (classId) {
    const classCheck = await query(
      'SELECT id FROM public.school_classes WHERE id = $1 AND school_id = $2',
      [classId, school.id]
    );
    if (classCheck.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'Classe invalide.' });
    }
  }

  if (subjectId) {
    const subjectCheck = await query(
      'SELECT id FROM public.school_subjects WHERE id = $1 AND school_id = $2',
      [subjectId, school.id]
    );
    if (subjectCheck.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'Matière invalide.' });
    }
  }

  const result = await query(
    `INSERT INTO public.school_resources
     (school_id, class_id, subject_id, title, description, file_url, file_type, file_size, is_public, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [school.id, classId || null, subjectId || null, title.trim(), description || null, fileUrl,
     fileType || null, fileSize || null, isPublic || false, userId]
  );

  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Get school reports and analytics
 * @route   GET /api/school/reports
 * @access  Private
 */
const getSchoolReports = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  const { reportType, startDate, endDate } = req.query;

  switch (reportType) {
    case 'academic_performance':
      // Rapport de performance académique
      const performanceQuery = `
        SELECT
          c.name as class_name,
          COUNT(DISTINCT s.id) as student_count,
          COUNT(g.id) as grade_count,
          ROUND(AVG(g.score), 2) as average_score,
          ROUND(MIN(g.score), 2) as min_score,
          ROUND(MAX(g.score), 2) as max_score
        FROM public.school_classes c
        LEFT JOIN public.school_students s ON c.id = s.class_id AND s.school_id = $1
        LEFT JOIN public.school_grades g ON s.id = g.student_id
        WHERE c.school_id = $1
        GROUP BY c.id, c.name
        ORDER BY c.name
      `;
      const performanceResult = await query(performanceQuery, [school.id]);

      // Top performers
      const topPerformersQuery = `
        SELECT s.full_name, c.name as class_name,
               ROUND(AVG(g.score), 2) as average_score,
               COUNT(g.id) as evaluations_count
        FROM public.school_students s
        LEFT JOIN public.school_classes c ON s.class_id = c.id
        LEFT JOIN public.school_grades g ON s.id = g.student_id
        WHERE s.school_id = $1 AND g.score IS NOT NULL
        GROUP BY s.id, s.full_name, c.name
        HAVING COUNT(g.id) >= 3
        ORDER BY average_score DESC
        LIMIT 10
      `;
      const topPerformers = await query(topPerformersQuery, [school.id]);

      return res.json({
        success: true,
        reportType: 'academic_performance',
        data: {
          byClass: performanceResult.rows,
          topPerformers: topPerformers.rows,
          generatedAt: new Date().toISOString()
        }
      });

    case 'financial_summary':
      // Rapport financier
      const financialQuery = `
        SELECT
          'Frais scolaires' as category,
          COUNT(*) as total_invoices,
          SUM(amount_due) as total_due,
          SUM(amount_paid) as total_paid,
          SUM(amount_due - amount_paid) as total_balance
        FROM public.school_fees
        WHERE school_id = $1

        UNION ALL

        SELECT
          'Paiements' as category,
          COUNT(*) as total_payments,
          SUM(amount) as total_amount,
          0 as total_paid,
          0 as total_balance
        FROM public.school_payments
        WHERE school_id = $1 AND status = 'completed'
      `;
      const financialResult = await query(financialQuery, [school.id]);

      // Détails des paiements récents
      const recentPaymentsQuery = `
        SELECT p.*, s.full_name as student_name
        FROM public.school_payments p
        JOIN public.school_students s ON p.student_id = s.id
        WHERE p.school_id = $1
        ORDER BY p.created_at DESC
        LIMIT 20
      `;
      const recentPayments = await query(recentPaymentsQuery, [school.id]);

      return res.json({
        success: true,
        reportType: 'financial_summary',
        data: {
          summary: financialResult.rows,
          recentPayments: recentPayments.rows,
          generatedAt: new Date().toISOString()
        }
      });

    case 'attendance_summary':
      // Rapport de présence
      const attendanceSummaryQuery = `
        SELECT
          DATE_TRUNC('month', date) as month,
          COUNT(*) as total_days,
          SUM(CASE WHEN status IN ('present', 'late') THEN 1 ELSE 0 END) as present_days,
          SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) as absent_days,
          ROUND(SUM(CASE WHEN status IN ('present', 'late') THEN 1 ELSE 0 END)::decimal / COUNT(*) * 100, 1) as presence_rate
        FROM public.school_attendance
        WHERE school_id = $1
        GROUP BY DATE_TRUNC('month', date)
        ORDER BY month DESC
        LIMIT 6
      `;
      const attendanceSummary = await query(attendanceSummaryQuery, [school.id]);

      return res.json({
        success: true,
        reportType: 'attendance_summary',
        data: {
          monthlySummary: attendanceSummary.rows,
          generatedAt: new Date().toISOString()
        }
      });

    default:
      return res.status(400).json({
        success: false,
        error: 'Type de rapport non supporté. Types disponibles: academic_performance, financial_summary, attendance_summary'
      });
  }
});

/**
 * @desc    Export school data
 * @route   GET /api/school/export
 * @access  Private
 */
const exportSchoolData = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const school = await getPromoterSchool(userId);
  if (!school) return res.status(403).json({ success: false, error: 'École introuvable' });

  const { dataType } = req.query;

  // Pour l'instant, retourner des données JSON
  // Dans une version future, on pourrait générer des fichiers CSV ou PDF
  switch (dataType) {
    case 'students':
      const students = await query(
        'SELECT * FROM public.school_students WHERE school_id = $1 ORDER BY full_name',
        [school.id]
      );
      return res.json({
        success: true,
        dataType: 'students',
        count: students.rows.length,
        data: students.rows,
        exportedAt: new Date().toISOString()
      });

    case 'grades':
      const grades = await query(
        `SELECT g.*, s.full_name as student_name, e.title as evaluation_title
         FROM public.school_grades g
         JOIN public.school_students s ON g.student_id = s.id
         JOIN public.school_evaluations e ON g.evaluation_id = e.id
         WHERE e.school_id = $1
         ORDER BY e.evaluation_date DESC, s.full_name`,
        [school.id]
      );
      return res.json({
        success: true,
        dataType: 'grades',
        count: grades.rows.length,
        data: grades.rows,
        exportedAt: new Date().toISOString()
      });

    case 'attendance':
      const attendance = await query(
        `SELECT a.*, s.full_name as student_name
         FROM public.school_attendance a
         JOIN public.school_students s ON a.student_id = s.id
         WHERE a.school_id = $1
         ORDER BY a.date DESC, s.full_name`,
        [school.id]
      );
      return res.json({
        success: true,
        dataType: 'attendance',
        count: attendance.rows.length,
        data: attendance.rows,
        exportedAt: new Date().toISOString()
      });

    default:
      return res.status(400).json({
        success: false,
        error: 'Type de données non supporté. Types disponibles: students, grades, attendance'
      });
  }
});

module.exports = {
  // Fonctions du contrôleur original
  ...schoolController,

  // Nouvelles fonctionnalités
  getSubjects,
  addSubject,
  getEvaluations,
  addEvaluation,
  getEvaluationGrades,
  addEvaluationGrades,
  getAttendance,
  recordAttendance,
  getAttendanceStats,
  getResources,
  addResource,
  getSchoolReports,
  exportSchoolData
};