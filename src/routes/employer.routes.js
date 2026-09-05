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
router.get('/me/jobs', authenticate, employerController.getMyJobs);
router.get('/talents', authenticate, employerController.searchTalents);
router.get('/analytics', authenticate, employerController.getAnalytics);
router.get('/export', authenticate, employerController.exportData);
router.put('/settings', authenticate, employerController.updateSettings);

// Planning
router.get('/schedules', authenticate, employerController.getSchedules);
router.post('/schedules', authenticate, employerController.createSchedule);
router.delete('/schedules/:id', authenticate, employerController.deleteSchedule);

// Admin routes (Should be restricted by admin middleware in a real app)
router.put('/approve/:requestId', authenticate, employerController.approveRequest);

module.exports = router;
