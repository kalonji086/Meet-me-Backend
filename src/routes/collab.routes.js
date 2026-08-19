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
router.get('/teams/:teamId/members', collabController.getTeamMembers);
router.post('/invite', collabController.inviteUser);

// Tasks
router.get('/teams/:teamId/tasks', collabController.getTasks);
router.post('/tasks', collabController.createTask);
router.put('/tasks/:taskId/status', collabController.updateTaskStatus);

// Messages
router.get('/teams/:teamId/messages', collabController.getMessages);
router.post('/messages', collabController.sendMessage);
router.delete('/messages/:messageId', collabController.deleteMessage);

// Documents
router.get('/documents', collabController.getAllDocuments); // Centralized for Admin
router.get('/teams/:teamId/documents', collabController.getDocuments);
router.post('/documents', collabController.uploadDocument);
router.put('/documents/:docId/status', collabController.handleDocumentStatus);

// Requests / Applications Management
router.get('/requests', collabController.getRequests);
router.put('/requests/:requestId', collabController.handleRequest);

// Permissions
router.get('/permissions', collabController.getPermissions);
router.post('/permissions', collabController.savePermissions);

module.exports = router;
