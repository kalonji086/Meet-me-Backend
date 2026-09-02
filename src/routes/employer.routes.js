const express = require('express');
const router = express.Router();
const employerController = require('../controllers/employer.controller');
const { authenticate } = require('../middleware/auth.middleware');

// Public routes
router.get('/jobs', employerController.getAllJobs);

// Private routes (Logged in users)
router.post('/request', authenticate, employerController.submitEmployerRequest);
router.get('/status', authenticate, employerController.getEmployerStatus);

// Employer specific routes
router.post('/jobs', authenticate, employerController.postJob);

// Admin routes (Should be restricted by admin middleware in a real app)
router.put('/approve/:requestId', authenticate, employerController.approveRequest);

module.exports = router;
