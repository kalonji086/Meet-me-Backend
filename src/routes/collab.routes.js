const express = require('express');
const router = express.Router();
const collabController = require('../controllers/collab.controller');
const { authenticate, isAdmin } = require('../middleware/auth.middleware');

router.use(authenticate);

// Public status check (logged in but not yet admin)
router.get('/my-status', collabController.getMyRequestStatus);
router.post('/requests', collabController.submitRequest);

// Restrict these to Admins/Delegates
router.use(isAdmin);

// Teams
router.get('/teams', collabController.getTeams);
router.post('/teams', collabController.createTeam);
router.put('/teams/:teamId', collabController.updateTeam);
router.delete('/teams/:teamId', collabController.deleteTeam);
router.get('/teams/:teamId/members', collabController.getTeamMembers);
router.get('/members/:userId', collabController.getMemberDetails);
router.post('/invite', collabController.inviteUser);
router.post('/move-member', collabController.moveTeamMember);
router.put('/teams/:teamId/read', collabController.markAsRead);

// Tasks
router.get('/teams/:teamId/tasks', collabController.getTasks);
router.post('/tasks', collabController.createTask);
router.put('/tasks/:taskId/status', collabController.updateTaskStatus);
router.delete('/tasks/:taskId', collabController.deleteTask);

// Messages
router.get('/teams/:teamId/messages', collabController.getMessages);
router.post('/messages', collabController.sendMessage);
router.put('/messages/:messageId', collabController.updateMessage);
router.delete('/messages/:messageId', collabController.deleteMessage);
router.put('/messages/:messageId/seen', collabController.markMessageAsSeen);

// Documents
router.get('/documents', collabController.getAllDocuments); // Centralized for Admin
router.get('/teams/:teamId/documents', collabController.getDocuments);
router.post('/documents', collabController.uploadDocument);
router.put('/documents/:docId/status', collabController.handleDocumentStatus);
router.put('/documents/:docId/archive', collabController.archiveDocument);
router.post('/documents/:docId/delete', collabController.deleteDocument);

// Calendar
router.get('/teams/:teamId/calendar', collabController.getCalendarEvents);
router.post('/calendar', collabController.createCalendarEvent);
router.delete('/calendar/:eventId', collabController.deleteCalendarEvent);

// Requests / Applications Management
router.get('/requests', collabController.getRequests);
router.put('/requests/:requestId', collabController.handleRequest);

// Permissions
router.get('/permissions', collabController.getPermissions);
router.post('/permissions', collabController.savePermissions);

module.exports = router;
