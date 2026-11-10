const express = require('express');
const router = express.Router();
const schoolController = require('../controllers/school.extended.controller');
const schoolDirectoryController = require('../controllers/schoolDirectory.controller');
const { rateLimiter } = require('../middleware/error.middleware');
const {
  authenticate,
  authenticateSchoolSession,
  authenticateSchoolAccess,
  authorizeSchoolRoles,
  isAdmin
} = require('../middleware/auth.middleware');
const schoolCodeLoginLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
const schoolDirectorySearchLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
const schoolProposalLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 5 });
const schoolClaimLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 3 });
const schoolAdmissionLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });

// Routes privées (Utilisateurs connectés)
router.post('/request', authenticate, schoolController.submitSchoolRequest);
router.get('/status', authenticate, schoolController.getSchoolStatus);
router.get('/dashboard', authenticate, schoolController.getSchoolDashboardData);
router.get('/settings', authenticate, schoolController.getSchoolSettings);
router.put('/settings', authenticate, schoolController.updateSchoolSettings);

// Sub-modules École existants
router.get('/students', authenticateSchoolAccess, authorizeSchoolRoles('directeur', 'prefet', 'enseignant', 'professeur'), schoolController.getStudents);
router.post('/students', authenticateSchoolAccess, authorizeSchoolRoles('directeur'), schoolController.addStudent);
router.delete('/students/:id', authenticateSchoolAccess, authorizeSchoolRoles('directeur'), schoolController.deleteStudent);
router.get('/classes', authenticateSchoolAccess, authorizeSchoolRoles('directeur', 'prefet', 'enseignant', 'professeur'), schoolController.getClasses);
router.post('/classes', authenticateSchoolAccess, authorizeSchoolRoles('directeur'), schoolController.addClass);
router.delete('/classes/:id', authenticateSchoolAccess, authorizeSchoolRoles('directeur'), schoolController.deleteClass);
router.get('/schedules', authenticateSchoolAccess, authorizeSchoolRoles('directeur', 'prefet', 'enseignant', 'professeur'), schoolController.getSchedules);
router.post('/schedules', authenticateSchoolAccess, authorizeSchoolRoles('directeur'), schoolController.addSchedule);
router.get('/fees', authenticateSchoolAccess, authorizeSchoolRoles('directeur'), schoolController.getFees);
router.post('/fees', authenticateSchoolAccess, authorizeSchoolRoles('directeur'), schoolController.addFeeInvoice);
router.get('/account-requests', authenticateSchoolAccess, authorizeSchoolRoles('directeur'), schoolController.getAccountRequests);
router.post('/account-requests', authenticateSchoolAccess, authorizeSchoolRoles('directeur'), schoolController.addAccountRequest);
router.get('/parents', authenticateSchoolAccess, authorizeSchoolRoles('directeur'), schoolController.getSchoolParents);
router.post('/parents', authenticateSchoolAccess, authorizeSchoolRoles('directeur'), schoolController.addSchoolParent);
router.delete('/parents/:id', authenticateSchoolAccess, authorizeSchoolRoles('directeur'), schoolController.deactivateSchoolParent);

// Nouvelles fonctionnalités : Gestion des matières
router.get('/subjects', authenticateSchoolAccess, authorizeSchoolRoles('directeur', 'professeur'), schoolController.getSubjects);
router.post('/subjects', authenticateSchoolAccess, authorizeSchoolRoles('directeur'), schoolController.addSubject);

// Nouvelles fonctionnalités : Notes et évaluations
router.get('/evaluations', authenticateSchoolAccess, authorizeSchoolRoles('directeur', 'professeur'), schoolController.getEvaluations);
router.post('/evaluations', authenticateSchoolAccess, authorizeSchoolRoles('directeur', 'professeur'), schoolController.addEvaluation);
router.get('/evaluations/:evaluationId/grades', authenticateSchoolAccess, authorizeSchoolRoles('directeur', 'professeur'), schoolController.getEvaluationGrades);
router.post('/evaluations/:evaluationId/grades', authenticateSchoolAccess, authorizeSchoolRoles('directeur', 'professeur'), schoolController.addEvaluationGrades);

// Nouvelles fonctionnalités : Gestion des présences
router.get('/attendance', authenticateSchoolAccess, authorizeSchoolRoles('directeur', 'prefet', 'enseignant'), schoolController.getAttendance);
router.post('/attendance', authenticateSchoolAccess, authorizeSchoolRoles('directeur', 'enseignant'), schoolController.recordAttendance);
router.get('/attendance/stats', authenticateSchoolAccess, authorizeSchoolRoles('directeur', 'prefet', 'enseignant'), schoolController.getAttendanceStats);

// Nouvelles fonctionnalités : Ressources pédagogiques
router.get('/resources', authenticate, schoolController.getResources);
router.post('/resources', authenticate, schoolController.addResource);

// Nouvelles fonctionnalités : Rapports et analytics
router.get('/reports', authenticateSchoolAccess, authorizeSchoolRoles('directeur', 'prefet'), schoolController.getSchoolReports);
router.get('/export', authenticateSchoolAccess, authorizeSchoolRoles('directeur'), schoolController.exportSchoolData);

// Login Universel par Code (Public)
router.post('/login-by-code', schoolCodeLoginLimiter, schoolController.loginByCode);
router.get('/portal/dashboard', authenticateSchoolSession, schoolController.getSchoolPortalDashboard);
router.get('/directory/search', authenticate, schoolDirectorySearchLimiter, schoolDirectoryController.searchSchools);
router.post('/directory/proposals', authenticate, schoolProposalLimiter, schoolDirectoryController.proposeSchool);
router.put('/directory/proposals/:proposalId', authenticate, isAdmin, schoolDirectoryController.reviewSchoolProposal);
router.post('/directory/:schoolRef/admissions', authenticate, schoolAdmissionLimiter, schoolDirectoryController.submitSchoolAdmission);
router.get('/admissions/mine', authenticate, schoolDirectoryController.getMySchoolAdmissions);
router.get('/admissions/notifications', authenticate, schoolDirectoryController.getMyAdmissionNotifications);
router.put('/admissions/notifications/:notificationId/read', authenticate, schoolDirectoryController.markAdmissionNotificationRead);
router.get(
  '/admissions/inbox',
  authenticateSchoolAccess,
  authorizeSchoolRoles('directeur'),
  schoolDirectoryController.getSchoolAdmissionInbox
);
router.put(
  '/admissions/:applicationId/decision',
  authenticateSchoolAccess,
  authorizeSchoolRoles('directeur'),
  schoolDirectoryController.decideSchoolAdmission
);
router.put('/admissions/:applicationId/respond', authenticate, schoolDirectoryController.respondToSchoolAdmission);
router.post('/directory/:schoolRef/claim', authenticate, schoolClaimLimiter, schoolDirectoryController.submitSchoolClaim);
router.get('/directory/:schoolRef/claim-status', authenticate, schoolDirectoryController.getSchoolClaimStatus);
router.put('/directory/claims/:claimId', authenticate, isAdmin, schoolDirectoryController.reviewSchoolClaim);

// Route Admin d'approbation
router.put('/approve/:requestId', authenticate, isAdmin, schoolController.approveSchoolRequest);

module.exports = router;
