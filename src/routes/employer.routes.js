const express = require('express');
const router = express.Router();
const employerController = require('../controllers/employer.controller');
const { authenticate } = require('../middleware/auth.middleware');

// Public routes
router.get('/jobs', employerController.getAllJobs);
router.get('/jobs/:id', employerController.getJobById);
router.get('/jobs/:jobId/comments', employerController.getJobComments);

// Private routes (Logged in users)
router.post('/request', authenticate, employerController.submitEmployerRequest);
router.get('/status', authenticate, employerController.getEmployerStatus);
router.post('/jobs/:jobId/comments', authenticate, employerController.addJobComment);

// Employer specific routes
router.post('/jobs', authenticate, employerController.postJob);
router.get('/talents', authenticate, employerController.searchTalents);

// Admin routes (Should be restricted by admin middleware in a real app)
router.put('/approve/:requestId', authenticate, employerController.approveRequest);

module.exports = router;
