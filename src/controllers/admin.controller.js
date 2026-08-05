const { query } = require('../config/db');
const { asyncHandler } = require('../middleware/error.middleware');
const socketService = require('../services/socket.service');
const mailService = require('../services/mail.service');

/**
 * @desc    Obtenir les statistiques globales
 */
const getStats = asyncHandler(async (req, res) => {
  const usersCount = await query('SELECT COUNT(*) FROM public.profiles WHERE is_global_admin = FALSE');
  const messagesCount = await query('SELECT COUNT(*) FROM public.messages');
  const chatsCount = await query('SELECT COUNT(*) FROM public.chats');
  const groupsCount = await query("SELECT COUNT(*) FROM public.chats WHERE type = 'group'");
  const lockedUsers = await query('SELECT COUNT(*) FROM public.profiles WHERE is_locked = TRUE AND is_global_admin = FALSE');
  const appealCount = await query("SELECT COUNT(*) FROM public.appeals WHERE status = 'pending'");
  const helpdeskCount = await query("SELECT COUNT(*) FROM public.appeals WHERE status = 'pending' AND type = 'helpdesk'");
  const contestationCount = await query("SELECT COUNT(*) FROM public.appeals WHERE status = 'pending' AND (type = 'contestation' OR type = 'deletion')");

  const growth = await query(`
    SELECT DATE_TRUNC('day', created_at) as date, COUNT(*) as count
    FROM public.profiles
    WHERE created_at > NOW() - INTERVAL '7 days' AND is_global_admin = FALSE
    GROUP BY 1 ORDER BY 1 ASC
  `);

  const userActivity = await query(`
    SELECT p.full_name as name, COUNT(m.id) as count
    FROM public.profiles p
    LEFT JOIN public.messages m ON p.id = m.sender_id
    WHERE p.is_global_admin = FALSE
    GROUP BY p.id, p.full_name
    ORDER BY count DESC
    LIMIT 10
  `);

  const recentReports = await query(`
    SELECT COUNT(*) as count
    FROM public.reported_content
    WHERE status = 'open'
  `);

  res.json({
    success: true,
    data: {
      totalUsers: parseInt(usersCount.rows[0].count),
      totalMessages: parseInt(messagesCount.rows[0].count),
      totalChats: parseInt(chatsCount.rows[0].count),
      totalGroups: parseInt(groupsCount.rows[0].count),
      lockedUsers: parseInt(lockedUsers.rows[0].count),
      pendingAppeals: parseInt(contestationCount.rows[0].count),
      pendingHelpdesk: parseInt(helpdeskCount.rows[0].count),
      openReports: parseInt(recentReports.rows[0].count),
      growth: growth.rows,
      userActivity: userActivity.rows,
      onlineUsers: socketService.getConnectionStats().connectedUsers
    }
  });
});

const getAnalytics = asyncHandler(async (req, res) => {
  const totalUsers = await query('SELECT COUNT(*) FROM public.profiles WHERE is_global_admin = FALSE');
  const activeUsers = await query(`
    SELECT COUNT(DISTINCT sender_id)
    FROM public.messages
    WHERE created_at > NOW() - INTERVAL '30 days'
  `);
  const messagesThisWeek = await query(`
    SELECT COUNT(*) FROM public.messages WHERE created_at > NOW() - INTERVAL '7 days'
  `);
  const newUsersThisWeek = await query(`
    SELECT COUNT(*) FROM public.profiles WHERE created_at > NOW() - INTERVAL '7 days' AND is_global_admin = FALSE
  `);
  const totalGroups = await query("SELECT COUNT(*) FROM public.chats WHERE type = 'group'");
  const resolvedReports = await query("SELECT COUNT(*) FROM public.reported_content WHERE status = 'resolved'");

  const accountDistribution = await query(`
    SELECT
      SUM(CASE WHEN is_locked = FALSE THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN is_locked = TRUE THEN 1 ELSE 0 END) as locked
    FROM public.profiles
    WHERE is_global_admin = FALSE
  `);

  const weeklyTrend = await query(`
    SELECT DATE_TRUNC('day', created_at) as date, COUNT(*) as total
    FROM public.profiles
    WHERE created_at > NOW() - INTERVAL '14 days' AND is_global_admin = FALSE
    GROUP BY 1 ORDER BY 1 ASC
  `);

  const topUsers = await query(`
    SELECT p.full_name, p.email, COUNT(m.id) as message_count
    FROM public.profiles p
    LEFT JOIN public.messages m ON p.id = m.sender_id
    WHERE p.is_global_admin = FALSE
    GROUP BY p.id, p.full_name, p.email
    ORDER BY message_count DESC
    LIMIT 8
  `);

  res.json({
    success: true,
    data: {
      totalUsers: parseInt(totalUsers.rows[0].count),
      activeUsers: parseInt(activeUsers.rows[0].count),
      messagesThisWeek: parseInt(messagesThisWeek.rows[0].count),
      newUsersThisWeek: parseInt(newUsersThisWeek.rows[0].count),
      totalGroups: parseInt(totalGroups.rows[0].count),
      resolvedReports: parseInt(resolvedReports.rows[0].count),
      accountDistribution: {
        active: parseInt(accountDistribution.rows[0].active || 0),
        locked: parseInt(accountDistribution.rows[0].locked || 0)
      },
      weeklyTrend: weeklyTrend.rows,
      topUsers: topUsers.rows
    }
  });
});

const ensureAdminTables = async () => {
  await query(`
    CREATE TABLE IF NOT EXISTS public.app_configs (
      id SERIAL PRIMARY KEY,
      current_version TEXT NOT NULL,
      force_update BOOLEAN DEFAULT FALSE,
      update_url TEXT,
      release_notes TEXT,
      target_user_ids UUID[] DEFAULT '{}',
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS public.app_legal_docs (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      version TEXT NOT NULL,
      force_acceptance BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS public.verification_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
      document_url TEXT,
      status TEXT DEFAULT 'pending',
      admin_notes TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);

  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE');
  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS accepted_legal_version TEXT');

  await query(`
    CREATE TABLE IF NOT EXISTS public.reported_content (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      report_type TEXT NOT NULL CHECK (report_type IN ('message', 'user', 'group')),
      target_id UUID,
      target_name TEXT,
      reporter_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
      reporter_name TEXT,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'resolved', 'dismissed')),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      resolved_at TIMESTAMP WITH TIME ZONE
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id UUID,
      details JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS public.notification_campaigns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT 'all' CHECK (target IN ('all', 'specific')),
      target_value TEXT,
      created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
      sent_count INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'failed')),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);
};

const logAdminAction = async (req, action, entityType, entityId, details = {}) => {
  const adminId = req.user?.id || null;
  try {
    await query(
      'INSERT INTO public.admin_audit_logs (admin_id, action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4, $5)',
      [adminId, action, entityType, entityId, JSON.stringify(details)]
    );
  } catch (error) {
    console.error('Audit log error:', error.message);
  }
};

/**
 * @desc    Lister tous les utilisateurs réels
 */
const getUsers = asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT id, email, full_name, username, avatar_url, status, phone_number, is_locked, login_attempts, created_at, is_global_admin, last_login_at
    FROM public.profiles
    WHERE is_global_admin = FALSE
    ORDER BY last_login_at DESC NULLS LAST
  `);

  res.json({ success: true, data: result.rows });
});

const getReports = asyncHandler(async (req, res) => {
  await ensureAdminTables();
  const result = await query(`
    SELECT r.*, p.full_name AS reporter_name, p.email AS reporter_email
    FROM public.reported_content r
    LEFT JOIN public.profiles p ON p.id = r.reporter_id
    ORDER BY r.created_at DESC
  `);

  res.json({ success: true, data: result.rows });
});

const resolveReport = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  await ensureAdminTables();
  await query(
    'UPDATE public.reported_content SET status = $1, resolved_at = NOW() WHERE id = $2',
    [status || 'resolved', id]
  );
  await logAdminAction(req, 'resolve_report', 'report', id, { status: status || 'resolved' });
  res.json({ success: true, message: 'Signalement mis à jour.' });
});

/**
 * @desc    Supprimer un utilisateur
 */
const deleteUser = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const target = await query('SELECT is_global_admin FROM public.profiles WHERE id = $1', [userId]);
  if (target.rows[0]?.is_global_admin) return res.status(403).json({ success: false, error: 'Impossible de supprimer un admin' });
  await query('DELETE FROM public.profiles WHERE id = $1', [userId]);
  res.json({ success: true, message: 'Utilisateur supprimé définitivement' });
});

/**
 * @desc    Bloquer/Débloquer
 */
const toggleUserLock = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { isLocked } = req.body;
  await query('UPDATE public.profiles SET is_locked = $1, login_attempts = $2 WHERE id = $3', [isLocked, isLocked ? 3 : 0, userId]);
  await logAdminAction(req, isLocked ? 'lock_user' : 'unlock_user', 'user', userId, { isLocked });
  res.json({ success: true });
});

/**
 * @desc    Lister les groupes
 */
const getGroups = asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT c.*, p.full_name as creator_name,
    (SELECT COUNT(*) FROM public.chat_participants WHERE chat_id = c.id) as members_count
    FROM public.chats c
    LEFT JOIN public.profiles p ON c.created_by = p.id
    WHERE c.type = 'group'
    ORDER BY c.created_at DESC
  `);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Bannir/Débannir un groupe
 */
const toggleGroupBan = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const { isBanned } = req.body;
  await query('UPDATE public.chats SET is_banned = $1 WHERE id = $2', [isBanned, chatId]);
  res.json({ success: true });
});

/**
 * @desc    Supprimer un groupe
 */
const deleteGroup = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  await query('DELETE FROM public.chats WHERE id = $1', [chatId]);
  await logAdminAction(req, 'delete_group', 'group', chatId, { deleted: true });
  res.json({ success: true });
});

/**
 * @desc    Membres d'un groupe
 */
const getGroupMembers = asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT p.full_name, p.username, p.email, p.avatar_url, cp.role, cp.joined_at
    FROM public.chat_participants cp
    JOIN public.profiles p ON cp.user_id = p.id
    WHERE cp.chat_id = $1
    ORDER BY cp.role ASC, p.full_name ASC
  `, [req.params.chatId]);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Lister les contestations
 */
const getAppeals = asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT a.*, p.full_name, p.email, p.username, p.avatar_url
    FROM public.appeals a
    JOIN public.profiles p ON a.user_id = p.id
    ORDER BY a.status ASC, a.created_at DESC
  `);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Répondre à une contestation (Inclut la suppression définitive)
 */
const replyToAppeal = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reply, action } = req.body; // action: 'resolved', 'reviewed', 'delete_confirmed'

  const appealRes = await query('SELECT user_id, reason FROM public.appeals WHERE id = $1', [id]);
  if (appealRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Demande introuvable' });

  const userId = appealRes.rows[0].user_id;
  const userRes = await query('SELECT email, full_name FROM public.profiles WHERE id = $1', [userId]);
  const user = userRes.rows[0];

  if (action === 'delete_confirmed') {
    // 1. Envoyer le mail de confirmation de suppression (Template Amazon)
    const finalReply = reply || "Votre demande de suppression de compte Meet Me a été traitée. Toutes vos données ont été effacées de nos serveurs conformément aux politiques de Google Play.";
    await mailService.sendSystemEmail(user.email, "Confirmation de suppression de votre compte Meet Me", finalReply);

    // 2. Supprimer définitivement l'utilisateur (CASCADE supprimera l'appel et tout le reste)
    await query('DELETE FROM public.profiles WHERE id = $1', [userId]);

    return res.json({ success: true, message: 'Compte supprimé et utilisateur notifié par e-mail.' });
  }

  // Action standard (Maintenir ou Réintégrer)
  await query(
    'UPDATE public.appeals SET admin_reply = $1, status = $2, resolved_at = NOW() WHERE id = $3',
    [reply, action === 'resolved' ? 'resolved' : 'reviewed', id]
  );

  await mailService.sendSystemEmail(user.email, "Réponse à votre contestation Meet Me", reply);

  res.json({ success: true, message: 'Réponse envoyée par e-mail.' });
});

/**
 * @desc    Diffusion (Email + Push)
 */
const getCampaigns = asyncHandler(async (req, res) => {
  await ensureAdminTables();
  const result = await query(`
    SELECT c.*, p.full_name AS created_by_name
    FROM public.notification_campaigns c
    LEFT JOIN public.profiles p ON p.id = c.created_by
    ORDER BY c.created_at DESC
  `);
  res.json({ success: true, data: result.rows });
});

const createCampaign = asyncHandler(async (req, res) => {
  const { title, message, target = 'all', targetValue } = req.body;
  if (!title || !message) {
    return res.status(400).json({ success: false, error: 'Titre et message requis' });
  }

  await ensureAdminTables();
  const campaign = await query(
    `INSERT INTO public.notification_campaigns (title, message, target, target_value, created_by, status, sent_count)
     VALUES ($1, $2, $3, $4, $5, 'sent', 0) RETURNING *`,
    [title, message, target || 'all', targetValue || null, req.user.id]
  );

  if (target === 'all') {
    const users = await query('SELECT id, email FROM public.profiles WHERE is_global_admin = FALSE');
    for (const user of users.rows) {
      socketService.sendToUser(user.id, 'push_notification', { title, body: message, type: 'campaign' });
      await mailService.sendSystemEmail(user.email, title, message);
    }
    await query('UPDATE public.notification_campaigns SET sent_count = $1 WHERE id = $2', [users.rows.length, campaign.rows[0].id]);
  } else if (targetValue) {
    const userRes = await query('SELECT id, email FROM public.profiles WHERE email = $1', [targetValue]);
    if (userRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Destinataire introuvable' });
    const user = userRes.rows[0];
    socketService.sendToUser(user.id, 'push_notification', { title, body: message, type: 'campaign' });
    await mailService.sendSystemEmail(user.email, title, message);
    await query('UPDATE public.notification_campaigns SET sent_count = 1 WHERE id = $1', [campaign.rows[0].id]);
  }

  await logAdminAction(req, 'create_campaign', 'campaign', campaign.rows[0].id, { title, target });
  res.json({ success: true, data: campaign.rows[0], message: 'Campagne envoyée.' });
});

const getAuditLogs = asyncHandler(async (req, res) => {
  await ensureAdminTables();
  const result = await query(`
    SELECT a.*, p.full_name AS admin_name
    FROM public.admin_audit_logs a
    LEFT JOIN public.profiles p ON p.id = a.admin_id
    ORDER BY a.created_at DESC
    LIMIT 100
  `);
  res.json({ success: true, data: result.rows });
});

const broadcastMessage = asyncHandler(async (req, res) => {
  const { content, title, target = 'all', specificEmail } = req.body;
  if (!content || !title) return res.status(400).json({ success: false, error: 'Titre et contenu requis' });

  if (target === 'all') {
    socketService.broadcast('push_notification', { title, body: content, type: 'system' });
    const users = await query('SELECT email FROM public.profiles WHERE is_global_admin = FALSE');
    for (const user of users.rows) {
      await mailService.sendSystemEmail(user.email, title, content);
    }
    await logAdminAction(req, 'broadcast_message', 'system', null, { title, target: 'all', count: users.rows.length });
    res.json({ success: true, message: `Diffusion envoyée à ${users.rows.length} utilisateurs.` });
  } else {
    const userRes = await query('SELECT id FROM public.profiles WHERE email = $1', [specificEmail]);
    if (userRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Destinataire introuvable' });
    socketService.sendToUser(userRes.rows[0].id, 'push_notification', { title, body: content, type: 'system' });
    await mailService.sendSystemEmail(specificEmail, title, content);
    await logAdminAction(req, 'broadcast_message', 'system', userRes.rows[0].id, { title, target: 'specific' });
    res.json({ success: true, message: 'Message envoyé.' });
  }
});

/**
 * @desc    Gestion de la mise à jour (App Config)
 */
const getAppConfig = asyncHandler(async (req, res) => {
  await ensureAdminTables();
  const result = await query('SELECT * FROM public.app_configs ORDER BY id DESC LIMIT 1');
  if (result.rows.length === 0) {
    const init = await query("INSERT INTO public.app_configs (current_version, force_update) VALUES ('1.0.0', false) RETURNING *");
    return res.json({ success: true, data: init.rows[0] });
  }
  res.json({ success: true, data: result.rows[0] });
});

const updateAppConfig = asyncHandler(async (req, res) => {
  const { current_version, force_update, update_url, release_notes, target_user_emails } = req.body;

  let targetIds = [];
  if (target_user_emails && target_user_emails.length > 0) {
    const users = await query('SELECT id FROM public.profiles WHERE email = ANY($1)', [target_user_emails]);
    targetIds = users.rows.map(u => u.id);
  }

  await ensureAdminTables();
  const result = await query(
    `INSERT INTO public.app_configs (current_version, force_update, update_url, release_notes, target_user_ids)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [current_version, force_update, update_url, release_notes, targetIds]
  );

  await logAdminAction(req, 'update_app_config', 'config', result.rows[0].id, req.body);
  res.json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Route publique pour l'App Mobile
 */
const checkUpdate = asyncHandler(async (req, res) => {
  const { version, userId } = req.query; // La version actuelle de l'app de l'user

  const config = await query('SELECT * FROM public.app_configs ORDER BY id DESC LIMIT 1');
  if (config.rows.length === 0) return res.json({ updateRequired: false });

  const latest = config.rows[0];
  const isTargeted = userId && latest.target_user_ids.includes(userId);
  const isGlobal = latest.target_user_ids.length === 0;

  // Si l'utilisateur est concerné (soit global, soit ciblé)
  if (isGlobal || isTargeted) {
    if (version !== latest.current_version) {
      return res.json({
        updateRequired: true,
        forceUpdate: latest.force_update,
        latestVersion: latest.current_version,
        updateUrl: latest.update_url,
        releaseNotes: latest.release_notes
      });
    }
  }

  res.json({ updateRequired: false });
});

/**
 * @desc    Gestion des documents légaux
 */
const getLegalDocs = asyncHandler(async (req, res) => {
  await ensureAdminTables();
  const result = await query('SELECT * FROM public.app_legal_docs ORDER BY type ASC');
  res.json({ success: true, data: result.rows });
});

const updateLegalDoc = asyncHandler(async (req, res) => {
  const { type, content, version, force_acceptance } = req.body;
  await ensureAdminTables();
  const result = await query(
    `INSERT INTO public.app_legal_docs (type, content, version, force_acceptance)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (type) DO UPDATE SET content = $2, version = $3, force_acceptance = $4, updated_at = NOW()
     RETURNING *`,
    [type, content, version, force_acceptance]
  );
  await logAdminAction(req, 'update_legal_doc', 'legal', result.rows[0].id, { type, version });
  res.json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Gestion des vérifications (Badge Bleu)
 */
const getVerificationRequests = asyncHandler(async (req, res) => {
  await ensureAdminTables();
  const result = await query(`
    SELECT vr.*, p.full_name, p.email, p.avatar_url
    FROM public.verification_requests vr
    JOIN public.profiles p ON vr.user_id = p.id
    ORDER BY vr.created_at DESC
  `);
  res.json({ success: true, data: result.rows });
});

const handleVerification = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, admin_notes } = req.body; // 'approved' or 'rejected'

  const vr = await query('SELECT user_id FROM public.verification_requests WHERE id = $1', [id]);
  if (vr.rows.length === 0) return res.status(404).json({ success: false, error: 'Demande introuvable' });

  const userId = vr.rows[0].user_id;

  await query('UPDATE public.verification_requests SET status = $1, admin_notes = $2, updated_at = NOW() WHERE id = $3', [status, admin_notes, id]);

  if (status === 'approved') {
    await query('UPDATE public.profiles SET is_verified = TRUE WHERE id = $1', [userId]);
  } else {
    await query('UPDATE public.profiles SET is_verified = FALSE WHERE id = $1', [userId]);
  }

  await logAdminAction(req, 'handle_verification', 'verification', id, { status });
  res.json({ success: true });
});

module.exports = {
  getStats,
  getUsers,
  getReports,
  resolveReport,
  deleteUser,
  toggleUserLock,
  getGroups,
  getGroupMembers,
  toggleGroupBan,
  deleteGroup,
  getAppeals,
  replyToAppeal,
  getAnalytics,
  getCampaigns,
  createCampaign,
  getAuditLogs,
  broadcastMessage,
  getAppConfig,
  updateAppConfig,
  checkUpdate,
  getLegalDocs,
  updateLegalDoc,
  getVerificationRequests,
  handleVerification
};
