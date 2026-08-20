const { query } = require('../config/db');
const { asyncHandler } = require('../middleware/error.middleware');
const socketService = require('../services/socket.service');
const logger = require('../utils/logger');

/**
 * @desc    Get all teams
 */
/**
 * @desc    Get all teams with unread counts
 */
const getTeams = asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT t.*,
    (SELECT COUNT(*) FROM public.collab_team_members WHERE team_id = t.id) as members_count,
    tm.role as my_role,
    (SELECT COUNT(*) FROM public.collab_messages m
     WHERE m.team_id = t.id
     AND m.created_at > COALESCE(tm.last_read_at, '1970-01-01')) as unread_count
    FROM public.collab_teams t
    LEFT JOIN public.collab_team_members tm ON t.id = tm.team_id AND tm.user_id = $1
    ORDER BY t.created_at DESC
  `, [req.userId]);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Mark team messages as read
 */
const markAsRead = asyncHandler(async (req, res) => {
  const { teamId } = req.params;
  await query(
    'UPDATE public.collab_team_members SET last_read_at = NOW() WHERE team_id = $1 AND user_id = $2',
    [teamId, req.userId]
  );
  res.json({ success: true });
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
 * @desc    Update task status or progress
 */
const updateTaskStatus = asyncHandler(async (req, res) => {
  const { taskId } = req.params;
  const { status, progress } = req.body;

  let queryStr = 'UPDATE public.collab_tasks SET updated_at = NOW()';
  const params = [taskId];
  let paramIdx = 2;

  if (status) {
    queryStr += `, status = $${paramIdx++}`;
    params.push(status);
  }

  if (progress !== undefined) {
    queryStr += `, progress = $${paramIdx++}`;
    params.push(progress);
  } else if (status === 'completed') {
    queryStr += `, progress = 100`;
  }

  queryStr += ` WHERE id = $1 RETURNING *`;

  const result = await query(queryStr, params);

  socketService.broadcast('collab:task_updated', {
    taskId,
    status: result.rows[0].status,
    progress: result.rows[0].progress,
    teamId: result.rows[0].team_id
  });

  res.json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Delete a task
 */
const deleteTask = asyncHandler(async (req, res) => {
  const { taskId } = req.params;
  const task = await query('SELECT team_id FROM public.collab_tasks WHERE id = $1', [taskId]);
  if (!task.rows[0]) return res.status(404).json({ success: false, error: 'Tâche non trouvée' });

  await query('DELETE FROM public.collab_tasks WHERE id = $1', [taskId]);
  socketService.broadcast('collab:task_deleted', { taskId, teamId: task.rows[0].team_id });

  res.json({ success: true, message: 'Tâche supprimée.' });
});

/**
 * @desc    Get team messages (Public or Private)
 */
const getMessages = asyncHandler(async (req, res) => {
  const { teamId } = req.params;
  const { recipientId } = req.query; // If present, it's a private chat

  let queryStr = `
    SELECT m.*, p.full_name as sender_name, p.avatar_url as sender_avatar
    FROM public.collab_messages m
    JOIN public.profiles p ON m.sender_id = p.id
    WHERE m.team_id = $1
  `;
  const params = [teamId];

  if (recipientId) {
    // Private chat between req.userId and recipientId
    queryStr += ` AND ((m.sender_id = $2 AND m.recipient_id = $3) OR (m.sender_id = $3 AND m.recipient_id = $2))`;
    params.push(req.userId, recipientId);
  } else {
    // Public team chat
    queryStr += ` AND m.recipient_id IS NULL`;
  }

  queryStr += ` ORDER BY m.created_at ASC LIMIT 200`;

  const result = await query(queryStr, params);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Send a message (Public or Private)
 */
const sendMessage = asyncHandler(async (req, res) => {
  const { teamId, content, recipientId } = req.body;
  const result = await query(
    'INSERT INTO public.collab_messages (team_id, sender_id, recipient_id, content) VALUES ($1, $2, $3, $4) RETURNING *',
    [teamId, req.userId, recipientId || null, content]
  );

  const sender = await query('SELECT full_name, avatar_url FROM public.profiles WHERE id = $1', [req.userId]);
  const messageData = {
    ...result.rows[0],
    sender_name: sender.rows[0].full_name,
    sender_avatar: sender.rows[0].avatar_url
  };

  if (recipientId) {
    // Send to specific user via Socket
    socketService.emitToUser(recipientId, 'collab:new_private_message', { teamId, message: messageData });
    socketService.emitToUser(req.userId, 'collab:new_private_message', { teamId, message: messageData });
  } else {
    socketService.broadcast('collab:new_message', { teamId, message: messageData });
  }

  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Delete a collaboration message
 */
const deleteMessage = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  await query('DELETE FROM public.collab_messages WHERE id = $1', [messageId]);
  socketService.broadcast('collab:message_deleted', { messageId });
  res.json({ success: true, message: 'Message supprimé.' });
});

/**
 * @desc    Update a collaboration message
 */
const updateMessage = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const { content } = req.body;

  const result = await query(
    'UPDATE public.collab_messages SET content = $1 WHERE id = $2 RETURNING *',
    [content, messageId]
  );

  socketService.broadcast('collab:message_updated', { messageId, content });

  res.json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Get team documents (Public or Private)
 */
const getDocuments = asyncHandler(async (req, res) => {
  const { teamId } = req.params;
  const result = await query(`
    SELECT d.*, p.full_name as uploader_name
    FROM public.collab_documents d
    LEFT JOIN public.profiles p ON d.uploader_id = p.id
    WHERE d.team_id = $1
      AND NOT ($2 = ANY(COALESCE(d.deleted_for_users, '{}')))
      AND (d.is_archived = FALSE OR d.archive_expires_at > NOW())
      AND (d.recipient_id IS NULL OR d.recipient_id = $2 OR d.uploader_id = $2)
    ORDER BY d.created_at DESC
  `, [teamId, req.userId]);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Get all documents across all teams (Admin only)
 */
const getAllDocuments = asyncHandler(async (req, res) => {
  if (!req.user.is_global_admin) return res.status(403).json({ success: false, error: 'Accès réservé' });
  const result = await query(`
    SELECT d.*, p.full_name as uploader_name, t.name as team_name
    FROM public.collab_documents d
    LEFT JOIN public.profiles p ON d.uploader_id = p.id
    JOIN public.collab_teams t ON d.team_id = t.id
    WHERE NOT ($1 = ANY(COALESCE(d.deleted_for_users, '{}')))
    ORDER BY d.created_at DESC
  `, [req.userId]);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Archive a document
 */
const archiveDocument = asyncHandler(async (req, res) => {
  const { docId } = req.params;
  const { days } = req.body; // Duration in days

  const expiry = days ? `NOW() + INTERVAL '${days} days'` : 'NULL';

  await query(
    `UPDATE public.collab_documents
     SET is_archived = TRUE, archive_expires_at = ${expiry}, updated_at = NOW()
     WHERE id = $1`,
    [docId]
  );

  socketService.broadcast('collab:document_archived', { docId });
  res.json({ success: true, message: 'Document archivé.' });
});

/**
 * @desc    Delete a document (Self or All)
 */
const deleteDocument = asyncHandler(async (req, res) => {
  const { docId } = req.params;
  const { mode } = req.body; // 'self' or 'all'

  if (mode === 'all') {
    if (!req.user.is_global_admin) return res.status(403).json({ success: false, error: 'Seul l\'admin peut supprimer pour tous.' });
    await query('DELETE FROM public.collab_documents WHERE id = $1', [docId]);
    socketService.broadcast('collab:document_deleted', { docId, mode: 'all' });
  } else {
    // Mode self: Add to deleted_for_users array
    await query(
      'UPDATE public.collab_documents SET deleted_for_users = array_append(COALESCE(deleted_for_users, \'{}\'), $1) WHERE id = $2',
      [req.userId, docId]
    );
    res.json({ success: true, message: 'Masqué pour vous.' });
    return;
  }

  res.json({ success: true, message: 'Document supprimé.' });
});

/**
 * @desc    Upload a document record (Public or Private)
 */
const uploadDocument = asyncHandler(async (req, res) => {
  const { teamId, fileUrl, fileName, fileSize, mimeType, recipientId } = req.body;
  const result = await query(
    `INSERT INTO public.collab_documents (team_id, uploader_id, recipient_id, file_url, file_name, file_size, mime_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [teamId, req.userId, recipientId || null, fileUrl, fileName, fileSize, mimeType]
  );

  if (recipientId) {
    socketService.emitToUser(recipientId, 'collab:new_private_document', { teamId, document: result.rows[0] });
    socketService.emitToUser(req.userId, 'collab:new_private_document', { teamId, document: result.rows[0] });
  } else {
    socketService.broadcast('collab:document_uploaded', { teamId, document: result.rows[0] });
  }

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
  const { teamId, motivation, objectives, skills } = req.body;
  const result = await query(
    'INSERT INTO public.collab_requests (user_id, team_id, motivation, objectives, skills) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [req.userId, teamId, motivation, objectives, skills]
  );

  // Notify main admin
  socketService.broadcast('collab:new_request', {
    requestId: result.rows[0].id,
    userName: req.user.full_name
  });

  res.status(201).json({ success: true, message: 'Demande envoyée avec succès.' });
});

/**
 * @desc    Invite a user to collaborate
 */
const inviteUser = asyncHandler(async (req, res) => {
  if (!req.user.is_global_admin) return res.status(403).json({ success: false, error: 'Accès réservé' });
  const { userId, teamId } = req.body;

  const userRes = await query('SELECT full_name, email FROM public.profiles WHERE id = $1', [userId]);
  if (userRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });
  const user = userRes.rows[0];

  const teamRes = await query('SELECT name FROM public.collab_teams WHERE id = $1', [teamId]);
  const teamName = teamRes.rows[0]?.name || "l'équipe";

  const mailService = require('../services/mail.service');
  await mailService.sendCollabInvitationEmail(user.email, user.full_name, teamName, teamId);

  res.json({ success: true, message: `Invitation envoyée à ${user.full_name}.` });
});

/**
 * @desc    Get all collaboration requests
 */
const getRequests = asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT r.*, p.full_name, p.email, p.avatar_url, t.name as team_name
    FROM public.collab_requests r
    JOIN public.profiles p ON r.user_id = p.id
    JOIN public.collab_teams t ON r.team_id = t.id
    WHERE r.status = 'pending'
    ORDER BY r.created_at DESC
  `);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Get my own request status
 */
const getMyRequestStatus = asyncHandler(async (req, res) => {
  const result = await query(
    'SELECT status, admin_comment FROM public.collab_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [req.userId]
  );
  res.json({ success: true, data: result.rows[0] || null });
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
    // 1. Add to team members
    await query(
      'INSERT INTO public.collab_team_members (team_id, user_id, role) VALUES ($1, $2, \'collaborator\') ON CONFLICT DO NOTHING',
      [colReq.team_id, colReq.user_id]
    );

    // 2. IMPORTANT: Create or update admin delegation so they can access the panel
    // We check if the user already has some delegations to avoid duplicates
    const existingDel = await query('SELECT modules FROM public.admin_delegations WHERE user_id = $1', [colReq.user_id]);

    if (existingDel.rows.length === 0) {
      await query(
        `INSERT INTO public.admin_delegations (user_id, modules, is_active, updated_at)
         VALUES ($1, $2, TRUE, NOW())`,
        [colReq.user_id, ['collaboration']]
      );
    } else {
      await query(
        `UPDATE public.admin_delegations
         SET modules = CASE
           WHEN NOT ('collaboration' = ANY(modules)) THEN array_append(modules, 'collaboration')
           ELSE modules
         END,
         is_active = TRUE,
         updated_at = NOW()
         WHERE user_id = $1`,
        [colReq.user_id]
      );
    }
  }

  socketService.emitToUser(colReq.user_id, 'collab:request_processed', { status, comment });

  res.json({ success: true, message: `Demande ${status}.` });
});

/**
 * @desc    Move a member to another team
 */
const moveTeamMember = asyncHandler(async (req, res) => {
  if (!req.user.is_global_admin) return res.status(403).json({ success: false, error: 'Accès réservé' });
  const { userId, fromTeamId, toTeamId } = req.params.userId ? { ...req.body, userId: req.params.userId } : req.body;

  // 1. Remove from old team (if exists) or all teams to be sure
  if (fromTeamId && fromTeamId !== 'null' && fromTeamId !== '') {
    await query('DELETE FROM public.collab_team_members WHERE team_id = $1 AND user_id = $2', [fromTeamId, userId]);
  } else {
    await query('DELETE FROM public.collab_team_members WHERE user_id = $1', [userId]);
  }

  // 2. Add to new team
  if (toTeamId) {
    await query(
      'INSERT INTO public.collab_team_members (team_id, user_id, role) VALUES ($1, $2, \'collaborator\') ON CONFLICT DO NOTHING',
      [toTeamId, userId]
    );
  }

  // 3. Notify real-time
  socketService.broadcast('collab:member_moved', { userId, fromTeamId, toTeamId });

  res.json({ success: true, message: 'Collaborateur déplacé avec succès.' });
});

/**
 * @desc    Get detailed info about a collaborator
 */
const getMemberDetails = asyncHandler(async (req, res) => {
  const { userId } = req.params;

  // 1. Basic Profile
  const profile = await query('SELECT id, full_name, email, phone_number, avatar_url, status FROM public.profiles WHERE id = $1', [userId]);
  if (profile.rows.length === 0) return res.status(404).json({ success: false, error: 'Membre non trouvé' });

  // 2. Team
  const team = await query(`
    SELECT t.name, m.role, t.id as team_id
    FROM public.collab_team_members m
    JOIN public.collab_teams t ON m.team_id = t.id
    WHERE m.user_id = $1 LIMIT 1
  `, [userId]);

  // 3. Pending Tasks
  const tasks = await query('SELECT title, status, progress FROM public.collab_tasks WHERE assignee_id = $1 AND status != \'completed\'', [userId]);

  // 4. Availability (Calendar)
  const availability = await query('SELECT title, start_at, end_at FROM public.collab_calendar_events WHERE creator_id = $1 AND type = \'availability\' AND end_at > NOW()', [userId]);

  res.json({
    success: true,
    data: {
      profile: profile.rows[0],
      team: team.rows[0] || null,
      tasks: tasks.rows,
      availability: availability.rows
    }
  });
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

/**
 * @desc    Get all calendar events for a team (including tasks as deadlines)
 */
const getCalendarEvents = asyncHandler(async (req, res) => {
  const { teamId } = req.params;

  // 1. Fetch meetings and availabilities
  const events = await query(
    'SELECT * FROM public.collab_calendar_events WHERE team_id = $1 ORDER BY start_at ASC',
    [teamId]
  );

  // 2. Fetch tasks as deadlines
  const tasks = await query(
    'SELECT id, title, description, deadline as start_at, deadline as end_at, status, \'deadline\' as type FROM public.collab_tasks WHERE team_id = $1 AND deadline IS NOT NULL',
    [teamId]
  );

  const allEvents = [...events.rows, ...tasks.rows];

  res.json({ success: true, data: allEvents });
});

/**
 * @desc    Create a calendar event
 */
const createCalendarEvent = asyncHandler(async (req, res) => {
  const { teamId, title, description, start_at, end_at, type } = req.body;

  const result = await query(
    `INSERT INTO public.collab_calendar_events (team_id, creator_id, title, description, start_at, end_at, type)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [teamId, req.userId, title, description, start_at, end_at, type || 'meeting']
  );

  socketService.broadcast('collab:calendar_event_created', { teamId, event: result.rows[0] });

  res.status(201).json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Delete a calendar event
 */
const deleteCalendarEvent = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  await query('DELETE FROM public.collab_calendar_events WHERE id = $1', [eventId]);
  res.json({ success: true, message: 'Événement supprimé.' });
});

module.exports = {
  getTeams, createTeam, getTeamMembers, markAsRead,
  getTasks, createTask, updateTaskStatus, deleteTask,
  getMessages, sendMessage, deleteMessage, updateMessage,
  getDocuments, getAllDocuments, uploadDocument, handleDocumentStatus,
  archiveDocument, deleteDocument,
  getCalendarEvents, createCalendarEvent, deleteCalendarEvent,
  submitRequest, inviteUser, getRequests, getMyRequestStatus, handleRequest,
  moveTeamMember, getMemberDetails,
  getPermissions, savePermissions
};
