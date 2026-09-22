const express = require('express');
const router = express.Router();
const schoolController = require('../controllers/school.controller');
const { authenticate, isAdmin } = require('../middleware/auth.middleware');

// Routes privées (Utilisateurs connectés)
router.post('/request', authenticate, schoolController.submitSchoolRequest);
router.get('/status', authenticate, schoolController.getSchoolStatus);
router.get('/dashboard', authenticate, schoolController.getSchoolDashboardData);

// Sub-modules École
router.get('/students', authenticate, schoolController.getStudents);
router.post('/students', authenticate, schoolController.addStudent);
router.get('/classes', authenticate, schoolController.getClasses);
router.post('/classes', authenticate, schoolController.addClass);
router.get('/schedules', authenticate, schoolController.getSchedules);
router.post('/schedules', authenticate, schoolController.addSchedule);
router.get('/fees', authenticate, schoolController.getFees);
router.post('/fees', authenticate, schoolController.addFeeInvoice);

// Route Admin d'approbation
router.put('/approve/:requestId', authenticate, isAdmin, schoolController.approveSchoolRequest);

module.exports = router;
