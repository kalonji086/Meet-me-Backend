const express = require('express');
const router = express.Router();
const schoolController = require('../controllers/school.extended.controller');
const { authenticate, isAdmin } = require('../middleware/auth.middleware');

// Routes privées (Utilisateurs connectés)
router.post('/request', authenticate, schoolController.submitSchoolRequest);
router.get('/status', authenticate, schoolController.getSchoolStatus);
router.get('/dashboard', authenticate, schoolController.getSchoolDashboardData);

// Sub-modules École existants
router.get('/students', authenticate, schoolController.getStudents);
router.post('/students', authenticate, schoolController.addStudent);
router.delete('/students/:id', authenticate, schoolController.deleteStudent);
router.get('/classes', authenticate, schoolController.getClasses);
router.post('/classes', authenticate, schoolController.addClass);
router.delete('/classes/:id', authenticate, schoolController.deleteClass);
router.get('/schedules', authenticate, schoolController.getSchedules);
router.post('/schedules', authenticate, schoolController.addSchedule);
router.get('/fees', authenticate, schoolController.getFees);
router.post('/fees', authenticate, schoolController.addFeeInvoice);
router.get('/account-requests', authenticate, schoolController.getAccountRequests);
router.post('/account-requests', authenticate, schoolController.addAccountRequest);

// Nouvelles fonctionnalités : Gestion des matières
router.get('/subjects', authenticate, schoolController.getSubjects);
router.post('/subjects', authenticate, schoolController.addSubject);

// Nouvelles fonctionnalités : Notes et évaluations
router.get('/evaluations', authenticate, schoolController.getEvaluations);
router.post('/evaluations', authenticate, schoolController.addEvaluation);
router.get('/evaluations/:evaluationId/grades', authenticate, schoolController.getEvaluationGrades);
router.post('/evaluations/:evaluationId/grades', authenticate, schoolController.addEvaluationGrades);

// Nouvelles fonctionnalités : Gestion des présences
router.get('/attendance', authenticate, schoolController.getAttendance);
router.post('/attendance', authenticate, schoolController.recordAttendance);
router.get('/attendance/stats', authenticate, schoolController.getAttendanceStats);

// Nouvelles fonctionnalités : Ressources pédagogiques
router.get('/resources', authenticate, schoolController.getResources);
router.post('/resources', authenticate, schoolController.addResource);

// Nouvelles fonctionnalités : Rapports et analytics
router.get('/reports', authenticate, schoolController.getSchoolReports);
router.get('/export', authenticate, schoolController.exportSchoolData);

// Login Universel par Code (Public)
router.post('/login-by-code', schoolController.loginByCode);

// Route Admin d'approbation
router.put('/approve/:requestId', authenticate, isAdmin, schoolController.approveSchoolRequest);

module.exports = router;
