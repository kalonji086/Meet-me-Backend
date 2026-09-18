const express = require('express');
const router = express.Router();
const schoolController = require('../controllers/school.controller');
const { authenticate } = require('../middleware/auth.middleware');

router.use(authenticate);

router.get('/overview', schoolController.getSchoolOverview);
router.get('/world', schoolController.getSchools);
router.get('/my-school', schoolController.getMySchool);
router.get('/dashboard', schoolController.getDashboard);
router.get('/profile/:id', schoolController.getSchoolProfile);
router.get('/enroll/requests', schoolController.getEnrollmentRequests);
router.get('/classes', schoolController.getSchoolClasses);
router.get('/schedules', schoolController.getSchedules);
router.get('/stats', schoolController.getStats);
router.get('/fees', schoolController.getSchoolFees);
router.get('/payments', schoolController.getSchoolPayments);
router.get('/teachers', schoolController.getSchoolTeachers);

router.post('/create', schoolController.createSchool);
router.post('/enroll', schoolController.submitEnrollmentRequest);
router.put('/enroll/:id', schoolController.handleEnrollment);
router.post('/students', schoolController.createParentStudent);
router.post('/classes', schoolController.createClass);
router.put('/classes/:id', schoolController.updateClass);
router.delete('/classes/:id', schoolController.deleteClass);
router.post('/teachers', schoolController.createTeacher);
router.post('/teacher-classes', schoolController.assignTeacherToClass);
router.post('/assignments', schoolController.createAssignment);
router.post('/submissions', schoolController.submitAssignment);
router.post('/grades', schoolController.addGrade);
router.post('/payments', schoolController.createPayment);
router.post('/messages', schoolController.sendMessage);
router.post('/staff-request', schoolController.requestStaffAccount);
router.post('/fees', schoolController.createFeeConfig);
router.post('/schedules', schoolController.createSchedule);
router.post('/announcements', schoolController.createAnnouncement);
router.delete('/schedules/:id', schoolController.deleteSchedule);
router.delete('/announcements/:id', schoolController.deleteAnnouncement);

module.exports = router;
