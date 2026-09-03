const express = require('express');
const router = express.Router();
const schoolController = require('../controllers/school.controller');
const { authenticate } = require('../middleware/auth.middleware');

router.use(authenticate);

router.get('/overview', schoolController.getSchoolOverview);
router.get('/world', schoolController.getSchools);
router.get('/my-school', schoolController.getMySchool);
router.get('/dashboard', schoolController.getDashboard);

router.post('/create', schoolController.createSchool);
router.post('/students', schoolController.createParentStudent);
router.post('/classes', schoolController.createClass);
router.post('/teachers', schoolController.createTeacher);
router.post('/assignments', schoolController.createAssignment);
router.post('/submissions', schoolController.submitAssignment);
router.post('/grades', schoolController.addGrade);
router.post('/payments', schoolController.createPayment);
router.post('/messages', schoolController.sendMessage);
router.post('/staff-request', schoolController.requestStaffAccount);

module.exports = router;
