const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query } = require('../config/db');
const { asyncHandler } = require('../middleware/error.middleware');
const socketService = require('../services/socket.service');
const mailService = require('../services/mail.service');
const logger = require('../utils/logger');

/**
 * @desc    Obtenir les statistiques globales
 */
const getStats = asyncHandler(async (req, res) => {
  await ensureAdminTables();
  const usersCount = await query('SELECT COUNT(*) FROM public.profiles WHERE is_global_admin = FALSE');
  const messagesCount = await query('SELECT COUNT(*) FROM public.messages');
  const chatsCount = await query('SELECT COUNT(*) FROM public.chats WHERE type = \'group\'');
  const onlineCount = await query("SELECT COUNT(*) FROM public.profiles WHERE status = 'online' AND is_global_admin = FALSE");

  res.json({
    success: true,
    data: {
      totalUsers: parseInt(usersCount.rows[0].count),
      totalMessages: parseInt(messagesCount.rows[0].count),
      totalGroups: parseInt(chatsCount.rows[0].count),
      onlineUsers: parseInt(onlineCount.rows[0].count),
    },
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
    await query(`INSERT INTO public.app_configs (current_version, force_update, active) VALUES ('50.0.0', false, true)`);
  }

  // S'assurer que les documents légaux existent avec la version 50.0.0
  const existingLegalDocs = await query('SELECT type, version FROM public.app_legal_docs');

  if (existingLegalDocs.rows.length === 0) {
    // Initialiser avec des documents légaux par défaut pour la version 50.0.0
    await query(`INSERT INTO public.app_legal_docs (type, content, version, force_acceptance) VALUES 
      ('tos', 'Conditions Générales d''Utilisation - Version 50.0.0', '50.0.0', false),
      ('privacy', 'Politique de Confidentialité - Version 50.0.0', '50.0.0', false)`);
  } else {
    // Si les documents existent mais sont en version ancienne, on les met à jour en version 50.0.0
    await query(`
      UPDATE public.app_legal_docs
      SET version = '50.0.0',
          content = CASE
            WHEN type = 'tos' THEN 'Conditions Générales d''Utilisation - Version 50.0.0'
            ELSE 'Politique de Confidentialité - Version 50.0.0'
          END,
          force_acceptance = false
      WHERE version IN ('5.0.0', '1.0.0', '31.0.0', '32.0.0', '33.0.0', '34.0.0', '35.0.0', '36.0.0', '37.0.0', '38.0.0', '39.0.0', '40.0.0', '41.0.0', '42.0.0', '43.0.0', '44.0.0', '45.0.0', '46.0.0', '47.0.0', '48.0.0', '49.0.0', '50.0.0')
    `);
  }

  // S'assurer que les colonnes nécessaires existent pour les approbations
  try {
    await query('ALTER TABLE public.admin_pending_actions ADD COLUMN IF NOT EXISTS admin_notes TEXT');
    await query('ALTER TABLE public.admin_pending_actions DROP CONSTRAINT IF EXISTS admin_pending_actions_status_check');
    await query('ALTER TABLE public.admin_pending_actions ADD CONSTRAINT admin_pending_actions_status_check CHECK (status IN (\'pending\', \'approved\', \'rejected\', \'sent_back\'))');
  } catch (e) {}

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

  // S'assurer que le seul admin global est bien configuré avec les bons identifiants
  try {
    const adminEmail = 'wecanconcept@gmail.com';
    const adminPass = 'Proverbe:19!?@';

    const existingAdminRes = await query('SELECT id, password FROM public.profiles WHERE email = $1', [adminEmail]);

    if (existingAdminRes.rows.length === 0) {
      const hashedPass = await bcrypt.hash(adminPass, 10);
      await query(
        `INSERT INTO public.profiles (id, full_name, email, password, username, is_global_admin, is_verified, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [crypto.randomUUID(), 'Administrateur Meet Me', adminEmail, hashedPass, 'admin_meetme', true, true, 'offline']
      );
      logger.info('✅ Compte Admin principal créé.');
    } else {
      const admin = existingAdminRes.rows[0];
      // Vérifier si on doit forcer la mise à jour (par précaution)
      const hashedPass = await bcrypt.hash(adminPass, 10);
      await query(
        'UPDATE public.profiles SET password = $1, is_global_admin = TRUE, is_locked = FALSE, login_attempts = 0 WHERE id = $2',
        [hashedPass, admin.id]
      );
      logger.info('✅ Compte Admin synchronisé et débloqué.');
    }

    // Retirer les droits admin des autres
    await query('UPDATE public.profiles SET is_global_admin = FALSE WHERE email != $1', [adminEmail]);

  } catch (e) {
    logger.error('❌ Erreur lors de la configuration de l\'admin:', e.message);
  }

  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE');
  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS accepted_legal_version TEXT');
  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS accepted_tos_version TEXT');
  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS accepted_privacy_version TEXT');
  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS app_version TEXT');
  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_update_at TIMESTAMP WITH TIME ZONE');
  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS collab_start_at TIMESTAMP WITH TIME ZONE');
  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS collab_end_at TIMESTAMP WITH TIME ZONE');
  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS collab_deleted_at TIMESTAMP WITH TIME ZONE');
  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_collaborator BOOLEAN DEFAULT FALSE');

  // Enforce single global admin: wecanconcept@gmail.com
  await query('UPDATE public.profiles SET is_global_admin = FALSE');
  await query('UPDATE public.profiles SET is_global_admin = TRUE WHERE email = $1', ['wecanconcept@gmail.com']);

  await query(`
    CREATE TABLE IF NOT EXISTS public.admin_delegations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE UNIQUE,
      modules TEXT[] NOT NULL DEFAULT '{}',
      is_active BOOLEAN DEFAULT TRUE,
      collab_admin_rights JSONB DEFAULT '{}',
      user_admin_rights JSONB DEFAULT '{}',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);

  try { await query('ALTER TABLE public.admin_delegations ADD COLUMN IF NOT EXISTS user_admin_rights JSONB DEFAULT \'{}\''); } catch (e) {}


  try { await query('ALTER TABLE public.admin_delegations ADD COLUMN IF NOT EXISTS collab_admin_rights JSONB DEFAULT \'{}\''); } catch (e) {}

  await query(`
    CREATE TABLE IF NOT EXISTS public.login_security (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      identifier TEXT UNIQUE NOT NULL,
      fail_count INTEGER DEFAULT 0,
      blocked_until TIMESTAMP WITH TIME ZONE,
      last_attempt_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);

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

  // S'assurer que la colonne is_banned existe dans la table chats
  try {
    await query('ALTER TABLE public.chats ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE');
  } catch (e) {
    logger.error('Error adding is_banned to chats:', e);
  }

  // S'assurer que le statut 'blocked' est autorisé dans market_businesses
  try {
    await query(`
      ALTER TABLE public.market_businesses
      DROP CONSTRAINT IF EXISTS market_businesses_status_check;
      ALTER TABLE public.market_businesses
      ADD CONSTRAINT market_businesses_status_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'blocked'));
    `);
  } catch (e) {}

  // Migration Collaboration: Sub-teams and Confidentiality
  try {
    await query('ALTER TABLE public.collab_teams ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES public.collab_teams(id) ON DELETE CASCADE');
    await query('ALTER TABLE public.collab_teams ADD COLUMN IF NOT EXISTS is_confidential BOOLEAN DEFAULT FALSE');
    await query('ALTER TABLE public.collab_teams ADD COLUMN IF NOT EXISTS color TEXT DEFAULT \'#06b6d4\'');
    // Track who saw the messages
    await query('ALTER TABLE public.collab_messages ADD COLUMN IF NOT EXISTS seen_by UUID[] DEFAULT \'{}\'');
    // Calendar enhancements: Meeting URL and Invitations
    await query('ALTER TABLE public.collab_calendar_events ADD COLUMN IF NOT EXISTS meeting_url TEXT');
    await query('ALTER TABLE public.collab_calendar_events ADD COLUMN IF NOT EXISTS invited_member_ids UUID[] DEFAULT \'{}\'');

    // NOUVEAU: Créer l'équipe par défaut si elle n'existe pas
    const defaultTeamRes = await query("SELECT id FROM public.collab_teams WHERE name = 'Together Tech Community' LIMIT 1");
    if (defaultTeamRes.rows.length === 0) {
      const adminRes = await query("SELECT id FROM public.profiles WHERE email = 'wecanconcept@gmail.com' LIMIT 1");
      if (adminRes.rows.length > 0) {
        await query(
          "INSERT INTO public.collab_teams (name, description, created_by, is_confidential, color) VALUES ($1, $2, $3, $4, $5)",
          ['Together Tech Community', 'Équipe de collaboration par défaut pour tous les nouveaux membres.', adminRes.rows[0].id, false, '#06b6d4']
        );
        logger.info('✅ Équipe par défaut créée.');
      }
    }
  } catch (e) {
    logger.error('Error migrating collab_teams:', e.message);
  }


  // S'assurer que les tables d'inventaire sont complètes
  try {
    await query('ALTER TABLE public.market_inventory ADD COLUMN IF NOT EXISTS price DECIMAL DEFAULT 0');
    await query('ALTER TABLE public.market_inventory ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()');

    // Table pour l'historique des entrées/sorties
    await query(`
      CREATE TABLE IF NOT EXISTS public.market_inventory_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES public.market_businesses(id) ON DELETE CASCADE,
        item_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        type TEXT CHECK (type IN ('in', 'out')),
        reason TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
  } catch (e) {
    logger.error('Error updating inventory tables:', e);
  }

  // TÂCHE AUTOMATIQUE : Désactiver les collaborateurs dont la date de fin est dépassée
  try {
    const expiredRes = await query(
      `UPDATE public.admin_delegations
       SET is_active = FALSE
       WHERE user_id IN (
         SELECT id FROM public.profiles
         WHERE collab_end_at < NOW() AND is_collaborator = TRUE
       ) AND is_active = TRUE
       RETURNING user_id`
    );
    if (expiredRes.rows.length > 0) {
      logger.info(`🚨 ${expiredRes.rows.length} collaborations expirées désactivées.`);
      for (const row of expiredRes.rows) {
        socketService.emitToUser(row.user_id, 'admin:delegation_updated', { isActive: false });
      }
    }
  } catch (err) {
    logger.error('Error auto-expiring collaborations:', err.message);
  }
};

const logAdminAction = async (req, action, entityType, entityId, details = {}) => {
  const adminId = req.user?.id || null;
  const adminName = req.user?.full_name || 'Admin';
  const adminAvatar = req.user?.avatar_url || null;
  try {
    const res = await query(
      'INSERT INTO public.admin_audit_logs (admin_id, action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [adminId, action, entityType, entityId, JSON.stringify(details)]
    );

    // Diffusion en temps réel
    socketService.broadcast('admin:new_audit', {
      ...res.rows[0],
      actor_name: adminName,
      actor_avatar: adminAvatar,
      action_type: action
    });
  } catch (error) {
    console.error('Audit log error:', error.message);
  }
};

/**
 * @desc    Lister tous les utilisateurs réels
 */
const getUsers = asyncHandler(async (req, res) => {
  await ensureAdminTables();
  // Security check: only global admin or authorized delegate can see users
  if (!req.user.is_global_admin && !(req.user.user_rights && req.user.user_rights.see_all_users)) {
    return res.status(403).json({ success: false, error: 'Accès refusé : Vous n\'avez pas le droit de voir la liste des utilisateurs.' });
  }

  // We hide Global Admins from the management lists (User List & Directory)
  const result = await query(`
    SELECT id, email, full_name, username, avatar_url, status, status_updated_at, phone_number, is_locked,
           login_attempts, created_at, is_global_admin, last_login_at, device_info, is_verified
    FROM public.profiles
    WHERE is_global_admin = FALSE
    ORDER BY status = 'online' DESC, status_updated_at DESC NULLS LAST
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
 * @desc    Helper to check and process sensitive actions
 */
const processSensitiveAction = async (req, actionType, targetId, targetName, details = {}) => {
  await ensureAdminTables();
  if (req.user.is_global_admin) return true; // L'admin principal peut tout faire directement

  // Créer une action en attente pour les délégués
  await query(
    `INSERT INTO public.admin_pending_actions (requested_by, action_type, target_id, target_name, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [req.userId, actionType, targetId ? targetId.toString() : null, targetName, JSON.stringify(details)]
  );

  // Notifier l'admin principal en temps réel
  const mainAdmin = await query('SELECT id FROM public.profiles WHERE email = $1', ['wecanconcept@gmail.com']);
  if (mainAdmin.rows.length > 0) {
    socketService.sendToUser(mainAdmin.rows[0].id, 'admin:new_pending_action', {
      actionType,
      targetName,
      requestedBy: req.user.full_name
    });
  }

  return false; // Action différée (nécessite approbation)
};

/**
 * @desc    Lister les actions en attente d'approbation
 */
const getPendingActions = asyncHandler(async (req, res) => {
  if (!req.user.is_global_admin) return res.status(403).json({ success: false, error: 'Accès réservé' });

  const result = await query(`
    SELECT apa.*, p.full_name as requester_name
    FROM public.admin_pending_actions apa
    JOIN public.profiles p ON apa.requested_by = p.id
    WHERE apa.status = 'pending'
    ORDER BY apa.created_at DESC
  `);
  res.json({ success: true, data: result.rows });
});

const getMyRequests = asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT apa.*, p.full_name as processor_name
    FROM public.admin_pending_actions apa
    LEFT JOIN public.profiles p ON apa.processed_by = p.id
    WHERE apa.requested_by = $1
    ORDER BY apa.created_at DESC
  `, [req.userId]);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Approuver ou rejeter une action sensible
 */
const handlePendingAction = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { decision, comment } = req.body; // 'approved', 'rejected', 'sent_back', or 'pending'

  const actionRes = await query('SELECT * FROM public.admin_pending_actions WHERE id = $1', [id]);
  if (actionRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Action non trouvée' });
  const action = actionRes.rows[0];

  // SÉCURITÉ : Seul l'admin principal peut approuver/rejeter/renvoyer
  if (decision !== 'pending' && !req.user.is_global_admin) {
    return res.status(403).json({ success: false, error: 'Accès réservé' });
  }

  // SÉCURITÉ : Un délégué peut seulement resoumettre SA PROPRE demande
  if (decision === 'pending' && action.requested_by !== req.userId) {
    return res.status(403).json({ success: false, error: 'Vous ne pouvez resoumettre que vos propres demandes' });
  }

  if (decision === 'approved') {
    // ... (Same switch logic)
    try {
      switch (action.action_type) {
        case 'delete_user':
          await query('DELETE FROM public.messages WHERE sender_id = $1', [action.target_id]);
          await query('DELETE FROM public.chat_participants WHERE user_id = $1', [action.target_id]);
          await query('UPDATE public.chats SET created_by = NULL WHERE created_by = $1', [action.target_id]);
          await query('DELETE FROM public.profiles WHERE id = $1', [action.target_id]);
          break;
        case 'toggle_user_lock':
          await query('UPDATE public.profiles SET is_locked = $1, login_attempts = $2 WHERE id = $3', [action.details.isLocked, action.details.isLocked ? 3 : 0, action.target_id]);
          break;
        case 'toggle_user_badge':
          await query('UPDATE public.profiles SET is_verified = $1 WHERE id = $2', [action.details.isVerified, action.target_id]);
          socketService.broadcast('admin:user_verification_updated', { userId: action.target_id, isVerified: action.details.isVerified });
          break;
        case 'create_team':
          const teamRes = await query(
            'INSERT INTO public.collab_teams (name, description, created_by, parent_id, is_confidential, color) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [action.target_name, action.details.description, action.requested_by, action.details.parentId || null, action.details.isConfidential || false, action.details.color || '#06b6d4']
          );
          await query(
            'INSERT INTO public.collab_team_members (team_id, user_id, role) VALUES ($1, $2, $3)',
            [teamRes.rows[0].id, action.requested_by, 'admin']
          );
          break;
        case 'update_team':
          await query(
            'UPDATE public.collab_teams SET name = $1, description = $2, is_confidential = $3, color = $4, updated_at = NOW() WHERE id = $5',
            [action.details.name, action.details.description, action.details.isConfidential, action.details.color, action.target_id]
          );
          break;
        case 'delete_team':
          await query('DELETE FROM public.collab_teams WHERE id = $1', [action.target_id]);
          break;
        case 'delete_group':
          await query('DELETE FROM public.chats WHERE id = $1', [action.target_id]);
          break;
        case 'toggle_group_ban':
          await query('UPDATE public.chats SET is_banned = $1 WHERE id = $2', [action.details.isBanned, action.target_id]);
          break;
        case 'delete_market':
          await query('DELETE FROM public.market_businesses WHERE id = $1', [action.target_id]);
          break;
        case 'toggle_market_block':
          await query('UPDATE public.market_businesses SET status = $1 WHERE id = $2', [action.details.status, action.target_id]);
          break;
        case 'collab_application':
          let applyTeamId = action.details.teamId;

          // Sécurité: Si teamId manquant, on cherche l'équipe par défaut
          if (!applyTeamId || applyTeamId === 'null') {
            const defTeam = await query("SELECT id FROM public.collab_teams WHERE name = 'Together Tech Community' LIMIT 1");
            applyTeamId = defTeam.rows[0]?.id;

            if (!applyTeamId) {
              const firstTeam = await query("SELECT id FROM public.collab_teams ORDER BY created_at ASC LIMIT 1");
              applyTeamId = firstTeam.rows[0]?.id;
            }
          }

          if (!applyTeamId) throw new Error("Aucune équipe disponible pour l'assignation.");

          // 1. Enregistrer dans collab_requests pour l'historique
          await query(
            'INSERT INTO public.collab_requests (user_id, team_id, motivation, objectives, skills, status, processed_at, processed_by) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)',
            [action.requested_by, applyTeamId, action.details.motivation, action.details.objectives, action.details.skills, 'approved', req.userId]
          );

          // 2. Ajouter aux membres de l'équipe
          await query(
            'INSERT INTO public.collab_team_members (team_id, user_id, role) VALUES ($1, $2, \'collaborator\') ON CONFLICT DO NOTHING',
            [applyTeamId, action.requested_by]
          );

          // 3. Activer le module Collaboration dans sa délégation
          const existingCollabDel = await query('SELECT modules FROM public.admin_delegations WHERE user_id = $1', [action.requested_by]);
          if (existingCollabDel.rows.length === 0) {
            await query('INSERT INTO public.admin_delegations (user_id, modules, is_active) VALUES ($1, $2, TRUE)', [action.requested_by, ['collaboration']]);
          } else {
            await query(
              `UPDATE public.admin_delegations
               SET modules = CASE WHEN NOT ('collaboration' = ANY(modules)) THEN array_append(modules, 'collaboration') ELSE modules END,
                   is_active = TRUE,
                   updated_at = NOW()
               WHERE user_id = $1`,
              [action.requested_by]
            );
          }

          // 4. S'assurer que le profil est marqué comme collaborateur
          await query('UPDATE public.profiles SET is_collaborator = TRUE WHERE id = $1', [action.requested_by]);

          socketService.emitToUser(action.requested_by, 'collab:request_processed', { status: 'approved', comment: comment || 'Bienvenue dans l\'équipe !' });
          break;
        case 'add_member':
          await mailService.sendCollabInvitationEmail(action.details.email || '', action.target_name, action.details.teamName, action.details.teamId);
          // Also add directly if it's an "add" rather than just "invite"
          await query(
            'INSERT INTO public.collab_team_members (team_id, user_id, role) VALUES ($1, $2, \'collaborator\') ON CONFLICT DO NOTHING',
            [action.details.teamId, action.target_id]
          );

          // Activer automatiquement le module collaboration si pas déjà fait
          const addDel = await query('SELECT modules FROM public.admin_delegations WHERE user_id = $1', [action.target_id]);
          if (addDel.rows.length === 0) {
            await query('INSERT INTO public.admin_delegations (user_id, modules, is_active) VALUES ($1, $2, TRUE)', [action.target_id, ['collaboration']]);
          } else if (!addDel.rows[0].modules.includes('collaboration')) {
            await query('UPDATE public.admin_delegations SET modules = array_append(modules, \'collaboration\'), is_active = TRUE WHERE user_id = $1', [action.target_id]);
          }

          socketService.broadcast('collab:member_moved', { userId: action.target_id, toTeamId: action.details.teamId });
          break;
        case 'move_member':
          // Retirer de toutes les équipes d'abord pour un déplacement propre
          await query('DELETE FROM public.collab_team_members WHERE user_id = $1', [action.target_id]);

          if (action.details.toTeamId && action.details.toTeamId !== 'null' && action.details.toTeamId !== '') {
            await query(
              'INSERT INTO public.collab_team_members (team_id, user_id, role) VALUES ($1, $2, \'collaborator\') ON CONFLICT DO NOTHING',
              [action.details.toTeamId, action.target_id]
            );

            // Activer automatiquement le module collaboration si pas déjà fait
            const moveDel = await query('SELECT modules FROM public.admin_delegations WHERE user_id = $1', [action.target_id]);
            if (moveDel.rows.length === 0) {
              await query('INSERT INTO public.admin_delegations (user_id, modules, is_active) VALUES ($1, $2, TRUE)', [action.target_id, ['collaboration']]);
            } else if (!moveDel.rows[0].modules.includes('collaboration')) {
              await query('UPDATE public.admin_delegations SET modules = array_append(modules, \'collaboration\'), is_active = TRUE WHERE user_id = $1', [action.target_id]);
            }
          }
          socketService.broadcast('collab:member_moved', { userId: action.target_id, fromTeamId: action.details.fromTeamId, toTeamId: action.details.toTeamId });
          break;
      }
      await query('UPDATE public.admin_pending_actions SET status = \'approved\', processed_at = NOW(), processed_by = $1, admin_notes = $2 WHERE id = $3', [req.userId, comment || null, id]);
    } catch (err) {
      return res.status(500).json({ success: false, error: 'Erreur lors de l\'exécution de l\'action approuvée' });
    }
  } else if (decision === 'pending') {
    // Resoumission par le délégué
    await query('UPDATE public.admin_pending_actions SET status = \'pending\', processed_at = NULL, processed_by = NULL WHERE id = $1', [id]);

    // Notifier l'admin principal
    const mainAdmin = await query('SELECT id FROM public.profiles WHERE email = $1', ['wecanconcept@gmail.com']);
    if (mainAdmin.rows.length > 0) {
      socketService.sendToUser(mainAdmin.rows[0].id, 'admin:new_pending_action', {
        actionType: action.action_type,
        targetName: action.target_name,
        requestedBy: req.user.full_name
      });
    }
  } else {
    // rejected or sent_back
    await query('UPDATE public.admin_pending_actions SET status = $1, processed_at = NOW(), processed_by = $2, admin_notes = $3 WHERE id = $4', [decision, req.userId, comment || null, id]);
  }

  socketService.sendToUser(action.requested_by, 'admin:action_processed', {
    actionType: action.action_type,
    decision,
    comment: comment || null
  });

  await logAdminAction(req, `handle_pending_${decision}`, 'pending_action', id, { decision, comment });

  res.json({ success: true, message: `Action ${decision}.` });
});

/**
 * @desc    Supprimer une action pendante
 */
const deletePendingAction = asyncHandler(async (req, res) => {
  if (!req.user.is_global_admin) return res.status(403).json({ success: false, error: 'Accès réservé' });
  const { id } = req.params;
  await query('DELETE FROM public.admin_pending_actions WHERE id = $1', [id]);
  await logAdminAction(req, 'delete_pending_action', 'pending_action', id);
  res.json({ success: true, message: 'Action supprimée.' });
});

/**
 * @desc    Lister les délégations (Atributions)
 */
const getDelegations = asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT ad.*, p.full_name, p.email, p.avatar_url, p.is_global_admin
    FROM public.admin_delegations ad
    JOIN public.profiles p ON ad.user_id = p.id
    WHERE p.is_global_admin = FALSE
    ORDER BY ad.created_at DESC
  `);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Créer ou mettre à jour une délégation
 */
const saveDelegation = asyncHandler(async (req, res) => {
  await ensureAdminTables();
  if (!req.user.is_global_admin) return res.status(403).json({ success: false, error: 'Accès réservé' });
  const { userId, modules, isActive = true, collabAdminRights = {}, userAdminRights = {} } = req.body;

  const userRes = await query('SELECT id, full_name, email FROM public.profiles WHERE id = $1', [userId]);
  if (userRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Utilisateur Meet Me non trouvé' });

  const user = userRes.rows[0];

  await query(
    `INSERT INTO public.admin_delegations (user_id, modules, is_active, collab_admin_rights, user_admin_rights, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id) DO UPDATE
     SET modules = EXCLUDED.modules, is_active = EXCLUDED.is_active,
         collab_admin_rights = EXCLUDED.collab_admin_rights,
         user_admin_rights = EXCLUDED.user_admin_rights,
         updated_at = NOW()`,
    [userId, modules, isActive, JSON.stringify(collabAdminRights), JSON.stringify(userAdminRights)]
  );

  // Si révoqué, on retire aussi des équipes de collaboration
  if (!isActive) {
    await query('DELETE FROM public.collab_team_members WHERE user_id = $1', [userId]);
    socketService.broadcast('collab:member_moved', { userId, toTeamId: null }); // Force UI update
  }

  const mailService = require('../services/mail.service');
  await mailService.sendAdminPrivilegeEmail(user.email, user.full_name, modules);

  // Mise à jour temps réel via Socket
  socketService.emitToUser(userId, 'admin:delegation_updated', { userId, modules, isActive });

  res.json({ success: true, message: 'Privilèges enregistrés et invitation envoyée.' });
});

/**
 * @desc    Supprimer un utilisateur
 */
const deleteUser = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const user = await query('SELECT full_name, is_global_admin FROM public.profiles WHERE id = $1', [userId]);
  if (!user.rows[0]) return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });
  if (user.rows[0].is_global_admin) return res.status(403).json({ success: false, error: 'Impossible de supprimer un administrateur global' });

  // Security check for delegate
  if (!req.user.is_global_admin && !(req.user.user_rights && req.user.user_rights.delete_user)) {
    return res.status(403).json({ success: false, error: 'Accès refusé : Vous n\'avez pas le droit de supprimer des utilisateurs.' });
  }

  const canExecute = await processSensitiveAction(req, 'delete_user', userId, user.rows[0].full_name);
  if (!canExecute) return res.json({ success: true, pending: true, message: 'Demande de suppression envoyée à l\'admin principal.' });

  await query('DELETE FROM public.messages WHERE sender_id = $1', [userId]);
  await query('DELETE FROM public.chat_participants WHERE user_id = $1', [userId]);
  await query('UPDATE public.chats SET created_by = NULL WHERE created_by = $1', [userId]);
  await query('DELETE FROM public.profiles WHERE id = $1', [userId]);

  await logAdminAction(req, 'delete_user', 'user', userId, { deleted: true });
  res.json({ success: true, message: 'Utilisateur supprimé' });
});

/**
 * @desc    Bloquer/Débloquer
 */
const toggleUserLock = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { isLocked } = req.body;
  const user = await query('SELECT full_name FROM public.profiles WHERE id = $1', [userId]);
  if (!user.rows[0]) return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });

  // Security check for delegate
  if (!req.user.is_global_admin && !(req.user.user_rights && req.user.user_rights.lock_user)) {
    return res.status(403).json({ success: false, error: 'Accès refusé : Vous n\'avez pas le droit de bloquer des utilisateurs.' });
  }

  const canExecute = await processSensitiveAction(req, 'toggle_user_lock', userId, user.rows[0].full_name, { isLocked });
  if (!canExecute) return res.json({ success: true, pending: true, message: `Demande de ${isLocked ? 'blocage' : 'déblocage'} envoyée.` });

  await query('UPDATE public.profiles SET is_locked = $1, login_attempts = $2 WHERE id = $3', [isLocked, isLocked ? 3 : 0, userId]);
  await logAdminAction(req, isLocked ? 'lock_user' : 'unlock_user', 'user', userId, { isLocked });
  res.json({ success: true });
});

/**
 * @desc    Toggle user verification badge
 */
const toggleUserBadge = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { isVerified } = req.body;
  const user = await query('SELECT full_name FROM public.profiles WHERE id = $1', [userId]);
  if (!user.rows[0]) return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });

  // Security check for delegate
  if (!req.user.is_global_admin && !(req.user.user_rights && req.user.user_rights.verify_user)) {
    return res.status(403).json({ success: false, error: 'Accès refusé : Vous n\'avez pas le droit de gérer les badges.' });
  }

  const canExecute = await processSensitiveAction(req, 'toggle_user_badge', userId, user.rows[0].full_name, { isVerified });
  if (!canExecute) return res.json({ success: true, pending: true, message: `Demande de ${isVerified ? 'certification' : 'retrait de badge'} envoyée.` });

  await query('UPDATE public.profiles SET is_verified = $1 WHERE id = $2', [isVerified, userId]);
  await logAdminAction(req, isVerified ? 'verify_user' : 'unverify_user', 'user', userId, { isVerified });

  // Real-time update via socket
  socketService.broadcast('admin:user_verification_updated', { userId, isVerified });

  res.json({ success: true });
});

/**
 * @desc    Lister les groupes
 */
const getGroups = asyncHandler(async (req, res) => {
  await ensureAdminTables();
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
 * @desc    Membres d'un groupe
 */
const getGroupMembers = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const result = await query(`
    SELECT p.id, p.full_name, p.username, p.email, p.avatar_url, cp.role, cp.joined_at
    FROM public.chat_participants cp
    JOIN public.profiles p ON cp.user_id = p.id
    WHERE cp.chat_id = $1
    ORDER BY cp.joined_at DESC
  `, [chatId]);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Mettre à jour le rôle d'un membre (Nommer Admin, etc.)
 */
const updateMemberRole = asyncHandler(async (req, res) => {
  const { chatId, userId } = req.params;
  const { role } = req.body; // 'admin' or 'member'

  await query(
    'UPDATE public.chat_participants SET role = $1 WHERE chat_id = $2 AND user_id = $3',
    [role, chatId, userId]
  );

  res.json({ success: true });
});

/**
 * @desc    Déplacer un membre vers un autre groupe
 */
const moveMemberToGroup = asyncHandler(async (req, res) => {
  const { userId, fromChatId, toChatId } = req.body;

  // 1. Retirer de l'ancien groupe
  await query('DELETE FROM public.chat_participants WHERE chat_id = $1 AND user_id = $2', [fromChatId, userId]);

  // 2. Ajouter au nouveau groupe
  await query(
    'INSERT INTO public.chat_participants (chat_id, user_id, role) VALUES ($1, $2, \'member\') ON CONFLICT DO NOTHING',
    [toChatId, userId]
  );

  res.json({ success: true });
});

/**
 * @desc    Lister tous les groupes (pour sélection dans le déplacement)
 */
const getAllGroupsList = asyncHandler(async (req, res) => {
  const result = await query('SELECT id, name FROM public.chats WHERE type = \'group\' ORDER BY name ASC');
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Mettre à jour les informations du groupe (Logo, Description)
 */
const updateGroupInfo = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const { name, description, avatar_url } = req.body;

  await query(
    'UPDATE public.chats SET name = $1, description = $2, avatar_url = $3, updated_at = NOW() WHERE id = $4',
    [name, description, avatar_url, chatId]
  );

  res.json({ success: true });
});

/**
 * @desc    Bannir/Débannir un groupe
 */
const toggleGroupBan = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const { isBanned } = req.body;
  const group = await query('SELECT name FROM public.chats WHERE id = $1', [chatId]);
  if (!group.rows[0]) return res.status(404).json({ success: false, error: 'Groupe non trouvé' });

  const canExecute = await processSensitiveAction(req, 'toggle_group_ban', chatId, group.rows[0].name, { isBanned });
  if (!canExecute) return res.json({ success: true, pending: true, message: `Demande de ${isBanned ? 'bannissement' : 'débannissement'} envoyée.` });

  await query('UPDATE public.chats SET is_banned = $1 WHERE id = $2', [isBanned, chatId]);

  // Notification Socket temps réel pour le groupe
  socketService.broadcast('group_status_changed', { chatId, isBanned });

  await logAdminAction(req, isBanned ? 'ban_group' : 'unban_group', 'group', chatId, { isBanned });
  res.json({ success: true });
});

/**
 * @desc    Supprimer un groupe
 */
const deleteGroup = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const group = await query('SELECT name FROM public.chats WHERE id = $1', [chatId]);
  if (!group.rows[0]) return res.status(404).json({ success: false, error: 'Groupe non trouvé' });

  const canExecute = await processSensitiveAction(req, 'delete_group', chatId, group.rows[0].name);
  if (!canExecute) return res.json({ success: true, pending: true, message: 'Demande de suppression envoyée à l\'admin principal.' });

  await query('DELETE FROM public.chats WHERE id = $1', [chatId]);

  // Notification Socket temps réel
  socketService.broadcast('group_deleted', { chatId });

  await logAdminAction(req, 'delete_group', 'group', chatId, { deleted: true });
  res.json({ success: true });
});

/**
 * @desc    Retirer un membre d'un groupe
 */
const removeGroupMember = asyncHandler(async (req, res) => {
  const { chatId, userId } = req.params;

  const result = await query('DELETE FROM public.chat_participants WHERE chat_id = $1 AND user_id = $2 RETURNING *', [chatId, userId]);

  if (result.rows.length > 0) {
    // Notifier le membre et le groupe du retrait
    socketService.emitToUser(userId, 'removed_from_group', { chatId });
    socketService.broadcast('member_removed', { chatId, userId });

    await logAdminAction(req, 'remove_member', 'chat_member', userId, { chatId });
    res.json({ success: true, message: 'Membre retiré.' });
  } else {
    res.status(404).json({ success: false, error: 'Membre non trouvé dans ce groupe.' });
  }
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
  const { title, message, target = 'all', targetValue, scheduledAt, theme = 'amazon', ctaText, ctaUrl } = req.body;
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
    [title, message, target || 'all', targetValue || null, req.user?.id || null, isFuture ? 'scheduled' : 'sent', scheduledDate, JSON.stringify({ theme, ctaText, ctaUrl })]
  );

  // Si l'envoi est immédiat
  if (!isFuture) {
    const cta = ctaText ? { text: ctaText, url: ctaUrl } : null;
    if (target === 'all') {
      const users = await query('SELECT id, email, full_name FROM public.profiles WHERE is_global_admin = FALSE');
      for (const user of users.rows) {
        socketService.sendToUser(user.id, 'push_notification', { title, body: message, type: 'campaign' });
        await mailService.sendSystemEmail(user.email, title, message, theme, user.full_name || 'Utilisateur', cta);
      }
      await query('UPDATE public.notification_campaigns SET sent_count = $1 WHERE id = $2', [users.rows.length, campaign.rows[0].id]);
    } else if (targetValue) {
      const emails = targetValue.split(',').map(e => e.trim()).filter(e => e);
      let sentCount = 0;
      for (const email of emails) {
        const userRes = await query('SELECT id, full_name FROM public.profiles WHERE email = $1', [email]);
        const userName = userRes.rows[0]?.full_name || 'Utilisateur';
        if (userRes.rows.length > 0) {
          socketService.sendToUser(userRes.rows[0].id, 'push_notification', { title, body: message, type: 'campaign' });
        }
        const success = await mailService.sendSystemEmail(email, title, message, theme, userName, cta);
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
  const { title, message, scheduledAt, theme, ctaText, ctaUrl } = req.body;

  const result = await query(
    `UPDATE public.notification_campaigns
     SET title = COALESCE($1, title),
         message = COALESCE($2, message),
         scheduled_at = COALESCE($3, scheduled_at),
         metadata = metadata || jsonb_build_object(
           'theme', COALESCE($4::text, metadata->>'theme'),
           'ctaText', COALESCE($5::text, metadata->>'ctaText'),
           'ctaUrl', COALESCE($6::text, metadata->>'ctaUrl')
         ),
         updated_at = NOW()
     WHERE id = $7 AND status = 'scheduled'
     RETURNING *`,
    [title, message, scheduledAt, theme || null, ctaText || null, ctaUrl || null, id]
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

const getAnalytics = asyncHandler(async (req, res) => {
  // Logic to gather analytics
  res.json({ success: true, data: {} });
});

const getAuditLogs = asyncHandler(async (req, res) => {
  await ensureAdminTables();
  const result = await query(`
    SELECT a.*, p.full_name AS actor_name, p.avatar_url AS actor_avatar
    FROM public.admin_audit_logs a
    LEFT JOIN public.profiles p ON p.id = a.admin_id
    ORDER BY a.created_at DESC
    LIMIT 100
  `);
  res.json({ success: true, data: result.rows });
});

const broadcastMessage = asyncHandler(async (req, res) => {
  const { content, title, target = 'all', specificEmail, scheduledAt, theme = 'amazon', ctaText, ctaUrl } = req.body;
  if (!content || !title) return res.status(400).json({ success: false, error: 'Titre et contenu requis' });

  // Si scheduledAt est fourni et est dans le futur, on enregistre dans notification_campaigns avec le type 'broadcast'
  const now = new Date();
  const scheduledDate = scheduledAt ? new Date(scheduledAt) : now;
  const isFuture = scheduledDate > now;

  if (isFuture) {
    const campaign = await query(
      `INSERT INTO public.notification_campaigns (title, message, target, target_value, created_by, status, scheduled_at, sent_count, metadata)
       VALUES ($1, $2, $3, $4, $5, 'scheduled', $6, 0, $7) RETURNING *`,
      [title, content, target, specificEmail || null, req.user?.id || null, scheduledDate, JSON.stringify({ theme, isBroadcast: true, ctaText, ctaUrl })]
    );
    await logAdminAction(req, 'broadcast_scheduled', 'system', campaign.rows[0].id, { title, target, scheduledAt });
    return res.json({ success: true, message: 'Diffusion programmée avec succès.' });
  }

  const cta = ctaText ? { text: ctaText, url: ctaUrl } : null;

  if (target === 'all') {
    socketService.broadcast('push_notification', { title, body: content, type: 'system' });
    const users = await query('SELECT email, full_name FROM public.profiles WHERE is_global_admin = FALSE');
    for (const user of users.rows) {
      await mailService.sendSystemEmail(user.email, title, content, theme, user.full_name || 'Utilisateur', cta);
    }

    // Sauvegarder dans l'historique
    await query(
      `INSERT INTO public.notification_campaigns (title, message, target, target_value, created_by, status, scheduled_at, sent_count, metadata)
       VALUES ($1, $2, $3, $4, $5, 'sent', NOW(), $6, $7)`,
      [title, content, 'all', null, req.user?.id || null, users.rows.length, JSON.stringify({ theme, isBroadcast: true, ctaText, ctaUrl })]
    );

    await logAdminAction(req, 'broadcast_message', 'system', null, { title, target: 'all', count: users.rows.length, theme });
    res.json({ success: true, message: `Diffusion envoyée à ${users.rows.length} utilisateurs.` });
  } else if (specificEmail) {
    // Supporter plusieurs emails séparés par des virgules
    const emails = specificEmail.split(',').map(e => e.trim()).filter(e => e);
    let sentCount = 0;

    for (const email of emails) {
      const userRes = await query('SELECT id, full_name FROM public.profiles WHERE email = $1', [email]);
      const userName = userRes.rows[0]?.full_name || 'Utilisateur';
      if (userRes.rows.length > 0) {
        socketService.sendToUser(userRes.rows[0].id, 'push_notification', { title, body: content, type: 'system' });
      }
      const success = await mailService.sendSystemEmail(email, title, content, theme, userName, cta);
      if (success) sentCount++;
    }

    // Sauvegarder dans l'historique
    await query(
      `INSERT INTO public.notification_campaigns (title, message, target, target_value, created_by, status, scheduled_at, sent_count, metadata)
       VALUES ($1, $2, $3, $4, $5, 'sent', NOW(), $6, $7)`,
      [title, content, 'specific', specificEmail, req.user?.id || null, sentCount, JSON.stringify({ theme, isBroadcast: true, ctaText, ctaUrl })]
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
  const configRes = await query('SELECT * FROM public.app_configs ORDER BY id DESC LIMIT 1');

  // Stats des versions utilisateurs
  const statsRes = await query(`
    SELECT app_version, COUNT(*) as count
    FROM public.profiles
    WHERE is_global_admin = FALSE
    GROUP BY app_version
    ORDER BY app_version DESC
  `);

  // Liste des utilisateurs avec leurs versions pour le tracking individuel
  const usersRes = await query(`
    SELECT id, full_name, email, app_version, last_update_at, device_info
    FROM public.profiles
    WHERE is_global_admin = FALSE
    ORDER BY last_update_at DESC NULLS LAST
  `);

  const currentAppVersion = '50.0.0';

  res.json({
    success: true,
    config: configRes.rows[0] || null,
    stats: statsRes.rows,
    users: usersRes.rows,
    currentAppVersion
  });
});

const updateAppConfig = asyncHandler(async (req, res) => {
  const { current_version, force_update, update_url, release_notes, target_user_ids = [], active = true } = req.body;

  await ensureAdminTables();

  // Désactiver les anciennes configs si celle-ci est active
  if (active) {
    await query('UPDATE public.app_configs SET active = FALSE');
  }

  const result = await query(
    `INSERT INTO public.app_configs (current_version, force_update, update_url, release_notes, target_user_ids, active)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [current_version, force_update, update_url, release_notes, target_user_ids, active]
  );

  // Diffusion temps réel immédiate
  socketService.broadcast('app_config_update', {
    current_version,
    force_update,
    update_url,
    release_notes,
    target_user_ids
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
  const broadcastData = {
    type,
    version,
    force_acceptance: force_acceptance === true || String(force_acceptance) === 'true',
    content,
    isRealTime: true,
    timestamp: new Date().toISOString()
  };

  logger.info(`📢 Broadcasting legal_update: ${type} v${version} (Forced: ${broadcastData.force_acceptance})`);
  socketService.broadcast('legal_update', broadcastData);

  res.json({ success: true, data: result.rows[0] });
});

/**
 * @desc    Supprimer un document légal (Annule l'obligation d'acceptation)
 */
const deleteLegalDoc = asyncHandler(async (req, res) => {
  const { type } = req.params;
  await query('DELETE FROM public.app_legal_docs WHERE type = $1', [type]);
  await logAdminAction(req, 'delete_legal_doc', 'legal', null, { type });

  // Notifier en temps réel pour retirer l'écran de blocage chez les clients
  socketService.broadcast('legal_removed', { type });

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

/**
 * @desc    Get all pending market business requests
 */
const getMarketRequests = asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT mb.*, p.full_name as owner_name, p.email as owner_email
    FROM public.market_businesses mb
    JOIN public.profiles p ON mb.user_id = p.id
    ORDER BY mb.created_at DESC
  `);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Approve or reject a market business
 */
const handleMarketRequest = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, admin_notes } = req.body; // 'approved' or 'rejected'

  const businessRes = await query('SELECT * FROM public.market_businesses WHERE id = $1', [id]);
  if (businessRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Business non trouvé' });

  const business = businessRes.rows[0];
  const userId = business.user_id;

  if (status === 'approved') {
    // 1. Marquer comme approuvé
    await query(
      'UPDATE public.market_businesses SET status = $1, verified_at = NOW(), updated_at = NOW() WHERE id = $2',
      ['approved', id]
    );

    // --- NOUVELLE LOGIQUE D'AJOUT AUTOMATIQUE AU GROUPE ---
    const groupName = `${business.category} Meet Me`;

    // Vérifier si le groupe de catégorie existe déjà
    let groupRes = await query("SELECT id FROM public.chats WHERE name = $1 AND type = 'group'", [groupName]);
    let chatId;

    if (groupRes.rows.length === 0) {
      // Créer le groupe s'il n'existe pas
      const newGroup = await query(
        "INSERT INTO public.chats (name, description, type, avatar_url) VALUES ($1, $2, 'group', $3) RETURNING id",
        [groupName, `Groupe officiel des professionnels : ${business.category}`, 'https://cdn-icons-png.flaticon.com/512/3081/3081559.png']
      );
      chatId = newGroup.rows[0].id;
    } else {
      chatId = groupRes.rows[0].id;
    }

    // Ajouter l'utilisateur au groupe
    await query(
      "INSERT INTO public.chat_participants (chat_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING",
      [chatId, userId]
    );
    // -----------------------------------------------------

    // 3. Notifier l'utilisateur par Socket et EMAIL
    const socketService = require('../services/socket.service');
    socketService.sendToUser(userId, 'market:approved', {
      businessName: business.business_name,
      chatId
    });

    const mailService = require('../services/mail.service');
    await mailService.sendMarketApprovalEmail(
      business.owner_email || '',
      business.owner_name || 'Utilisateur',
      business.business_name,
      business.category,
      groupName
    );

  } else {
    await query(
      'UPDATE public.market_businesses SET status = $1, updated_at = NOW() WHERE id = $2',
      ['rejected', id]
    );

    // Notifier le rejet par EMAIL
    const mailService = require('../services/mail.service');
    const userInfo = await query('SELECT full_name, email FROM public.profiles WHERE id = $1', [userId]);
    if (userInfo.rows.length > 0) {
      await mailService.sendMarketRejectionEmail(
        userInfo.rows[0].email,
        userInfo.rows[0].full_name,
        business.business_name,
        admin_notes || 'Les informations fournies ne correspondent pas à nos critères de sélection.'
      );
    }
  }

  await logAdminAction(req, `market_${status}`, 'market', id, { businessName: business.business_name });
  res.json({ success: true, message: `Business ${status === 'approved' ? 'approuvé' : 'rejeté'}.` });
});

/**
 * @desc    Block or unblock a market business
 */
const toggleMarketBlock = asyncHandler(async (req, res) => {
  await ensureAdminTables();
  const { id } = req.params;
  const { block } = req.body; // true to block, false to unblock

  const businessRes = await query('SELECT * FROM public.market_businesses WHERE id = $1', [id]);
  if (businessRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Business non trouvé' });

  const business = businessRes.rows[0];
  const newStatus = block ? 'blocked' : 'approved';

  await query(
    'UPDATE public.market_businesses SET status = $1, updated_at = NOW() WHERE id = $2',
    [newStatus, id]
  );

  // Notifier l'utilisateur
  const socketService = require('../services/socket.service');
  socketService.sendToUser(business.user_id, 'market:status_changed', {
    businessName: business.business_name,
    status: newStatus
  });

  await logAdminAction(req, `market_${newStatus}`, 'market', id, { businessName: business.business_name });
  res.json({ success: true, message: `Business ${block ? 'bloqué' : 'débloqué'}.` });
});

/**
 * @desc    Delete a market business
 */
const deleteMarketBusiness = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const businessRes = await query('SELECT * FROM public.market_businesses WHERE id = $1', [id]);
  if (businessRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Business non trouvé' });

  const business = businessRes.rows[0];

  await query('DELETE FROM public.market_businesses WHERE id = $1', [id]);

  // Notifier l'utilisateur
  const socketService = require('../services/socket.service');
  socketService.sendToUser(business.user_id, 'market:deleted', {
    businessName: business.business_name
  });

  await logAdminAction(req, 'market_deleted', 'market', id, { businessName: business.business_name });
  res.json({ success: true, message: 'Business supprimé définitivement.' });
});

/**
 * @desc    Create an official category group manually
 */
const createOfficialGroup = asyncHandler(async (req, res) => {
  const { category, businessId } = req.body;
  const groupName = `${category} Meet Me`;

  // 1. Trouver le business pour avoir le user_id
  const businessRes = await query('SELECT user_id, business_name FROM public.market_businesses WHERE id = $1', [businessId]);
  if (businessRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Business non trouvé' });
  const userId = businessRes.rows[0].user_id;

  // 2. Créer ou récupérer le groupe
  let groupRes = await query("SELECT id FROM public.chats WHERE name = $1 AND type = 'group'", [groupName]);
  let chatId;

  if (groupRes.rows.length === 0) {
    const newGroup = await query(
      "INSERT INTO public.chats (name, description, type, avatar_url, created_by) VALUES ($1, $2, 'group', $3, $4) RETURNING id",
      [groupName, `Groupe officiel des professionnels de la catégorie ${category}`, 'https://cdn-icons-png.flaticon.com/512/3081/3081559.png', req.user.id]
    );
    chatId = newGroup.rows[0].id;
  } else {
    chatId = groupRes.rows[0].id;
  }

  // 3. Ajouter l'utilisateur
  await query(
    "INSERT INTO public.chat_participants (chat_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING",
    [chatId, userId]
  );

  await logAdminAction(req, 'create_market_group', 'chat', chatId, { category, businessName: businessRes.rows[0].business_name });
  res.json({ success: true, message: `Utilisateur ajouté au groupe officiel ${category}.` });
});

/**
 * @desc    Get members of a market group for management
 */
const getMarketGroupMembers = asyncHandler(async (req, res) => {
  const { category } = req.query;
  const groupName = `${category} Meet Me`;

  const groupRes = await query("SELECT id FROM public.chats WHERE name = $1 AND type = 'group'", [groupName]);
  if (groupRes.rows.length === 0) return res.json({ success: true, data: [] });

  const members = await query(
    `SELECT p.id, p.full_name, p.email, p.avatar_url, mb.business_name, mb.id as business_id
     FROM public.chat_participants cp
     JOIN public.profiles p ON cp.user_id = p.id
     JOIN public.market_businesses mb ON p.id = mb.user_id
     WHERE cp.chat_id = $1`,
    [groupRes.rows[0].id]
  );

  res.json({ success: true, data: members.rows });
});

/**
 * @desc    Remove member from market group
 */
const removeMarketGroupMember = asyncHandler(async (req, res) => {
  const { businessId, category } = req.body;
  const groupName = `${category} Meet Me`;

  const business = await query('SELECT user_id FROM public.market_businesses WHERE id = $1', [businessId]);
  const group = await query("SELECT id FROM public.chats WHERE name = $1", [groupName]);

  if (business.rows.length > 0 && group.rows.length > 0) {
    await query('DELETE FROM public.chat_participants WHERE chat_id = $1 AND user_id = $2', [group.rows[0].id, business.rows[0].user_id]);
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false });
  }
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

    // Notification en temps réel pour l'utilisateur (badge)
    socketService.emitToUser(userId, 'profile_updated', { is_verified: true });
    socketService.broadcast('admin:user_verified', { userId, isVerified: true });
  } else {
    await query('UPDATE public.profiles SET is_verified = FALSE WHERE id = $1', [userId]);
    socketService.emitToUser(userId, 'profile_updated', { is_verified: false });
  }

  await logAdminAction(req, 'handle_verification', 'verification', id, { status });
  res.json({ success: true });
});

/**
 * @desc    Créer un compte collaborateur complet
 */
const createCollaborator = asyncHandler(async (req, res) => {
  const { full_name, email, username, avatar_url, modules, collab_start_at, collab_end_at, collabAdminRights = {}, userAdminRights = {} } = req.body;

  if (!email || !full_name) {
    return res.status(400).json({ success: false, error: 'Champs obligatoires manquants.' });
  }

  // Vérifier si l'utilisateur existe déjà
  const existing = await query('SELECT id FROM public.profiles WHERE email = $1 OR username = $2', [email, username]);
  if (existing.rows.length > 0) {
    return res.status(400).json({ success: false, error: 'Cet email ou nom d\'utilisateur est déjà utilisé.' });
  }

  // Générer un mot de passe temporaire
  const tempPassword = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 caractères
  const hashedPassword = await bcrypt.hash(tempPassword, 10);
  const userId = crypto.randomUUID();

  // 1. Créer le profil avec l'obligation de changer de mot de passe
  await query(
    `INSERT INTO public.profiles (id, full_name, email, password, username, avatar_url, is_collaborator, collab_start_at, collab_end_at, is_verified, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [userId, full_name, email, hashedPassword, username || email.split('@')[0], avatar_url || null, true, collab_start_at || new Date(), collab_end_at || null, true, true]
  );

  // 2. Créer la délégation (Rôles et Accès)
  await query(
    `INSERT INTO public.admin_delegations (user_id, modules, is_active, collab_admin_rights, user_admin_rights)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, modules || [], true, JSON.stringify(collabAdminRights), JSON.stringify(userAdminRights)]
  );

  // 3. Envoyer l'email avec le mot de passe temporaire
  await mailService.sendCollaboratorAccountEmail(email, full_name, tempPassword);

  // 4. Ajouter à l'équipe par défaut si le module collaboration est présent
  if (modules && modules.includes('collaboration')) {
    try {
      const defaultTeamRes = await query("SELECT id FROM public.collab_teams WHERE name = 'Together Tech Community' LIMIT 1");
      if (defaultTeamRes.rows.length > 0) {
        await query(
          'INSERT INTO public.collab_team_members (team_id, user_id, role) VALUES ($1, $2, \'collaborator\') ON CONFLICT DO NOTHING',
          [defaultTeamRes.rows[0].id, userId]
        );
        logger.info(`✅ Collaborateur ${full_name} ajouté à l'équipe par défaut.`);
      }
    } catch (err) {
      logger.error('Erreur lors de l\'ajout à l\'équipe par défaut:', err.message);
    }
  }

  await logAdminAction(req, 'create_collaborator', 'user', userId, { email, full_name, tempPassword_sent: true });

  res.status(201).json({ success: true, message: 'Compte collaborateur créé et email envoyé.', data: { id: userId } });
});

/**
 * @desc    Supprimer un collaborateur (Soft delete avec date)
 */
const deleteCollaborator = asyncHandler(async (req, res) => {
  const { userId } = req.params;

  const user = await query('SELECT full_name, is_global_admin FROM public.profiles WHERE id = $1', [userId]);
  if (user.rows.length === 0) return res.status(404).json({ success: false, error: 'Collaborateur non trouvé.' });
  if (user.rows[0].is_global_admin) return res.status(403).json({ success: false, error: 'Action interdite sur un admin global.' });

  // On marque comme supprimé avec la date actuelle
  const now = new Date();
  await query(
    'UPDATE public.profiles SET collab_deleted_at = $1, is_collaborator = FALSE WHERE id = $2',
    [now, userId]
  );

  // Désactiver sa délégation
  await query('UPDATE public.admin_delegations SET is_active = FALSE WHERE user_id = $1', [userId]);

  await logAdminAction(req, 'delete_collaborator', 'user', userId, { deleted_at: now });

  res.json({ success: true, message: 'Collaboration terminée et compte désactivé.', deleted_at: now });
});

module.exports = {
  getStats,
  getUsers,
  getReports,
  resolveReport,
  deleteUser,
  toggleUserLock,
  toggleUserBadge,
  getGroups,
  getGroupMembers,
  updateMemberRole,
  moveMemberToGroup,
  getAllGroupsList,
  updateGroupInfo,
  toggleGroupBan,
  deleteGroup,
  removeGroupMember,
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
  getMarketRequests,
  handleMarketRequest,
  toggleMarketBlock,
  deleteMarketBusiness,
  createOfficialGroup,
  getMarketGroupMembers,
  removeMarketGroupMember,
  getPendingActions,
  getMyRequests,
  handlePendingAction,
  deletePendingAction,
  getDelegations,
  saveDelegation,
  createCollaborator,
  deleteCollaborator,
  ensureAdminTables,
  processSensitiveAction
};
