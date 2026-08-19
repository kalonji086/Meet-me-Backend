const { query } = require('../config/db');
const { asyncHandler } = require('../middleware/error.middleware');
const socketService = require('../services/socket.service');
const logger = require('../utils/logger');

/**
 * @desc    Get all teams
 */
const getTeams = asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT t.*,
    (SELECT COUNT(*) FROM public.collab_team_members WHERE team_id = t.id) as members_count
    FROM public.collab_teams t
    ORDER BY t.created_at DESC
  `);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Create a new team
 */
const createTeam = asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  const result = await query(
    'INSERT INTO public.collab_teams (name, description, created_by) VALUES ($1, $2, $3) RETURNING *',
    [name, description, req.userId]
  );

  // Add creator as admin member
  await query(
    'INSERT INTO public.collab_team_members (team_id, user_id, role) VALUES ($1, $2, $3)',
    [result.rows[0].id, req.userId, 'admin']
  );

  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Get team members
 */
const getTeamMembers = asyncHandler(async (req, res) => {
  const { teamId } = req.params;
  const result = await query(`
    SELECT p.id, p.full_name, p.email, p.avatar_url, m.role, m.joined_at, p.status
    FROM public.collab_team_members m
    JOIN public.profiles p ON m.user_id = p.id
    WHERE m.team_id = $1
    ORDER BY p.full_name ASC
  `, [teamId]);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Get tasks for a team
 */
const getTasks = asyncHandler(async (req, res) => {
  const { teamId } = req.params;
  const result = await query(`
    SELECT t.*, p1.full_name as creator_name, p2.full_name as assignee_name
    FROM public.collab_tasks t
    LEFT JOIN public.profiles p1 ON t.creator_id = p1.id
    LEFT JOIN public.profiles p2 ON t.assignee_id = p2.id
    WHERE t.team_id = $1
    ORDER BY t.created_at DESC
  `, [teamId]);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Create a task
 */
const createTask = asyncHandler(async (req, res) => {
  const { teamId, title, description, deadline, assigneeId, priority } = req.body;
  const result = await query(
    `INSERT INTO public.collab_tasks (team_id, creator_id, assignee_id, title, description, deadline, priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [teamId, req.userId, assigneeId || null, title, description, deadline, priority || 'medium']
  );

  // Notify assignee via Socket
  if (assigneeId) {
    socketService.emitToUser(assigneeId, 'collab:new_task', {
      teamId,
      task: result.rows[0]
    });
  }

  socketService.broadcast('collab:task_created', { teamId, task: result.rows[0] });

  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Update task status
 */
const updateTaskStatus = asyncHandler(async (req, res) => {
  const { taskId } = req.params;
  const { status } = req.body;

  const result = await query(
    'UPDATE public.collab_tasks SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [status, taskId]
  );

  socketService.broadcast('collab:task_updated', { taskId, status });

  res.json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Get team messages
 */
const getMessages = asyncHandler(async (req, res) => {
  const { teamId } = req.params;
  const result = await query(`
    SELECT m.*, p.full_name as sender_name, p.avatar_url as sender_avatar
    FROM public.collab_messages m
    JOIN public.profiles p ON m.sender_id = p.id
    WHERE m.team_id = $1
    ORDER BY m.created_at ASC
    LIMIT 100
  `, [teamId]);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Send a message
 */
const sendMessage = asyncHandler(async (req, res) => {
  const { teamId, content } = req.body;
  const result = await query(
    'INSERT INTO public.collab_messages (team_id, sender_id, content) VALUES ($1, $2, $3) RETURNING *',
    [teamId, req.userId, content]
  );

  const sender = await query('SELECT full_name, avatar_url FROM public.profiles WHERE id = $1', [req.userId]);

  socketService.broadcast('collab:new_message', {
    teamId,
    message: {
      ...result.rows[0],
      sender_name: sender.rows[0].full_name,
      sender_avatar: sender.rows[0].avatar_url
    }
  });

  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Delete a collaboration message
 */
const deleteMessage = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  await query('DELETE FROM public.collab_messages WHERE id = $1', [messageId]);
  res.json({ success: true, message: 'Message supprimé.' });
});

/**
 * @desc    Get team documents
 */
const getDocuments = asyncHandler(async (req, res) => {
  const { teamId } = req.params;
  const result = await query(`
    SELECT d.*, p.full_name as uploader_name
    FROM public.collab_documents d
    LEFT JOIN public.profiles p ON d.uploader_id = p.id
    WHERE d.team_id = $1
    ORDER BY d.created_at DESC
  `, [teamId]);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Upload a document record
 */
const uploadDocument = asyncHandler(async (req, res) => {
  const { teamId, fileUrl, fileName, fileSize, mimeType } = req.body;
  const result = await query(
    `INSERT INTO public.collab_documents (team_id, uploader_id, file_url, file_name, file_size, mime_type)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [teamId, req.userId, fileUrl, fileName, fileSize, mimeType]
  );

  socketService.broadcast('collab:document_uploaded', { teamId, document: result.rows[0] });

  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Handle document approval
 */
const handleDocumentStatus = asyncHandler(async (req, res) => {
  const { docId } = req.params;
  const { status, comment } = req.body;

  const result = await query(
    'UPDATE public.collab_documents SET status = $1, admin_comment = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
    [status, comment, docId]
  );

  res.json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Submit a collaboration request
 */
const submitRequest = asyncHandler(async (req, res) => {
  const { teamId, message } = req.body;
  const result = await query(
    'INSERT INTO public.collab_requests (user_id, team_id, message) VALUES ($1, $2, $3) RETURNING *',
    [req.userId, teamId, message]
  );

  // Notify main admin
  socketService.broadcast('collab:new_request', {
    requestId: result.rows[0].id,
    userName: req.user.full_name
  });

  res.status(201).json({ success: true, message: 'Demande envoyée avec succès.' });
});

/**
 * @desc    Get all collaboration requests
 */
const getRequests = asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT r.*, p.full_name, p.email, t.name as team_name
    FROM public.collab_requests r
    JOIN public.profiles p ON r.user_id = p.id
    JOIN public.collab_teams t ON r.team_id = t.id
    WHERE r.status = 'pending'
    ORDER BY r.created_at DESC
  `);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Process a request
 */
const handleRequest = asyncHandler(async (req, res) => {
  const { requestId } = req.params;
  const { status, comment } = req.body;

  const reqRes = await query('SELECT * FROM public.collab_requests WHERE id = $1', [requestId]);
  if (reqRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Demande non trouvée' });
  const colReq = reqRes.rows[0];

  await query(
    'UPDATE public.collab_requests SET status = $1, admin_comment = $2, processed_at = NOW(), processed_by = $3 WHERE id = $4',
    [status, comment, req.userId, requestId]
  );

  if (status === 'approved') {
    await query(
      'INSERT INTO public.collab_team_members (team_id, user_id, role) VALUES ($1, $2, \'collaborator\') ON CONFLICT DO NOTHING',
      [colReq.team_id, colReq.user_id]
    );
  }

  socketService.emitToUser(colReq.user_id, 'collab:request_processed', { status, comment });

  res.json({ success: true, message: `Demande ${status}.` });
});

/**
 * @desc    Get permissions config
 */
const getPermissions = asyncHandler(async (req, res) => {
  const result = await query('SELECT * FROM public.collab_permissions_config ORDER BY role ASC');
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Save permissions config
 */
const savePermissions = asyncHandler(async (req, res) => {
  const { permissions } = req.body; // Array of objects {role, can_read, can_write, can_delete, modules}

  for (const p of permissions) {
    await query(
      `INSERT INTO public.collab_permissions_config (role, can_read, can_write, can_delete, modules)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (role) DO UPDATE
       SET can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write, can_delete = EXCLUDED.can_delete, modules = EXCLUDED.modules`,
      [p.role, p.can_read, p.can_write, p.can_delete, p.modules]
    );
  }

  res.json({ success: true, message: 'Permissions mises à jour.' });
});

module.exports = {
  getTeams, createTeam, getTeamMembers,
  getTasks, createTask, updateTaskStatus,
  getMessages, sendMessage, deleteMessage,
  getDocuments, uploadDocument, handleDocumentStatus,
  submitRequest, getRequests, handleRequest,
  getPermissions, savePermissions
};
