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
  const contestationCount = await query("SELECT COUNT(*) FROM public.appeals WHERE status = 'pending' AND (type = 'contestation' OR type = 'deletion' OR type = 'appeal')");
  const verificationsCount = await query("SELECT COUNT(*) FROM public.verification_requests WHERE status = 'pending'");

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

  const messageDistribution = await query(`
    SELECT type, COUNT(*) as count
    FROM public.messages
    GROUP BY type
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
      pendingVerifications: parseInt(verificationsCount.rows[0].count),
      openReports: parseInt(recentReports.rows[0].count),
      growth: growth.rows,
      userActivity: userActivity.rows,
      messageDistribution: messageDistribution.rows.reduce((acc, curr) => {
        acc[curr.type] = parseInt(curr.count);
        return acc;
      }, {}),
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

  const messageDistribution = await query(`
    SELECT type, COUNT(*) as count
    FROM public.messages
    GROUP BY type
  `);

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
      messageDistribution: messageDistribution.rows.reduce((acc, curr) => {
        acc[curr.type] = parseInt(curr.count);
        return acc;
      }, {}),
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
    CREATE TABLE IF NOT EXISTS public.app_configs (
      id SERIAL PRIMARY KEY,
      current_version TEXT NOT NULL,
      force_update BOOLEAN DEFAULT FALSE,
      active BOOLEAN DEFAULT TRUE,
      update_url TEXT,
      release_notes TEXT,
      target_user_ids UUID[] DEFAULT '{}',
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);

  // S'assurer que la colonne active existe
  try { await query('ALTER TABLE public.app_configs ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE'); } catch (e) {}

  // Initialiser avec la version actuelle de l'application si aucune config n'existe
  const existingConfig = await query('SELECT id FROM public.app_configs LIMIT 1');
  if (existingConfig.rows.length === 0) {
    await query(`INSERT INTO public.app_configs (current_version, force_update, active) VALUES ('5.0.0', false, true)`);
  }

  // S'assurer que les documents légaux existent avec la version 5.0.0
  const existingLegalDocs = await query('SELECT type FROM public.app_legal_docs');
  if (existingLegalDocs.rows.length === 0) {
    // Initialiser avec des documents légaux par défaut pour la version 5.0.0
    await query(`INSERT INTO public.app_legal_docs (type, content, version, force_acceptance) VALUES 
      ('tos', 'Conditions Générales d''Utilisation - Version 5.0.0', '5.0.0', true),
      ('privacy', 'Politique de Confidentialité - Version 5.0.0', '5.0.0', true)`);
  }

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
  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS accepted_tos_version TEXT');
  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS accepted_privacy_version TEXT');
  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS app_version TEXT');
  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_update_at TIMESTAMP WITH TIME ZONE');

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
      entity_id TEXT, -- Changé UUID en TEXT pour supporter les IDs numériques
      details JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);

  // S'assurer que entity_id est bien de type TEXT si la table existe déjà
  try {
    await query('ALTER TABLE public.admin_audit_logs ALTER COLUMN entity_id TYPE TEXT');
  } catch (e) { /* Table peut être déjà correcte */ }

  await query(`
    CREATE TABLE IF NOT EXISTS public.notification_campaigns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT 'all' CHECK (target IN ('all', 'specific')),
      target_value TEXT,
      created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
      sent_count INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'processing', 'sent', 'failed')),
      scheduled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);

  // Migration pour ajouter scheduled_at si la table existe déjà
  try {
    await query('ALTER TABLE public.notification_campaigns ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()');
    await query('ALTER TABLE public.notification_campaigns ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()');
    await query('ALTER TABLE public.notification_campaigns ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT \'{}\'::jsonb');
    await query('ALTER TABLE public.notification_campaigns DROP CONSTRAINT IF EXISTS notification_campaigns_status_check');
    await query('ALTER TABLE public.notification_campaigns ADD CONSTRAINT notification_campaigns_status_check CHECK (status IN (\'scheduled\', \'processing\', \'sent\', \'failed\'))');
  } catch (e) { /* S'il y a une erreur c'est que c'est déjà à jour */ }
};

const logAdminAction = async (req, action, entityType, entityId, details = {}) => {
  const adminId = req.user?.id || null;
  const adminName = req.user?.full_name || 'Admin';
  try {
    const res = await query(
      'INSERT INTO public.admin_audit_logs (admin_id, action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [adminId, action, entityType, entityId, JSON.stringify(details)]
    );

    socketService.broadcast('admin_new_audit', { ...res.rows[0], admin_name: adminName });
  } catch (error) {
    console.error('Audit log error:', error.message);
  }
};

/**
 * @desc    Lister tous les utilisateurs réels
 */
const getUsers = asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT id, email, full_name, username, avatar_url, status, phone_number, is_locked,
           login_attempts, created_at, is_global_admin, last_login_at, device_info, is_verified
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

  // 1. Vérifier si la cible est un admin
  const target = await query('SELECT is_global_admin FROM public.profiles WHERE id = $1', [userId]);
  if (!target.rows[0]) return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });
  if (target.rows[0].is_global_admin) return res.status(403).json({ success: false, error: 'Impossible de supprimer un administrateur global' });

  // 2. Nettoyage manuel des dépendances critiques (au cas où CASCADE manque)
  await query('DELETE FROM public.messages WHERE sender_id = $1', [userId]);
  await query('DELETE FROM public.chat_participants WHERE user_id = $1', [userId]);
  await query('UPDATE public.chats SET created_by = NULL WHERE created_by = $1', [userId]); // Résout le bug de contrainte
  await query('DELETE FROM public.appeals WHERE user_id = $1', [userId]);
  await query('DELETE FROM public.verification_requests WHERE user_id = $1', [userId]);
  await query('DELETE FROM public.reported_content WHERE reporter_id = $1 OR target_id = $1', [userId]);
  await query('UPDATE public.notification_campaigns SET created_by = NULL WHERE created_by = $1', [userId]);

  // 3. Suppression finale du profil
  await query('DELETE FROM public.profiles WHERE id = $1', [userId]);

  await logAdminAction(req, 'delete_user', 'user', userId, { deleted: true });
  res.json({ success: true, message: 'Utilisateur et toutes ses données supprimés' });
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
  await logAdminAction(req, isBanned ? 'ban_group' : 'unban_group', 'group', chatId, { isBanned });
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
    LEFT JOIN public.profiles p ON a.user_id = p.id
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

  const appealRes = await query('SELECT user_id, reason, contact_email FROM public.appeals WHERE id = $1', [id]);
  if (appealRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Demande introuvable' });

  const { user_id, contact_email } = appealRes.rows[0];
  let email = contact_email;
  let fullName = 'Utilisateur';

  if (user_id) {
    const userRes = await query('SELECT email, full_name FROM public.profiles WHERE id = $1', [user_id]);
    if (userRes.rows.length > 0) {
      email = userRes.rows[0].email;
      fullName = userRes.rows[0].full_name;
    }
  }

  if (!email) {
    return res.status(400).json({ success: false, error: 'Aucune adresse email trouvée pour répondre.' });
  }

  if (action === 'delete_confirmed' && user_id) {
    // 1. Envoyer le mail de confirmation de suppression (Template Amazon)
    const finalReply = reply || "Votre demande de suppression de compte Meet Me a été traitée. Toutes vos données ont été effacées de nos serveurs conformément aux politiques de Google Play.";
    await mailService.sendSystemEmail(email, "Confirmation de suppression de votre compte Meet Me", finalReply);

    // 2. Supprimer définitivement l'utilisateur (CASCADE supprimera l'appel et tout le reste)
    await query('DELETE FROM public.profiles WHERE id = $1', [user_id]);

    await logAdminAction(req, 'confirm_deletion', 'user', user_id, { appealId: id });

    return res.json({ success: true, message: 'Compte supprimé et utilisateur notifié par e-mail.' });
  }

  // Action standard (Maintenir ou Réintégrer)
  await query(
    'UPDATE public.appeals SET admin_reply = $1, status = $2, resolved_at = NOW() WHERE id = $3',
    [reply, action === 'resolved' ? 'resolved' : 'reviewed', id]
  );

  await logAdminAction(req, 'reply_appeal', 'appeal', id, { action });

  await mailService.sendSystemEmail(email, "Réponse à votre demande Meet Me", reply);

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
  const { title, message, target = 'all', targetValue, scheduledAt, theme = 'amazon' } = req.body;
  if (!title || !message) {
    return res.status(400).json({ success: false, error: 'Titre et message requis' });
  }

  await ensureAdminTables();

  // Si scheduledAt est fourni et est dans le futur, on enregistre seulement
  const now = new Date();
  const scheduledDate = scheduledAt ? new Date(scheduledAt) : now;
  const isFuture = scheduledDate > now;

  const campaign = await query(
    `INSERT INTO public.notification_campaigns (title, message, target, target_value, created_by, status, scheduled_at, sent_count, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8) RETURNING *`,
    [title, message, target || 'all', targetValue || null, req.user?.id || null, isFuture ? 'scheduled' : 'sent', scheduledDate, JSON.stringify({ theme })]
  );

  // Si l'envoi est immédiat
  if (!isFuture) {
    if (target === 'all') {
      const users = await query('SELECT id, email FROM public.profiles WHERE is_global_admin = FALSE');
      for (const user of users.rows) {
        socketService.sendToUser(user.id, 'push_notification', { title, body: message, type: 'campaign' });
        await mailService.sendSystemEmail(user.email, title, message, theme);
      }
      await query('UPDATE public.notification_campaigns SET sent_count = $1 WHERE id = $2', [users.rows.length, campaign.rows[0].id]);
    } else if (targetValue) {
      const emails = targetValue.split(',').map(e => e.trim()).filter(e => e);
      let sentCount = 0;
      for (const email of emails) {
        const userRes = await query('SELECT id FROM public.profiles WHERE email = $1', [email]);
        if (userRes.rows.length > 0) {
          socketService.sendToUser(userRes.rows[0].id, 'push_notification', { title, body: message, type: 'campaign' });
        }
        const success = await mailService.sendSystemEmail(email, title, message, theme);
        if (success) sentCount++;
      }
      await query('UPDATE public.notification_campaigns SET sent_count = $1 WHERE id = $2', [sentCount, campaign.rows[0].id]);
    }
  }

  await logAdminAction(req, 'create_campaign', 'campaign', campaign.rows[0].id, { title, target, theme, scheduledAt: isFuture ? scheduledAt : 'immediate' });
  res.json({ success: true, data: campaign.rows[0], message: isFuture ? 'Campagne programmée.' : 'Campagne envoyée.' });
});

const updateCampaign = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, message, scheduledAt, theme } = req.body;

  const result = await query(
    `UPDATE public.notification_campaigns
     SET title = COALESCE($1, title),
         message = COALESCE($2, message),
         scheduled_at = COALESCE($3, scheduled_at),
         metadata = CASE WHEN $4::text IS NOT NULL THEN jsonb_set(COALESCE(metadata, '{}'::jsonb), '{theme}', to_jsonb($4::text)) ELSE metadata END,
         updated_at = NOW()
     WHERE id = $5 AND status = 'scheduled'
     RETURNING *`,
    [title, message, scheduledAt, theme || null, id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ success: false, error: 'Campagne introuvable ou déjà envoyée' });
  }

  await logAdminAction(req, 'update_campaign', 'campaign', id, { title });
  res.json({ success: true, data: result.rows[0], message: 'Campagne mise à jour' });
});

const deleteCampaign = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await query('DELETE FROM public.notification_campaigns WHERE id = $1 AND status = \'scheduled\' RETURNING id');

  if (result.rows.length === 0) {
    return res.status(404).json({ success: false, error: 'Campagne introuvable ou déjà envoyée' });
  }

  await logAdminAction(req, 'delete_campaign', 'campaign', id);
  res.json({ success: true, message: 'Campagne supprimée' });
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
  const { content, title, target = 'all', specificEmail, scheduledAt, theme = 'amazon' } = req.body;
  if (!content || !title) return res.status(400).json({ success: false, error: 'Titre et contenu requis' });

  // Si scheduledAt est fourni et est dans le futur, on enregistre dans notification_campaigns avec le type 'broadcast'
  const now = new Date();
  const scheduledDate = scheduledAt ? new Date(scheduledAt) : now;
  const isFuture = scheduledDate > now;

  if (isFuture) {
    const campaign = await query(
      `INSERT INTO public.notification_campaigns (title, message, target, target_value, created_by, status, scheduled_at, sent_count, metadata)
       VALUES ($1, $2, $3, $4, $5, 'scheduled', $6, 0, $7) RETURNING *`,
      [title, content, target, specificEmail || null, req.user?.id || null, scheduledDate, JSON.stringify({ theme, isBroadcast: true })]
    );
    await logAdminAction(req, 'broadcast_scheduled', 'system', campaign.rows[0].id, { title, target, scheduledAt });
    return res.json({ success: true, message: 'Diffusion programmée avec succès.' });
  }

  if (target === 'all') {
    socketService.broadcast('push_notification', { title, body: content, type: 'system' });
    const users = await query('SELECT email FROM public.profiles WHERE is_global_admin = FALSE');
    for (const user of users.rows) {
      await mailService.sendSystemEmail(user.email, title, content, theme);
    }

    // Sauvegarder dans l'historique
    await query(
      `INSERT INTO public.notification_campaigns (title, message, target, target_value, created_by, status, scheduled_at, sent_count, metadata)
       VALUES ($1, $2, $3, $4, $5, 'sent', NOW(), $6, $7)`,
      [title, content, 'all', null, req.user?.id || null, users.rows.length, JSON.stringify({ theme, isBroadcast: true })]
    );

    await logAdminAction(req, 'broadcast_message', 'system', null, { title, target: 'all', count: users.rows.length, theme });
    res.json({ success: true, message: `Diffusion envoyée à ${users.rows.length} utilisateurs.` });
  } else if (specificEmail) {
    // Supporter plusieurs emails séparés par des virgules
    const emails = specificEmail.split(',').map(e => e.trim()).filter(e => e);
    let sentCount = 0;

    for (const email of emails) {
      const userRes = await query('SELECT id FROM public.profiles WHERE email = $1', [email]);
      if (userRes.rows.length > 0) {
        socketService.sendToUser(userRes.rows[0].id, 'push_notification', { title, body: content, type: 'system' });
      }
      const success = await mailService.sendSystemEmail(email, title, content, theme);
      if (success) sentCount++;
    }

    // Sauvegarder dans l'historique
    await query(
      `INSERT INTO public.notification_campaigns (title, message, target, target_value, created_by, status, scheduled_at, sent_count, metadata)
       VALUES ($1, $2, $3, $4, $5, 'sent', NOW(), $6, $7)`,
      [title, content, 'specific', specificEmail, req.user?.id || null, sentCount, JSON.stringify({ theme, isBroadcast: true })]
    );

    await logAdminAction(req, 'broadcast_message', 'system', null, { title, target: 'specific', count: sentCount, emails: specificEmail, theme });
    res.json({ success: true, message: `Message envoyé à ${sentCount} destinataires.` });
  } else {
    res.status(400).json({ success: false, error: 'Email spécifique requis pour cette cible.' });
  }
});

/**
 * @desc    Gestion de la mise à jour (App Config)
 */
const getAppConfig = asyncHandler(async (req, res) => {
  await ensureAdminTables();
  const result = await query('SELECT * FROM public.app_configs ORDER BY id DESC LIMIT 1');

  // Récupérer la version la plus haute détectée chez les utilisateurs
  const maxDetected = await query('SELECT app_version FROM public.profiles WHERE app_version IS NOT NULL ORDER BY app_version DESC LIMIT 1');
  const latestDetected = maxDetected.rows[0]?.app_version || 'N/A';

  // Version actuelle de l'application (définie dans app.json)
  const currentAppVersion = '5.0.0';

  if (result.rows.length === 0) {
    // Si aucune config n'existe, utiliser la version actuelle de l'app
    const init = await query(`INSERT INTO public.app_configs (current_version, force_update) VALUES ('${currentAppVersion}', false) RETURNING *`);
    return res.json({ success: true, data: init.rows[0], latestDetected });
  }

  res.json({ success: true, data: result.rows[0], latestDetected, currentAppVersion });
});

const updateAppConfig = asyncHandler(async (req, res) => {
  const { current_version, force_update, update_url, release_notes, target_user_emails, active = true } = req.body;

  let targetIds = [];
  if (target_user_emails && target_user_emails.length > 0) {
    const users = await query('SELECT id FROM public.profiles WHERE email = ANY($1)', [target_user_emails]);
    targetIds = users.rows.map(u => u.id);
  }

  await ensureAdminTables();
  const result = await query(
    `INSERT INTO public.app_configs (current_version, force_update, update_url, release_notes, target_user_ids, active)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [current_version, force_update, update_url, release_notes, targetIds, active]
  );

  // Notifier les utilisateurs de la nouvelle version
  socketService.broadcast('app_config_update', {
    current_version,
    force_update,
    update_url,
    release_notes
  });

  await logAdminAction(req, 'update_app_config', 'config', result.rows[0].id, req.body);
  res.json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Supprimer/Désactiver une configuration de mise à jour
 */
const deleteAppConfig = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await query('DELETE FROM public.app_configs WHERE id = $1', [id]);
  await logAdminAction(req, 'delete_app_config', 'config', id, { deleted: true });
  res.json({ success: true, message: 'Configuration de mise à jour supprimée.' });
});

/**
 * Compare deux versions (format x.y.z)
 * @returns true si v1 >= v2
 */
function isVersionGreaterOrEqual(v1, v2) {
  if (!v1 || !v2) return false;
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return true;
    if (p1 < p2) return false;
  }
  return true; // Égal
}

/**
 * @desc    Route publique pour l'App Mobile
 */
const checkUpdate = asyncHandler(async (req, res) => {
  const { version, userId } = req.query;

  // Enregistrer la version actuelle de l'utilisateur pour que l'admin la voie
  if (userId && version) {
    await query('UPDATE public.profiles SET app_version = $1, last_update_at = NOW() WHERE id = $2', [version, userId]);
  }

  // 1. Vérification du statut de l'utilisateur (Banni/Bloqué/Supprimé)
  if (userId) {
    const user = await query('SELECT id, is_locked FROM public.profiles WHERE id = $1', [userId]);

    // Si l'utilisateur n'existe plus (supprimé)
    if (user.rows.length === 0) {
      return res.json({
        updateRequired: false,
        accountStatus: 'deleted',
        message: 'Votre compte a été supprimé définitivement. Vous pouvez en créer un nouveau.'
      });
    }

    // Si l'utilisateur est bloqué/banni
    if (user.rows[0].is_locked) {
      return res.json({
        updateRequired: false,
        accountStatus: 'banned',
        message: 'Votre compte a été suspendu pour non-respect des conditions d\'utilisation. Vous pouvez contester cette décision.'
      });
    }
  }

  // 2. Logique de mise à jour standard
  const config = await query('SELECT * FROM public.app_configs WHERE active = TRUE ORDER BY id DESC LIMIT 1');
  if (config.rows.length === 0) return res.json({ updateRequired: false, accountStatus: 'active' });

  const latest = config.rows[0];

  // On compare les versions de manière simple mais efficace
  // Si la version de l'app est identique ou supérieure à la version cible, pas de MAJ
  if (version === latest.current_version || isVersionGreaterOrEqual(version, latest.current_version)) {
    return res.json({ updateRequired: false, accountStatus: 'active' });
  }

  const isTargeted = userId && latest.target_user_ids.includes(userId);
  const isGlobal = latest.target_user_ids.length === 0;

  if (isGlobal || isTargeted) {
    return res.json({
      updateRequired: true,
      accountStatus: 'active',
      forceUpdate: latest.force_update,
      latestVersion: latest.current_version,
      updateUrl: latest.update_url,
      releaseNotes: latest.release_notes
    });
  }

  res.json({ updateRequired: false, accountStatus: 'active' });
});

/**
 * @desc    Signaler qu'un utilisateur a fait la mise à jour
 */
const reportUpdateDone = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { version } = req.body;
  await query('UPDATE public.profiles SET app_version = $1, last_update_at = NOW() WHERE id = $2', [version, userId]);
  res.json({ success: true });
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

  // Notifier tous les utilisateurs en ligne du changement légal
  socketService.broadcast('legal_update', {
    type,
    version,
    force_acceptance: String(force_acceptance) === 'true',
    content
  });

  res.json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Supprimer un document légal (Annule l'obligation d'acceptation)
 */
const deleteLegalDoc = asyncHandler(async (req, res) => {
  const { type } = req.params;
  await query('DELETE FROM public.app_legal_docs WHERE type = $1', [type]);
  await logAdminAction(req, 'delete_legal_doc', 'legal', null, { type });
  res.json({ success: true, message: `Document ${type} supprimé.` });
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
  updateCampaign,
  deleteCampaign,
  getAuditLogs,
  broadcastMessage,
  getAppConfig,
  updateAppConfig,
  deleteAppConfig,
  checkUpdate,
  reportUpdateDone,
  getLegalDocs,
  updateLegalDoc,
  deleteLegalDoc,
  getVerificationRequests,
  handleVerification,
  ensureAdminTables
};
