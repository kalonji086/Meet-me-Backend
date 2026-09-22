const express = require('express');
const router = express.Router();
const schoolController = require('../controllers/school.controller');
const { authenticate, isAdmin } = require('../middleware/auth.middleware');

// Routes privées (Utilisateurs connectés)
router.post('/request', authenticate, schoolController.submitSchoolRequest);
router.get('/status', authenticate, schoolController.getSchoolStatus);
router.get('/dashboard', authenticate, schoolController.getSchoolDashboardData);

// Route Admin d'approbation
router.put('/approve/:requestId', authenticate, isAdmin, schoolController.approveSchoolRequest);

module.exports = router;
