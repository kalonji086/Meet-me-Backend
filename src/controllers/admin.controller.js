const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query, pool } = require('../config/db');
const { asyncHandler } = require('../middleware/error.middleware');
const socketService = require('../services/socket.service');
const mailService = require('../services/mail.service');
const logger = require('../utils/logger');
const employerController = require('./employer.controller');

/**
 * Helper: Log admin action to Audit Logs
 */
const logAudit = async (adminId, action, entityType, entityId, details) => {
  try {
    await query(
      'INSERT INTO public.admin_audit_logs (admin_id, action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4, $5)',
      [adminId, action, entityType, entityId, JSON.stringify(details)]
    );
  } catch (err) { logger.error('Audit Log Error:', err); }
};

/**
 * Helper: Check Granular Permission or Submit for Approval
 */
const checkPermOrRequest = async (req, res, moduleId, permission, actionData) => {
  if (req.user.is_global_admin) return true; // Global admin bypasses everything

  const { userId } = req;
  const delRes = await query('SELECT granular_permissions, requires_approval FROM public.admin_delegations WHERE user_id = $1 AND is_active = TRUE', [userId]);

  if (delRes.rows.length === 0) {
    res.status(403).json({ success: false, error: 'Accès Admin révoqué ou inexistant.' });
    return false;
  }

  const delegation = delRes.rows[0];
  const perms = delegation.granular_permissions || {};
  const modulePerms = perms[moduleId] || [];

  if (!modulePerms.includes(permission)) {
    res.status(403).json({ success: false, error: `Permission insuffisante : ${permission} dans ${moduleId}` });
    return false;
  }

  // If requires approval, don't execute, but submit
  if (delegation.requires_approval) {
    await query(
      `INSERT INTO public.admin_pending_actions (requested_by, action_type, target_id, target_name, details, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [userId, actionData.type, actionData.targetId || null, actionData.targetName || 'N/A', JSON.stringify(actionData.details || {})]
    );

    await logAudit(userId, 'REQUEST_APPROVAL', actionData.type, actionData.targetId, actionData.details);

    res.json({ success: true, pendingApproval: true, message: 'Cette action sensible a été mise en attente pour approbation par l\'Administrateur Principal.' });
    return false;
  }

  // Execute directly, but log it
  await logAudit(userId, actionData.type, moduleId, actionData.targetId, actionData.details);
  return true;
};

/**
 * @desc    Obtenir les statistiques globales
 */
const getStats = asyncHandler(async (req, res) => {
  await ensureAdminTables();
  const usersCount = await query('SELECT COUNT(*) FROM public.profiles WHERE is_global_admin = FALSE');
  const messagesCount = await query('SELECT COUNT(*) FROM public.messages');
  const chatsCount = await query('SELECT COUNT(*) FROM public.chats WHERE type = \'group\'');
  const onlineCount = await query("SELECT COUNT(*) FROM public.profiles WHERE status = 'online' AND is_global_admin = FALSE");

  // Nouvelles statistiques indépendantes demandées sans impacter l'existant
  const jobsCount = await query('SELECT COUNT(*) FROM public.job_postings');
  const marketCount = await query('SELECT COUNT(*) FROM public.market_posts');

  res.json({
    success: true,
    data: {
      totalUsers: parseInt(usersCount.rows[0].count),
      totalMessages: parseInt(messagesCount.rows[0].count),
      totalGroups: parseInt(chatsCount.rows[0].count),
      onlineUsers: parseInt(onlineCount.rows[0].count),
      totalJobs: parseInt(jobsCount.rows[0].count || 0),
      totalMarket: parseInt(marketCount.rows[0].count || 0),
    },
  });
});

const ensureAdminTables = async () => {
  // SÉCURITÉ : Forcer les colonnes critiques si elles manquent
  try {
    await query('ALTER TABLE public.web_portfolio_requests ADD COLUMN IF NOT EXISTS logo_url TEXT');
    await query('ALTER TABLE public.web_portfolio_requests ADD COLUMN IF NOT EXISTS enabled_modules TEXT[] DEFAULT \'{"home", "about", "contact"}\'');
    logger.info('🚀 Migration SaaS for web_portfolio_requests check done.');
  } catch (e) {
    // Si la table n'existe pas encore, on ignore cette erreur car le CREATE TABLE plus bas s'en chargera
  }

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
    await query(`INSERT INTO public.app_configs (current_version, force_update, active) VALUES ('93.0.0', false, true)`);
  }

  // S'assurer que les documents légaux existent avec la version 93.0.0
  const existingLegalDocs = await query('SELECT type, version FROM public.app_legal_docs');

  if (existingLegalDocs.rows.length === 0) {
    // Initialiser avec des documents légaux par défaut pour la version 93.0.0
    await query(`INSERT INTO public.app_legal_docs (type, content, version, force_acceptance) VALUES 
      ('tos', 'Conditions Générales d''Utilisation - Version 93.0.0', '93.0.0', false),
      ('privacy', 'Politique de Confidentialité - Version 93.0.0', '93.0.0', false)`);
  } else {
    // Si les documents existent mais sont en version ancienne, on les met à jour en version 93.0.0
    await query(`
      UPDATE public.app_legal_docs
      SET version = '93.0.0',
          content = CASE
            WHEN type = 'tos' THEN 'Conditions Générales d''Utilisation - Version 93.0.0'
            ELSE 'Politique de Confidentialité - Version 93.0.0'
          END,
          force_acceptance = false
      WHERE version IN ('5.0.0', '1.0.0', '31.0.0', '32.0.0', '33.0.0', '34.0.0', '35.0.0', '36.0.0', '37.0.0', '38.0.0', '39.0.0', '40.0.0', '41.0.0', '42.0.0', '43.0.0', '44.0.0', '45.0.0', '46.0.0', '47.0.0', '48.0.0', '49.0.0', '50.0.0', '89.0.0', '90.0.0', '91.0.0', '92.0.0', '95.0.0')
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
      // On ne réinitialise PAS le mot de passe s'il existe déjà
      // On s'assure juste que les droits et le déblocage sont corrects
      await query(
        'UPDATE public.profiles SET is_global_admin = TRUE, is_locked = FALSE, login_attempts = 0 WHERE id = $1',
        [admin.id]
      );
      logger.info('✅ Compte Admin synchronisé et débloqué (Mot de passe préservé).');
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
  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone_number TEXT');
  await query("ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS device_info JSONB DEFAULT '{}'::jsonb");
  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS gender TEXT');
  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS country TEXT');
  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS province TEXT');
  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS city TEXT');
  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS commune TEXT');
  await query('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS birth_date DATE');

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
      granular_permissions JSONB DEFAULT '{}',
      requires_approval BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);

  try { await query('ALTER TABLE public.admin_delegations ADD COLUMN IF NOT EXISTS user_admin_rights JSONB DEFAULT \'{}\''); } catch (e) {}
  try { await query('ALTER TABLE public.admin_delegations ADD COLUMN IF NOT EXISTS collab_admin_rights JSONB DEFAULT \'{}\''); } catch (e) {}
  try { await query('ALTER TABLE public.admin_delegations ADD COLUMN IF NOT EXISTS granular_permissions JSONB DEFAULT \'{}\''); } catch (e) {}
  try { await query('ALTER TABLE public.admin_delegations ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN DEFAULT TRUE'); } catch (e) {}

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
    await query('ALTER TABLE public.market_businesses ADD COLUMN IF NOT EXISTS rejection_reason TEXT');
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

  // Modération : S'assurer que les colonnes de boost existent
  try {
    await query('ALTER TABLE public.statuses ADD COLUMN IF NOT EXISTS is_boosted BOOLEAN DEFAULT FALSE');
    await query('ALTER TABLE public.market_posts ADD COLUMN IF NOT EXISTS is_boosted BOOLEAN DEFAULT FALSE');
    await query('ALTER TABLE public.job_postings ADD COLUMN IF NOT EXISTS is_boosted BOOLEAN DEFAULT FALSE');
  } catch (e) {
    logger.error('Error adding is_boosted columns:', e.message);
  }

  // Statuses and social tables initialization
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS public.statuses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
        content TEXT,
        type TEXT DEFAULT 'text',
        media_url TEXT,
        background_color TEXT DEFAULT '#128C7E',
        is_boosted BOOLEAN DEFAULT FALSE,
        expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '24 hours'),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS public.status_views (
        status_id UUID REFERENCES public.statuses(id) ON DELETE CASCADE,
        user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
        viewed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        PRIMARY KEY (status_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS public.status_reactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        status_id UUID REFERENCES public.statuses(id) ON DELETE CASCADE,
        user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
  } catch (e) {
    logger.error('Error ensuring social tables:', e.message);
  }

  // Final robust schema synchronization for Admin Modules
  try {
    // Moderation & Boost
    await query('ALTER TABLE public.statuses ADD COLUMN IF NOT EXISTS is_boosted BOOLEAN DEFAULT FALSE');
    await query('ALTER TABLE public.market_posts ADD COLUMN IF NOT EXISTS is_boosted BOOLEAN DEFAULT FALSE');
    await query('ALTER TABLE public.job_postings ADD COLUMN IF NOT EXISTS is_boosted BOOLEAN DEFAULT FALSE');

    // Employer Profiles consistency
    await query('ALTER TABLE public.employer_profiles ADD COLUMN IF NOT EXISTS company_name TEXT');
    await query('ALTER TABLE public.employer_profiles ADD COLUMN IF NOT EXISTS logo_url TEXT');

    // Market Businesses consistency
    await query('ALTER TABLE public.market_businesses ADD COLUMN IF NOT EXISTS business_name TEXT');
    await query('ALTER TABLE public.market_businesses ADD COLUMN IF NOT EXISTS logo_url TEXT');

    // Portfolio Management Tables Consistency (Ensuring tables exist first)
    await query(`
      CREATE TABLE IF NOT EXISTS public.web_portfolio_skills (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        level INTEGER DEFAULT 50,
        icon TEXT,
        image_url TEXT,
        category TEXT DEFAULT 'technical',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS public.web_portfolio_experiences (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        company TEXT NOT NULL,
        period TEXT,
        description TEXT,
        logo_url TEXT,
        order_index INTEGER DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS public.web_portfolio_services (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        description TEXT,
        price_range TEXT,
        icon TEXT,
        image_url TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS public.web_portfolio_quotes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_name TEXT NOT NULL,
        client_email TEXT NOT NULL,
        project_description TEXT,
        budget TEXT,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'contacted', 'accepted', 'rejected')),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS public.web_portfolio_team (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        bio TEXT,
        image_url TEXT,
        order_index INTEGER DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS public.web_portfolio_profile (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        logo_url TEXT,
        about_photo_url TEXT,
        about_description TEXT,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      -- Insérer une ligne par défaut si elle n'existe pas
      INSERT INTO public.web_portfolio_profile (about_description)
      SELECT 'Bienvenue chez Together Tech. Nous sommes une communauté de passionnés...'
      WHERE NOT EXISTS (SELECT 1 FROM public.web_portfolio_profile);
    `);

    // Ensure all columns exist for existing tables
    await query('ALTER TABLE public.web_portfolio_skills ADD COLUMN IF NOT EXISTS image_url TEXT');
    await query('ALTER TABLE public.web_portfolio_skills ADD COLUMN IF NOT EXISTS category TEXT DEFAULT \'technical\'');
    await query('ALTER TABLE public.web_portfolio_skills ADD COLUMN IF NOT EXISTS description TEXT');
    await query('ALTER TABLE public.web_portfolio_skills ADD COLUMN IF NOT EXISTS years_experience INTEGER DEFAULT 1');

    await query(`
      CREATE TABLE IF NOT EXISTS public.web_portfolio_blog_posts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        portfolio_id UUID REFERENCES public.web_portfolios(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        content TEXT,
        theme TEXT DEFAULT 'futuristic',
        image_url TEXT,
        is_external BOOLEAN DEFAULT FALSE,
        external_url TEXT,
        cta_text TEXT,
        cta_url TEXT,
        status TEXT DEFAULT 'published',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(portfolio_id, slug)
      );

    `);

    // Gérer l'isolation des requêtes ALTER de manière sécurisée hors de la chaîne principale de chaînage SQL natif pour éviter les crashs de schéma
    try {
      await query('CREATE TABLE IF NOT EXISTS public.web_portfolio_blog_likes (post_id UUID REFERENCES public.web_portfolio_blog_posts(id) ON DELETE CASCADE, user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE)');
    } catch(e) {}
    try {
      await query('ALTER TABLE public.web_portfolio_blog_likes DROP CONSTRAINT IF EXISTS web_portfolio_blog_likes_pkey');
    } catch(e) {}
    try {
      await query('ALTER TABLE public.web_portfolio_blog_likes ADD COLUMN IF NOT EXISTS visitor_id TEXT');
    } catch(e) {}
    try {
      await query('ALTER TABLE public.web_portfolio_blog_likes ALTER COLUMN user_id DROP NOT NULL');
    } catch(e) {}
    try {
      await query('ALTER TABLE public.web_portfolio_blog_likes DROP CONSTRAINT IF EXISTS web_portfolio_blog_likes_unique');
    } catch(e) {}
    try {
      await query('ALTER TABLE public.web_portfolio_blog_likes ADD CONSTRAINT web_portfolio_blog_likes_unique UNIQUE (post_id, user_id, visitor_id)');
    } catch(e) {}

    await query(`
      CREATE TABLE IF NOT EXISTS public.web_portfolio_blog_comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id UUID REFERENCES public.web_portfolio_blog_posts(id) ON DELETE CASCADE,
        author_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
        parent_id UUID REFERENCES public.web_portfolio_blog_comments(id) ON DELETE CASCADE,
        author_name TEXT,
        content TEXT NOT NULL,
        image_url TEXT,
        sticker_url TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      ALTER TABLE public.web_portfolio_blog_comments ADD COLUMN IF NOT EXISTS image_url TEXT;
      ALTER TABLE public.web_portfolio_blog_comments ADD COLUMN IF NOT EXISTS sticker_url TEXT;
    `);

    // Table pour les codes de suivi temporaires
    await query(`
      CREATE TABLE IF NOT EXISTS public.web_portfolio_tracking_codes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL,
        code TEXT NOT NULL,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_tracking_codes_email ON public.web_portfolio_tracking_codes(email);
    `);

    await query('ALTER TABLE public.web_portfolio_experiences ADD COLUMN IF NOT EXISTS logo_url TEXT');
    await query('ALTER TABLE public.web_portfolio_experiences ADD COLUMN IF NOT EXISTS project_url TEXT');
    await query('ALTER TABLE public.web_portfolio_experiences ADD COLUMN IF NOT EXISTS is_in_progress BOOLEAN DEFAULT FALSE');
    await query('ALTER TABLE public.web_portfolio_experiences ADD COLUMN IF NOT EXISTS project_status TEXT DEFAULT \'published\'');
    await query('ALTER TABLE public.web_portfolio_experiences ADD COLUMN IF NOT EXISTS downloads_count TEXT DEFAULT \'0\'');
    await query('ALTER TABLE public.web_portfolio_experiences ADD COLUMN IF NOT EXISTS stars_count TEXT DEFAULT \'5.0\'');
    await query('ALTER TABLE public.web_portfolio_services ADD COLUMN IF NOT EXISTS image_url TEXT');
    await query('ALTER TABLE public.web_portfolio_quotes ADD COLUMN IF NOT EXISTS specifications TEXT');
    await query('ALTER TABLE public.web_portfolio_quotes ADD COLUMN IF NOT EXISTS admin_reply_message TEXT');
    await query('ALTER TABLE public.web_portfolio_quotes ADD COLUMN IF NOT EXISTS final_price TEXT');
    await query('ALTER TABLE public.web_portfolio_quotes ADD COLUMN IF NOT EXISTS estimated_duration TEXT');
    await query('ALTER TABLE public.web_portfolio_quotes ADD COLUMN IF NOT EXISTS contract_content TEXT');
    await query('ALTER TABLE public.web_portfolio_quotes ADD COLUMN IF NOT EXISTS contract_signature_data TEXT');
    await query('ALTER TABLE public.web_portfolio_quotes ADD COLUMN IF NOT EXISTS contract_signed_at TIMESTAMP WITH TIME ZONE');
    await query('ALTER TABLE public.web_portfolio_quotes ADD COLUMN IF NOT EXISTS is_contract_archived BOOLEAN DEFAULT FALSE');
    await query('ALTER TABLE public.web_portfolio_quotes ADD COLUMN IF NOT EXISTS is_specs_archived BOOLEAN DEFAULT FALSE');

    // Footer & Links for Portfolio
    await query('ALTER TABLE public.web_portfolio_profile ADD COLUMN IF NOT EXISTS footer_policy TEXT');
    await query('ALTER TABLE public.web_portfolio_profile ADD COLUMN IF NOT EXISTS footer_conditions TEXT');
    await query('ALTER TABLE public.web_portfolio_profile ADD COLUMN IF NOT EXISTS footer_blog TEXT');
    await query('ALTER TABLE public.web_portfolio_profile ADD COLUMN IF NOT EXISTS footer_community TEXT');
    await query('ALTER TABLE public.web_portfolio_profile ADD COLUMN IF NOT EXISTS footer_contact TEXT');
    await query('ALTER TABLE public.web_portfolio_profile ADD COLUMN IF NOT EXISTS background_url TEXT');
    await query('ALTER TABLE public.web_portfolio_profile ADD COLUMN IF NOT EXISTS background_animation TEXT DEFAULT \'none\'');
    await query('ALTER TABLE public.web_portfolio_profile ADD COLUMN IF NOT EXISTS hero_image_url TEXT');
    await query('ALTER TABLE public.web_portfolio_profile ADD COLUMN IF NOT EXISTS social_facebook TEXT');
    await query('ALTER TABLE public.web_portfolio_profile ADD COLUMN IF NOT EXISTS social_github TEXT');
    await query('ALTER TABLE public.web_portfolio_profile ADD COLUMN IF NOT EXISTS social_whatsapp TEXT');
    await query('ALTER TABLE public.web_portfolio_profile ADD COLUMN IF NOT EXISTS social_instagram TEXT');
    await query('ALTER TABLE public.web_portfolio_profile ADD COLUMN IF NOT EXISTS social_twitter TEXT');

    await query('ALTER TABLE public.web_portfolio_profile ADD COLUMN IF NOT EXISTS social_facebook_icon TEXT');
    await query('ALTER TABLE public.web_portfolio_profile ADD COLUMN IF NOT EXISTS social_github_icon TEXT');
    await query('ALTER TABLE public.web_portfolio_profile ADD COLUMN IF NOT EXISTS social_whatsapp_icon TEXT');
    await query('ALTER TABLE public.web_portfolio_profile ADD COLUMN IF NOT EXISTS social_instagram_icon TEXT');
    await query('ALTER TABLE public.web_portfolio_profile ADD COLUMN IF NOT EXISTS social_twitter_icon TEXT');

    // Portfolio Pages (Policy, Terms, etc.)
    await query(`
      CREATE TABLE IF NOT EXISTS public.web_portfolio_pages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // Ensure composite unique constraint for multi-tenancy
    try {
      await query('ALTER TABLE public.web_portfolio_pages DROP CONSTRAINT IF EXISTS web_portfolio_pages_slug_key');
      await query('ALTER TABLE public.web_portfolio_pages ADD CONSTRAINT web_portfolio_pages_slug_portfolio_id_key UNIQUE (slug, portfolio_id)');
    } catch (e) { /* Already applied or table empty */ }

    await query(`
      INSERT INTO public.web_portfolio_pages (slug, title, content, portfolio_id)
      VALUES
        ('policy', 'Politique de Confidentialité', '<h1>Politique de Confidentialité</h1><p>Contenu à rédiger...</p>', '00000000-0000-0000-0000-000000000000'),
        ('terms', 'Conditions d''Utilisation', '<h1>Conditions d''Utilisation</h1><p>Contenu à rédiger...</p>', '00000000-0000-0000-0000-000000000000')
      ON CONFLICT (slug, portfolio_id) DO NOTHING;
    `);

    // Community Enhancements: Pinned Messages, Audio, Documents
    await query('ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE');
    await query('ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS type TEXT DEFAULT \'text\'');
    await query('ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS file_url TEXT');
    await query('ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS file_name TEXT');

    // Campaign Enhancements
    await query('ALTER TABLE public.notification_campaigns ADD COLUMN IF NOT EXISTS file_url TEXT');
    await query('ALTER TABLE public.notification_campaigns ADD COLUMN IF NOT EXISTS file_name TEXT');

    // Sports & Announcements
    await query(`
      CREATE TABLE IF NOT EXISTS public.live_sports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_name TEXT NOT NULL,
        status TEXT DEFAULT 'live',
        score_a INTEGER DEFAULT 0,
        score_b INTEGER DEFAULT 0,
        team_a TEXT NOT NULL,
        team_b TEXT NOT NULL,
        minute TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS public.web_portfolio_announcements (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        priority TEXT DEFAULT 'normal',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- Initial Demo Data for Community
      INSERT INTO public.live_sports (event_name, team_a, team_b, score_a, score_b, minute)
      SELECT 'Champions League', 'Real Madrid', 'Man City', 2, 1, '75'
      WHERE NOT EXISTS (SELECT 1 FROM public.live_sports);

      INSERT INTO public.web_portfolio_announcements (title, content, priority)
      SELECT 'Nouvelle Version Mobile', 'La v93 est maintenant disponible sur le store !', 'high'
      WHERE NOT EXISTS (SELECT 1 FROM public.web_portfolio_announcements);
    `);

    // --- MULTI-TENANT PORTFOLIO SYSTEM (Phase 1) ---
    await query(`
      CREATE TABLE IF NOT EXISTS public.web_portfolios (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
        slug TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        owner_name TEXT NOT NULL,
        description TEXT,
        theme_color TEXT DEFAULT '#06b6d4',
        logo_url TEXT,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'blocked')),
        enabled_modules TEXT[] DEFAULT '{"home", "about", "skills", "services", "contact"}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- Ensure Master Portfolio (Together Tech) exists
      INSERT INTO public.web_portfolios (id, user_id, slug, title, owner_name, status, enabled_modules)
      SELECT '00000000-0000-0000-0000-000000000000', id, 'together', 'Together Tech', 'Main Admin', 'approved', '{"home", "about", "team", "skills", "experience", "services", "community", "contact"}'
      FROM public.profiles WHERE email = 'wecanconcept@gmail.com'
      ON CONFLICT (id) DO NOTHING;
    `);

    // Add portfolio_id to all related tables
    const portfolioTables = [
      'web_portfolio_skills', 'web_portfolio_experiences', 'web_portfolio_services',
      'web_portfolio_quotes', 'web_portfolio_profile', 'web_portfolio_team',
      'web_portfolio_messages', 'web_portfolio_pages', 'web_portfolio_announcements',
      'web_portfolio_blog_posts'
    ];

    for (const table of portfolioTables) {
      await query(`ALTER TABLE public.${table} ADD COLUMN IF NOT EXISTS portfolio_id UUID REFERENCES public.web_portfolios(id) DEFAULT '00000000-0000-0000-0000-000000000000'`);
      // Force update all to master ID to fix visibility issues
      await query(`UPDATE public.${table} SET portfolio_id = '00000000-0000-0000-0000-000000000000'`);
    }

    // Create Table for Portfolio Requests
    await query(`
      CREATE TABLE IF NOT EXISTS public.web_portfolio_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
        full_name TEXT NOT NULL,
        email TEXT NOT NULL,
        profession TEXT NOT NULL,
        desired_slug TEXT UNIQUE NOT NULL,
        preferred_color TEXT DEFAULT '#06b6d4',
        logo_url TEXT,
        motivation TEXT,
        enabled_modules TEXT[] DEFAULT '{"home", "about", "contact"}',
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // --- COMMUNITY SOCIAL SYSTEM ---
    await query(`
      CREATE TABLE IF NOT EXISTS public.community_posts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        portfolio_id UUID REFERENCES public.web_portfolios(id) ON DELETE CASCADE,
        author_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
        author_name TEXT,
        content TEXT NOT NULL,
        image_url TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS public.community_post_likes (
        post_id UUID REFERENCES public.community_posts(id) ON DELETE CASCADE,
        user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
        PRIMARY KEY (post_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS public.community_post_comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id UUID REFERENCES public.community_posts(id) ON DELETE CASCADE,
        author_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
        author_name TEXT,
        content TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS public.community_subscriptions (
        subscriber_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
        target_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
        PRIMARY KEY (subscriber_id, target_id)
      );
    `);

    // Ensure columns exist if table was already created
    try {
      await query('ALTER TABLE public.web_portfolio_requests ADD COLUMN IF NOT EXISTS logo_url TEXT');
      await query('ALTER TABLE public.web_portfolio_requests ADD COLUMN IF NOT EXISTS enabled_modules TEXT[] DEFAULT \'{"home", "about", "contact"}\'');
    } catch (e) {
      logger.warn('Migration for web_portfolio_requests skipped: ' + e.message);
    }

    // Create Chat Message table for Portfolio
    await query(`
      CREATE TABLE IF NOT EXISTS public.web_portfolio_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        quote_id UUID REFERENCES public.web_portfolio_quotes(id) ON DELETE CASCADE,
        sender_type TEXT NOT NULL CHECK (sender_type IN ('admin', 'client')),
        content TEXT NOT NULL,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    logger.info('✅ Admin Schema Synchronized (Portfolio Full Consistency)');
  } catch (err) {
    logger.error('❌ Schema Migration Error:', err.message);
    logger.warn('⚠️ Some schema migrations were skipped or failed.');
  }
};

const ensureScheduledUserDeletionsTable = async () => {
  await query(`
    CREATE TABLE IF NOT EXISTS public.admin_scheduled_user_deletions (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL,
      user_name TEXT,
      scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'processing', 'deleted', 'cancelled', 'failed')),
      requested_by UUID,
      last_error TEXT,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS admin_scheduled_user_deletions_active_user_idx
    ON public.admin_scheduled_user_deletions (user_id)
    WHERE status IN ('scheduled', 'processing')
  `);
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
  await ensureScheduledUserDeletionsTable();
  // Security check: only global admin or authorized delegate can see users
  const hasViewPerm = req.user.is_global_admin || (req.user.granular_permissions && req.user.granular_permissions.users && req.user.granular_permissions.users.includes('view'));

  if (!hasViewPerm) {
    return res.status(403).json({ success: false, error: 'Accès refusé : Vous n\'avez pas le droit de voir la liste des utilisateurs.' });
  }

  // We hide Global Admins from the management lists (User List & Directory)
  const result = await query(`
    SELECT p.id, p.email, p.full_name, p.username, p.avatar_url, p.status, p.status_updated_at, p.phone_number, p.is_locked,
           p.login_attempts, p.created_at, p.is_global_admin, p.last_login_at, p.device_info, p.is_verified,
           p.gender, p.country, p.province, p.city, p.commune, p.birth_date,
           scheduled_deletion.scheduled_at AS deletion_scheduled_at,
           scheduled_deletion.status AS deletion_schedule_status
    FROM public.profiles p
    LEFT JOIN LATERAL (
      SELECT scheduled_at, status
      FROM public.admin_scheduled_user_deletions
      WHERE user_id = p.id AND status <> 'cancelled'
      ORDER BY created_at DESC
      LIMIT 1
    ) scheduled_deletion ON TRUE
    WHERE p.is_global_admin = FALSE
    ORDER BY p.status = 'online' DESC, p.status_updated_at DESC NULLS LAST
  `);

  res.json({ success: true, data: result.rows });
});

const getReports = asyncHandler(async (req, res) => {
  await ensureAdminTables();

  const hasReadPerm = req.user.is_global_admin || (req.user.granular_permissions && req.user.granular_permissions.support && req.user.granular_permissions.support.includes('read'));
  if (!hasReadPerm) {
    return res.status(403).json({ success: false, error: 'Accès refusé : Vous n\'avez pas le droit de voir les signalements.' });
  }

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

  const canExecute = await processSensitiveAction(req, 'resolve_report', id, 'Report', { status: status || 'resolved' }, 'reports', 'resolve');
  if (!canExecute) return res.json({ success: true, pending: true, message: 'Demande de résolution de signalement mise en attente.' });

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
const processSensitiveAction = async (req, actionType, targetId, targetName, details = {}, moduleId = null, permission = null) => {
  await ensureAdminTables();
  if (req.user.is_global_admin) {
      await logAudit(req.userId, actionType, moduleId || 'global', targetId, details);
      return true; // Principal admin bypasses everything
  }

  // 1. Check Granular Permission first
  const delRes = await query('SELECT granular_permissions, requires_approval FROM public.admin_delegations WHERE user_id = $1 AND is_active = TRUE', [req.userId]);
  if (delRes.rows.length === 0) return false; // Revoked

  const delegation = delRes.rows[0];
  if (moduleId && permission) {
      const perms = delegation.granular_permissions || {};
      const modulePerms = perms[moduleId] || [];
      if (!modulePerms.includes(permission)) return false; // Forbidden
  }

  // 2. If approval is required, create a request
  if (delegation.requires_approval) {
      await query(
        `INSERT INTO public.admin_pending_actions (requested_by, action_type, target_id, target_name, details, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
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
      return false; // Deferred
  }

  // 3. Approval NOT required, execute directly and log
  await logAudit(req.userId, actionType, moduleId || 'global', targetId, details);
  return true;
};

/**
 * @desc    Lister les actions en attente d'approbation
 */
const getPendingActions = asyncHandler(async (req, res) => {
  if (!req.user.is_global_admin && !req.user.allowed_modules.includes('approvals')) {
    return res.status(403).json({ success: false, error: 'Accès réservé' });
  }

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

  // SÉCURITÉ : Seul l'admin principal ou délégué avec module 'approvals' peut approuver/rejeter/renvoyer
  if (decision !== 'pending' && !req.user.is_global_admin && !req.user.allowed_modules.includes('approvals')) {
    return res.status(403).json({ success: false, error: 'Accès réservé' });
  }

  // SÉCURITÉ : Un délégué peut seulement resoumettre SA PROPRE demande
  if (decision === 'pending' && action.requested_by !== req.userId) {
    return res.status(403).json({ success: false, error: 'Vous ne pouvez resoumettre que vos propres demandes' });
  }

  if (decision === 'approved') {
    try {
      switch (action.action_type) {
        case 'delete_user':
          await query('DELETE FROM public.messages WHERE sender_id = $1', [action.target_id]);
          await query('DELETE FROM public.chat_participants WHERE user_id = $1', [action.target_id]);
          await query('UPDATE public.chats SET created_by = NULL WHERE created_by = $1', [action.target_id]);
          await query('DELETE FROM public.profiles WHERE id = $1', [action.target_id]);
          break;
        case 'schedule_delete_user': {
          const scheduledAt = new Date(action.details.scheduledAt);
          if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
            throw new Error('La date programmée est passée. Demandez une nouvelle planification.');
          }
          await saveScheduledUserDeletion(action.target_id, action.requested_by, scheduledAt.toISOString());
          break;
        }
        case 'cancel_scheduled_delete':
          await query(
            `UPDATE public.admin_scheduled_user_deletions
             SET status = 'cancelled', updated_at = NOW()
             WHERE id = $1 AND status = 'scheduled'`,
            [action.details.scheduleId]
          );
          break;
        case 'send_security_notice': {
          const targetUser = await query(
            'SELECT email, full_name FROM public.profiles WHERE id = $1 AND is_global_admin = FALSE',
            [action.target_id]
          );
          if (!targetUser.rows[0]) throw new Error('Utilisateur non trouvé');
          const sent = await mailService.sendSecurityNoticeEmail(
            targetUser.rows[0].email,
            targetUser.rows[0].full_name,
            action.details.message
          );
          if (!sent) throw new Error('L’e-mail de sécurité n’a pas pu être envoyé.');
          break;
        }
        case 'toggle_user_lock':
          await query('UPDATE public.profiles SET is_locked = $1, login_attempts = $2 WHERE id = $3', [action.details.isLocked, action.details.isLocked ? 3 : 0, action.target_id]);
          break;
        case 'toggle_user_badge':
          await query('UPDATE public.profiles SET is_verified = $1 WHERE id = $2', [action.details.isVerified, action.target_id]);
          socketService.broadcast('admin:user_verification_updated', { userId: action.target_id, isVerified: action.details.isVerified });
          break;
        case 'reset_password':
          const tPass = crypto.randomBytes(4).toString('hex').toUpperCase();
          const hPassReset = await bcrypt.hash(tPass, 10);
          await query('UPDATE public.profiles SET password = $1, must_change_password = TRUE WHERE id = $2', [hPassReset, action.target_id]);
          // On récupère le mail de la cible
          const targetU = await query('SELECT email, full_name FROM public.profiles WHERE id = $1', [action.target_id]);
          if (targetU.rows.length > 0) {
              await mailService.sendPasswordResetEmail(targetU.rows[0].email, targetU.rows[0].full_name, tPass);
          }
          break;
        case 'delete_group':
          await query('DELETE FROM public.chats WHERE id = $1', [action.target_id]);
          socketService.broadcast('group_deleted', { chatId: action.target_id });
          break;
        case 'toggle_group_ban':
          await query('UPDATE public.chats SET is_banned = $1 WHERE id = $2', [action.details.isBanned, action.target_id]);
          socketService.broadcast('group_status_changed', { chatId: action.target_id, isBanned: action.details.isBanned });
          break;
        case 'delete_portfolio':
          await query('DELETE FROM public.web_portfolio_profile WHERE portfolio_id = $1', [action.target_id]);
          await query('DELETE FROM public.web_portfolio_skills WHERE portfolio_id = $1', [action.target_id]);
          await query('DELETE FROM public.web_portfolio_experiences WHERE portfolio_id = $1', [action.target_id]);
          await query('DELETE FROM public.web_portfolio_services WHERE portfolio_id = $1', [action.target_id]);
          await query('DELETE FROM public.web_portfolio_team WHERE portfolio_id = $1', [action.target_id]);
          await query('DELETE FROM public.web_portfolio_pages WHERE portfolio_id = $1', [action.target_id]);
          await query('DELETE FROM public.web_portfolio_quotes WHERE portfolio_id = $1', [action.target_id]);
          await query('DELETE FROM public.web_portfolios WHERE id = $1', [action.target_id]);
          break;
        case 'toggle_portfolio_status':
          await query('UPDATE public.web_portfolios SET status = $1, updated_at = NOW() WHERE id = $2', [action.details.status, action.target_id]);
          break;
        case 'delete_team':
          await query('DELETE FROM public.collab_teams WHERE id = $1', [action.target_id]);
          break;
        case 'delete_market':
          await query('DELETE FROM public.market_businesses WHERE id = $1', [action.target_id]);
          break;
        case 'toggle_market_block':
          await query('UPDATE public.market_businesses SET status = $1 WHERE id = $2', [action.details.status, action.target_id]);
          break;
        case 'handle_market':
          // Re-trigger actual handle function logic
          const { status, admin_notes } = action.details;
          await query('UPDATE public.market_businesses SET status = $1, rejection_reason = $2, verified_at = CASE WHEN $1 = \'approved\' THEN NOW() ELSE NULL END WHERE id = $3', [status, admin_notes, action.target_id]);
          break;
        case 'resolve_report':
          await query('UPDATE public.reported_content SET status = $1, resolved_at = NOW() WHERE id = $2', [action.details.status, action.target_id]);
          break;
        case 'reply_appeal':
          await query('UPDATE public.appeals SET admin_reply = $1, status = $2, resolved_at = NOW() WHERE id = $3', [action.details.reply, action.details.action === 'resolved' ? 'resolved' : 'reviewed', action.target_id]);
          break;
        case 'handle_employer':
          const { status: empStatus } = action.details;
          await query("UPDATE public.employer_requests SET status = $1, updated_at = NOW() WHERE id = $2", [empStatus, action.target_id]);
          if (empStatus === 'approved') {
              await query(`INSERT INTO public.employer_profiles (user_id, request_id, company_name, company_email, industry)
                           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id) DO UPDATE SET is_active = true`,
                           [action.details.userId, action.target_id, action.target_name, action.details.email, action.details.industry]);
          }
          break;
        case 'delete_collaborator':
          await query('UPDATE public.profiles SET collab_deleted_at = NOW(), is_collaborator = FALSE WHERE id = $1', [action.target_id]);
          await query('UPDATE public.admin_delegations SET is_active = FALSE WHERE user_id = $1', [action.target_id]);
          break;
        case 'collab_application':
          let applyTeamId = action.details.teamId;
          if (!applyTeamId || applyTeamId === 'null') {
            const defTeam = await query("SELECT id FROM public.collab_teams WHERE name = 'Together Tech Community' LIMIT 1");
            applyTeamId = defTeam.rows[0]?.id;
            if (!applyTeamId) {
              const firstTeam = await query("SELECT id FROM public.collab_teams ORDER BY created_at ASC LIMIT 1");
              applyTeamId = firstTeam.rows[0]?.id;
            }
          }
          if (!applyTeamId) throw new Error("Aucune équipe disponible.");
          await query(
            'INSERT INTO public.collab_requests (user_id, team_id, motivation, objectives, skills, status, processed_at, processed_by) VALUES ($1, $2, $3, $4, $5, \'approved\', NOW(), $6)',
            [action.requested_by, applyTeamId, action.details.motivation, action.details.objectives, action.details.skills, req.userId]
          );
          await query('INSERT INTO public.collab_team_members (team_id, user_id, role) VALUES ($1, $2, \'collaborator\') ON CONFLICT DO NOTHING', [applyTeamId, action.requested_by]);
          const existingCollabDel = await query('SELECT modules FROM public.admin_delegations WHERE user_id = $1', [action.requested_by]);
          if (existingCollabDel.rows.length === 0) {
            await query('INSERT INTO public.admin_delegations (user_id, modules, is_active) VALUES ($1, $2, TRUE)', [action.requested_by, ['collaboration']]);
          } else {
            await query("UPDATE public.admin_delegations SET modules = CASE WHEN NOT ('collaboration' = ANY(modules)) THEN array_append(modules, 'collaboration') ELSE modules END, is_active = TRUE, updated_at = NOW() WHERE user_id = $1", [action.requested_by]);
          }
          await query('UPDATE public.profiles SET is_collaborator = TRUE WHERE id = $1', [action.requested_by]);
          socketService.emitToUser(action.requested_by, 'collab:request_processed', { status: 'approved', comment: comment || 'Bienvenue !' });
          break;
        case 'add_member':
          await mailService.sendCollabInvitationEmail(action.details.email || '', action.target_name, action.details.teamName, action.details.teamId);
          await query('INSERT INTO public.collab_team_members (team_id, user_id, role) VALUES ($1, $2, \'collaborator\') ON CONFLICT DO NOTHING', [action.details.teamId, action.target_id]);
          const addDel = await query('SELECT modules FROM public.admin_delegations WHERE user_id = $1', [action.target_id]);
          if (addDel.rows.length === 0) {
            await query('INSERT INTO public.admin_delegations (user_id, modules, is_active) VALUES ($1, $2, TRUE)', [action.target_id, ['collaboration']]);
          } else if (!addDel.rows[0].modules.includes('collaboration')) {
            await query('UPDATE public.admin_delegations SET modules = array_append(modules, \'collaboration\'), is_active = TRUE WHERE user_id = $1', [action.target_id]);
          }
          socketService.broadcast('collab:member_moved', { userId: action.target_id, toTeamId: action.details.teamId });
          break;
        case 'move_member':
          await query('DELETE FROM public.collab_team_members WHERE user_id = $1', [action.target_id]);
          if (action.details.toTeamId && action.details.toTeamId !== 'null') {
            await query('INSERT INTO public.collab_team_members (team_id, user_id, role) VALUES ($1, $2, \'collaborator\') ON CONFLICT DO NOTHING', [action.details.toTeamId, action.target_id]);
            const moveDel = await query('SELECT modules FROM public.admin_delegations WHERE user_id = $1', [action.target_id]);
            if (moveDel.rows.length === 0) {
              await query('INSERT INTO public.admin_delegations (user_id, modules, is_active) VALUES ($1, $2, TRUE)', [action.target_id, ['collaboration']]);
            } else if (!moveDel.rows[0].modules.includes('collaboration')) {
              await query('UPDATE public.admin_delegations SET modules = array_append(modules, \'collaboration\'), is_active = TRUE WHERE user_id = $1', [action.target_id]);
            }
          }
          socketService.broadcast('collab:member_moved', { userId: action.target_id, fromTeamId: action.details.fromTeamId, toTeamId: action.details.toTeamId });
          break;
        case 'delete_campaign':
          await query('DELETE FROM public.notification_campaigns WHERE id = $1', [action.target_id]);
          break;
        case 'delete_config':
          await query('DELETE FROM public.app_configs WHERE id = $1', [action.target_id]);
          break;
        case 'delete_legal':
          await query('DELETE FROM public.app_legal_docs WHERE type = $1', [action.target_id]);
          break;
        case 'create_campaign':
        case 'broadcast_message':
          const isBroadcast = action.action_type === 'broadcast_message';
          const { title, message: msgText, content: bcContent, target: bcTarget, targetValue, specificEmail, scheduledAt, theme, ctaText, ctaUrl, fileUrl, fileName } = action.details;
          const finalContent = isBroadcast ? bcContent : msgText;

          const now = new Date();
          const sDate = scheduledAt ? new Date(scheduledAt) : now;
          const isFut = sDate > now;

          const camp = await query(
            `INSERT INTO public.notification_campaigns (title, message, target, target_value, created_by, status, scheduled_at, sent_count, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8) RETURNING id`,
            [title, finalContent, bcTarget || 'all', targetValue || specificEmail || null, action.requested_by, isFut ? 'scheduled' : 'sent', sDate, JSON.stringify({ theme, ctaText, ctaUrl, isBroadcast, fileUrl, fileName })]
          );

          if (!isFut) {
            const cta = ctaText ? { text: ctaText, url: ctaUrl } : null;
            const attachment = fileUrl ? { url: fileUrl, name: fileName || 'document.pdf' } : null;

            if (bcTarget === 'all') {
              socketService.broadcast('push_notification', { title, body: finalContent, type: 'campaign' });
              const usrs = await query('SELECT id, email, full_name FROM public.profiles WHERE is_global_admin = FALSE');
              for (const u of usrs.rows) {
                await mailService.sendSystemEmail(u.email, title, finalContent, theme, u.full_name || 'Utilisateur', cta, attachment);
              }
              await query('UPDATE public.notification_campaigns SET sent_count = $1 WHERE id = $2', [usrs.rows.length, camp.rows[0].id]);
            } else {
              const emails = (targetValue || specificEmail || "").split(',').map(e => e.trim()).filter(e => e);
              let sCount = 0;
              for (const email of emails) {
                const uRes = await query('SELECT id, full_name FROM public.profiles WHERE email = $1', [email]);
                if (uRes.rows.length > 0) socketService.sendToUser(uRes.rows[0].id, 'push_notification', { title, body: finalContent, type: 'campaign' });
                const success = await mailService.sendSystemEmail(email, title, finalContent, theme, uRes.rows[0]?.full_name || 'Utilisateur', cta, attachment);
                if (success) sCount++;
              }
              await query('UPDATE public.notification_campaigns SET sent_count = $1 WHERE id = $2', [sCount, camp.rows[0].id]);
            }
          }
          break;
      }
      await query('UPDATE public.admin_pending_actions SET status = \'approved\', processed_at = NOW(), processed_by = $1, admin_notes = $2 WHERE id = $3', [req.userId, comment || null, id]);
      await logAudit(req.userId, 'APPROVE_ACTION', 'pending_action', id, { type: action.action_type, target: action.target_name });
    } catch (err) {
      logger.error('Pending Action Approval Error:', err);
      return res.status(500).json({ success: false, error: 'Erreur lors de l\'exécution: ' + err.message });
    }
  } else if (decision === 'pending') {
    await query('UPDATE public.admin_pending_actions SET status = \'pending\', processed_at = NULL, processed_by = NULL WHERE id = $1', [id]);
    const mainAdmin = await query('SELECT id FROM public.profiles WHERE email = $1', ['wecanconcept@gmail.com']);
    if (mainAdmin.rows.length > 0) {
      socketService.sendToUser(mainAdmin.rows[0].id, 'admin:new_pending_action', { actionType: action.action_type, targetName: action.target_name, requestedBy: req.user.full_name });
    }
  } else {
    await query('UPDATE public.admin_pending_actions SET status = $1, processed_at = NOW(), processed_by = $2, admin_notes = $3 WHERE id = $4', [decision, req.userId, comment || null, id]);
  }

  socketService.sendToUser(action.requested_by, 'admin:action_processed', { actionType: action.action_type, decision, comment: comment || null });
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
    SELECT ad.*, ad.user_id as member_id, ad.modules as allowed_modules, ad.created_at as enrollment_date,
           p.full_name, p.email, p.avatar_url, p.is_global_admin,
           'Collaborateur' as role
    FROM public.admin_delegations ad
    JOIN public.profiles p ON ad.user_id = p.id
    WHERE p.is_global_admin = FALSE
    ORDER BY ad.created_at DESC
  `);
  res.json({ success: true, data: result.rows });
});

const getManagedAccounts = asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT
      p.id,
      p.full_name,
      p.email,
      p.avatar_url,
      CASE
        WHEN p.is_collaborator THEN 'collaborator'
        WHEN p.account_type = 'collaborator' THEN 'collaborator'
        WHEN sr.id IS NOT NULL THEN 'school_promoter'
        WHEN er.id IS NOT NULL THEN 'employer'
        WHEN mb.id IS NOT NULL THEN 'merchant'
        ELSE COALESCE(NULLIF(p.account_type, ''), 'member')
      END AS category,
      COALESCE(sr.school_name, er.company_name, mb.business_name, '') AS organization,
      CASE
        WHEN p.is_collaborator OR p.account_type = 'collaborator' THEN CASE WHEN p.is_collaborator AND COALESCE(ad.is_active, FALSE) THEN 'active' ELSE 'disabled' END
        WHEN COALESCE(p.is_locked, FALSE) THEN 'disabled'
        WHEN sr.id IS NOT NULL THEN sr.status
        WHEN er.id IS NOT NULL THEN er.status
        WHEN mb.id IS NOT NULL THEN mb.status
        ELSE 'active'
      END AS account_status,
      COALESCE(ad.modules, ARRAY[]::TEXT[]) AS modules,
      p.created_at,
      'profile' AS source_type,
      p.is_collaborator AS can_manage
    FROM public.profiles p
    LEFT JOIN public.admin_delegations ad ON ad.user_id = p.id
    LEFT JOIN LATERAL (
      SELECT id, school_name, status FROM public.school_requests
      WHERE user_id = p.id ORDER BY created_at DESC LIMIT 1
    ) sr ON TRUE
    LEFT JOIN LATERAL (
      SELECT id, company_name, status FROM public.employer_requests
      WHERE user_id = p.id ORDER BY created_at DESC LIMIT 1
    ) er ON TRUE
    LEFT JOIN LATERAL (
      SELECT id, business_name, status FROM public.market_businesses
      WHERE user_id = p.id ORDER BY created_at DESC LIMIT 1
    ) mb ON TRUE

    UNION ALL

    SELECT
      sar.id,
      sar.full_name,
      sar.email,
      NULL::TEXT AS avatar_url,
      sar.role AS category,
      sr.school_name AS organization,
      sar.status AS account_status,
      ARRAY[]::TEXT[] AS modules,
      sar.created_at,
      'school_staff' AS source_type,
      FALSE AS can_manage
    FROM public.school_account_requests sar
    JOIN public.school_requests sr ON sr.id = sar.school_id

    UNION ALL

    SELECT
      s.id,
      s.full_name,
      NULL::TEXT AS email,
      NULL::TEXT AS avatar_url,
      'student' AS category,
      sr.school_name AS organization,
      CASE WHEN COALESCE(s.is_active, TRUE) THEN 'active' ELSE 'disabled' END AS account_status,
      ARRAY[]::TEXT[] AS modules,
      s.created_at,
      'student' AS source_type,
      FALSE AS can_manage
    FROM public.school_students s
    JOIN public.school_requests sr ON sr.id = s.school_id

    ORDER BY created_at DESC NULLS LAST
  `);

  res.json({ success: true, data: result.rows });
});

const createManagedAccount = asyncHandler(async (req, res) => {
  const {
    accountType,
    fullName,
    email,
    phone,
    schoolId,
    schoolName,
    schoolEmail,
    schoolPhone,
    schoolAddress,
    schoolType,
    schoolDescription,
    schoolRole,
    classId,
    gender,
    birthDate,
    companyName,
    companyEmail,
    companyPhone,
    companyAddress,
    companyWebsite,
    industry,
    companySize,
    hiringNeeds,
    businessName,
    businessCategory,
    businessDescription,
    businessContact,
    businessCity,
    businessCommune,
    businessProvince,
    businessQuarter,
    businessPostalCode
  } = req.body;

  const supportedTypes = ['member', 'parent', 'school_promoter', 'school_staff', 'student', 'employer', 'merchant'];
  if (!supportedTypes.includes(accountType)) {
    return res.status(400).json({ success: false, error: 'Catégorie de compte non prise en charge.' });
  }

  const cleanName = typeof fullName === 'string' ? fullName.trim() : '';
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const accountNeedsProfile = ['member', 'parent', 'school_promoter', 'employer', 'merchant'].includes(accountType);

  if (!cleanName || (accountNeedsProfile && !cleanEmail) || (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail))) {
    return res.status(400).json({ success: false, error: 'Veuillez fournir un nom et une adresse email valide.' });
  }
  if (accountType === 'school_promoter' && (!schoolName?.trim() || !(schoolEmail || cleanEmail))) {
    return res.status(400).json({ success: false, error: 'Le nom et l’email de l’école sont obligatoires.' });
  }
  if (accountType === 'school_promoter' && schoolEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(schoolEmail.trim())) {
    return res.status(400).json({ success: false, error: 'L’email de l’école est invalide.' });
  }
  if (accountType === 'school_staff' && (!schoolId || !['prefet', 'directeur', 'enseignant', 'professeur'].includes(schoolRole))) {
    return res.status(400).json({ success: false, error: 'Choisissez une école approuvée et un rôle scolaire valide.' });
  }
  if (accountType === 'school_staff' && (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail))) {
    return res.status(400).json({ success: false, error: 'Un email valide est obligatoire pour le personnel scolaire.' });
  }
  if (accountType === 'student' && (!schoolId || !cleanName)) {
    return res.status(400).json({ success: false, error: 'Choisissez une école et indiquez le nom de l’élève.' });
  }
  if (accountType === 'employer' && (!companyName?.trim() || !industry?.trim())) {
    return res.status(400).json({ success: false, error: 'Le nom de l’entreprise et le secteur sont obligatoires.' });
  }
  if (accountType === 'employer' && companyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(companyEmail.trim())) {
    return res.status(400).json({ success: false, error: 'L’email professionnel est invalide.' });
  }
  if (accountType === 'merchant' && (!businessName?.trim() || !businessCategory?.trim())) {
    return res.status(400).json({ success: false, error: 'Le nom et la catégorie du commerce sont obligatoires.' });
  }

  const client = await pool.connect();
  let created;
  let temporaryPassword = null;

  try {
    await client.query('BEGIN');

    if (accountType === 'school_staff' || accountType === 'student') {
      const schoolResult = await client.query(
        `SELECT id, school_name FROM public.school_requests
         WHERE id = $1 AND LOWER(status) IN ('approuve', 'approuvé', 'approved')
         FOR SHARE`,
        [schoolId]
      );
      if (schoolResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: 'Cette école est introuvable ou n’est pas approuvée.' });
      }

      if (accountType === 'school_staff') {
        if (!cleanEmail) {
          await client.query('ROLLBACK');
          return res.status(400).json({ success: false, error: 'L’email du membre du personnel est obligatoire.' });
        }
        const duplicate = await client.query(
          'SELECT id FROM public.school_account_requests WHERE school_id = $1 AND LOWER(email) = $2',
          [schoolId, cleanEmail]
        );
        if (duplicate.rows.length) {
          await client.query('ROLLBACK');
          return res.status(409).json({ success: false, error: 'Cette adresse email est déjà enregistrée pour cette école.' });
        }

        const generatedCode = `SCH-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        const staffResult = await client.query(
          `INSERT INTO public.school_account_requests
           (school_id, full_name, email, role, phone, generated_code, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'en_attente') RETURNING id, generated_code, status`,
          [schoolId, cleanName, cleanEmail, schoolRole, phone?.trim() || null, generatedCode]
        );
        created = { id: staffResult.rows[0].id, status: staffResult.rows[0].status, generatedCode };
      } else {
        let validClassId = null;
        if (classId) {
          const classResult = await client.query(
            'SELECT id FROM public.school_classes WHERE id = $1 AND school_id = $2',
            [classId, schoolId]
          );
          if (classResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'La classe sélectionnée ne fait pas partie de cette école.' });
          }
          validClassId = classResult.rows[0].id;
        }
        const nameParts = cleanName.split(/\s+/);
        const accessCode = `STU-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        const studentResult = await client.query(
          `INSERT INTO public.school_students
           (school_id, class_id, full_name, first_name, last_name, gender, birth_date, access_code, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE) RETURNING id, access_code`,
          [schoolId, validClassId, cleanName, nameParts[0], nameParts.slice(1).join(' '), gender || null, birthDate || null, accessCode]
        );
        created = { id: studentResult.rows[0].id, generatedCode: studentResult.rows[0].access_code };
      }
    } else {
      const duplicate = await client.query(
        'SELECT id FROM public.profiles WHERE LOWER(email) = $1 OR ($2 IS NOT NULL AND phone_number = $2)',
        [cleanEmail, phone?.trim() || null]
      );
      if (duplicate.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, error: 'Un compte utilise déjà cette adresse email ou ce numéro de téléphone.' });
      }

      temporaryPassword = crypto.randomBytes(9).toString('base64url');
      const hashedPassword = await bcrypt.hash(temporaryPassword, 10);
      const userId = crypto.randomUUID();
      const username = `${cleanEmail.split('@')[0]}_${userId.slice(0, 8)}`;
      const profileResult = await client.query(
        `INSERT INTO public.profiles
         (id, full_name, email, password, username, phone_number, account_type, is_verified, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, TRUE) RETURNING id`,
        [userId, cleanName, cleanEmail, hashedPassword, username, phone?.trim() || null, accountType]
      );
      created = { id: profileResult.rows[0].id };

      if (accountType === 'school_promoter') {
        const requestResult = await client.query(
          `INSERT INTO public.school_requests
           (user_id, school_name, school_email, school_phone, school_address, school_type, description, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'en_attente') RETURNING id`,
          [userId, schoolName.trim(), (schoolEmail || cleanEmail).trim().toLowerCase(), schoolPhone?.trim() || null, schoolAddress?.trim() || null, schoolType?.trim() || null, schoolDescription?.trim() || null]
        );
        created.requestId = requestResult.rows[0].id;
        created.status = 'en_attente';
      } else if (accountType === 'employer') {
        const requestResult = await client.query(
          `INSERT INTO public.employer_requests
           (user_id, company_name, company_email, company_phone, company_address, company_website, industry, company_size, hiring_needs, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending') RETURNING id`,
          [userId, companyName.trim(), (companyEmail || cleanEmail).trim().toLowerCase(), companyPhone?.trim() || null, companyAddress?.trim() || null, companyWebsite?.trim() || null, industry.trim(), companySize?.trim() || null, hiringNeeds?.trim() || null]
        );
        created.requestId = requestResult.rows[0].id;
        created.status = 'pending';
      } else if (accountType === 'merchant') {
        const businessResult = await client.query(
          `INSERT INTO public.market_businesses
           (user_id, category, business_name, short_description, contact_info, address_city, address_commune, address_province, address_quarter, address_postal_code, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending') RETURNING id`,
          [userId, businessCategory.trim(), businessName.trim(), businessDescription?.trim() || null, businessContact?.trim() || phone?.trim() || null, businessCity?.trim() || null, businessCommune?.trim() || null, businessProvince?.trim() || null, businessQuarter?.trim() || null, businessPostalCode?.trim() || null]
        );
        created.requestId = businessResult.rows[0].id;
        created.status = 'pending';
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(409).json({ success: false, error: 'Un compte ou un code d’accès existe déjà avec ces informations.' });
    }
    throw error;
  } finally {
    client.release();
  }

  let emailSent = null;
  if (temporaryPassword) {
    emailSent = await mailService.sendCollaboratorAccountEmail(cleanEmail, cleanName, temporaryPassword, accountType);
  }

  if (accountType === 'school_promoter') {
    socketService.broadcast('admin:new_school_request', { id: created.requestId, school_name: schoolName.trim(), user_id: created.id });
  } else if (accountType === 'employer') {
    socketService.broadcast('admin:new_employer_request', { id: created.requestId, company_name: companyName.trim(), user_id: created.id });
  } else if (accountType === 'merchant') {
    socketService.broadcast('admin:new_market', { id: created.requestId, business_name: businessName.trim(), owner_id: created.id });
  }

  await logAdminAction(req, 'create_managed_account', accountType, created.id, {
    email: cleanEmail || null,
    status: created.status || 'active'
  });

  const messages = {
    member: 'Compte utilisateur créé.',
    parent: 'Compte parent créé.',
    school_promoter: 'Compte promoteur créé; la demande d’école reste en attente de validation.',
    school_staff: 'Demande du personnel scolaire créée; elle doit être approuvée avant la connexion par code.',
    student: 'Compte élève créé et code d’accès généré.',
    employer: 'Compte employeur créé; la demande reste en attente de validation.',
    merchant: 'Compte commerçant créé; la demande reste en attente de validation.'
  };

  res.status(201).json({
    success: true,
    message: messages[accountType],
    data: {
      ...created,
      emailSent,
      ...(emailSent === false ? { temporaryPassword } : {})
    }
  });
});

/**
 * @desc    Créer ou mettre à jour une délégation
 */
const saveDelegation = asyncHandler(async (req, res) => {
  await ensureAdminTables();
  if (!req.user.is_global_admin) return res.status(403).json({ success: false, error: 'Accès réservé' });
  const { userId, modules, isActive = true, collabAdminRights = {}, userAdminRights = {}, granularPermissions = {}, requiresApproval = true } = req.body;

  const userRes = await query('SELECT id, full_name, email FROM public.profiles WHERE id = $1', [userId]);
  if (userRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Utilisateur Meet Me non trouvé' });

  const user = userRes.rows[0];

  await query(
    `INSERT INTO public.admin_delegations (user_id, modules, is_active, collab_admin_rights, user_admin_rights, granular_permissions, requires_approval, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (user_id) DO UPDATE
     SET modules = EXCLUDED.modules, is_active = EXCLUDED.is_active,
         collab_admin_rights = EXCLUDED.collab_admin_rights,
         user_admin_rights = EXCLUDED.user_admin_rights,
         granular_permissions = EXCLUDED.granular_permissions,
         requires_approval = EXCLUDED.requires_approval,
         updated_at = NOW()`,
    [userId, modules, isActive, JSON.stringify(collabAdminRights), JSON.stringify(userAdminRights), JSON.stringify(granularPermissions), requiresApproval]
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
  const canExecute = await processSensitiveAction(req, 'delete_user', userId, user.rows[0].full_name, { deleted: true }, 'users', 'delete');
  if (!canExecute) return res.json({ success: true, pending: true, message: 'Cette action nécessite l\'approbation de l\'administrateur principal.' });

  await query('DELETE FROM public.messages WHERE sender_id = $1', [userId]);
  await query('DELETE FROM public.chat_participants WHERE user_id = $1', [userId]);
  await query('UPDATE public.chats SET created_by = NULL WHERE created_by = $1', [userId]);
  await query('DELETE FROM public.profiles WHERE id = $1', [userId]);

  await logAdminAction(req, 'delete_user', 'user', userId, { deleted: true });
  res.json({ success: true, message: 'Utilisateur supprimé' });
});

const saveScheduledUserDeletion = async (userId, requestedBy, scheduledAt) => {
  await ensureScheduledUserDeletionsTable();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userResult = await client.query(
      'SELECT full_name, is_global_admin FROM public.profiles WHERE id = $1 FOR UPDATE',
      [userId]
    );
    if (!userResult.rows[0]) throw new Error('Utilisateur non trouvé');
    if (userResult.rows[0].is_global_admin) throw new Error('Impossible de supprimer un administrateur global');

    const current = await client.query(
      `SELECT id, status FROM public.admin_scheduled_user_deletions
       WHERE user_id = $1 AND status IN ('scheduled', 'processing')
       FOR UPDATE`,
      [userId]
    );
    if (current.rows[0]?.status === 'processing') {
      throw new Error('La suppression de ce compte est déjà en cours.');
    }

    let result;
    if (current.rows[0]) {
      result = await client.query(
        `UPDATE public.admin_scheduled_user_deletions
         SET scheduled_at = $1, requested_by = $2, user_name = $3, status = 'scheduled',
             last_error = NULL, updated_at = NOW()
         WHERE id = $4 RETURNING id, scheduled_at, status`,
        [scheduledAt, requestedBy, userResult.rows[0].full_name, current.rows[0].id]
      );
    } else {
      result = await client.query(
        `INSERT INTO public.admin_scheduled_user_deletions (user_id, user_name, scheduled_at, requested_by)
         VALUES ($1, $2, $3, $4) RETURNING id, scheduled_at, status`,
        [userId, userResult.rows[0].full_name, scheduledAt, requestedBy]
      );
    }
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const scheduleUserDeletion = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const requestedAt = req.body?.scheduledAt;
  const scheduledAt = new Date(requestedAt);
  if (typeof requestedAt !== 'string' || Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
    return res.status(400).json({ success: false, error: 'Choisissez une date et une heure futures valides.' });
  }
  const userResult = await query(
    'SELECT full_name, is_global_admin FROM public.profiles WHERE id = $1',
    [userId]
  );
  const user = userResult.rows[0];
  if (!user) return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });
  if (user.is_global_admin) return res.status(403).json({ success: false, error: 'Impossible de supprimer un administrateur global' });
  if (!req.user.is_global_admin && !req.user.granular_permissions?.users?.includes('delete')) {
    return res.status(403).json({ success: false, error: 'Vous ne pouvez pas programmer la suppression de comptes.' });
  }

  const canExecute = await processSensitiveAction(
    req,
    'schedule_delete_user',
    userId,
    user.full_name,
    { scheduledAt: scheduledAt.toISOString() },
    'users',
    'delete'
  );
  if (!canExecute) {
    return res.json({ success: true, pending: true, message: 'La planification a été envoyée à l’administrateur principal pour approbation.' });
  }

  try {
    const scheduled = await saveScheduledUserDeletion(userId, req.userId, scheduledAt.toISOString());
    await logAdminAction(req, 'schedule_delete_user', 'user', userId, { scheduledAt: scheduled.scheduled_at });
    res.json({ success: true, data: scheduled, message: 'Suppression programmée.' });
  } catch (error) {
    if (error.message === 'Utilisateur non trouvé') return res.status(404).json({ success: false, error: error.message });
    if (error.message.includes('administrateur global')) return res.status(403).json({ success: false, error: error.message });
    if (error.message.includes('déjà en cours')) return res.status(409).json({ success: false, error: error.message });
    throw error;
  }
});

const cancelScheduledUserDeletion = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  await ensureScheduledUserDeletionsTable();
  const userResult = await query(
    `SELECT p.full_name, sd.id
     FROM public.profiles p
     JOIN public.admin_scheduled_user_deletions sd ON sd.user_id = p.id AND sd.status = 'scheduled'
     WHERE p.id = $1
     ORDER BY sd.created_at DESC LIMIT 1`,
    [userId]
  );
  if (!userResult.rows[0]) return res.status(404).json({ success: false, error: 'Aucune suppression programmée à annuler.' });
  if (!req.user.is_global_admin && !req.user.granular_permissions?.users?.includes('delete')) {
    return res.status(403).json({ success: false, error: 'Vous ne pouvez pas annuler la suppression programmée.' });
  }

  const canExecute = await processSensitiveAction(
    req,
    'cancel_scheduled_delete',
    userId,
    userResult.rows[0].full_name,
    { scheduleId: userResult.rows[0].id },
    'users',
    'delete'
  );
  if (!canExecute) {
    return res.json({ success: true, pending: true, message: 'La demande d’annulation a été envoyée à l’administrateur principal.' });
  }

  const result = await query(
    `UPDATE public.admin_scheduled_user_deletions
     SET status = 'cancelled', updated_at = NOW()
     WHERE id = $1 AND status = 'scheduled'`,
    [userResult.rows[0].id]
  );
  if (result.rowCount === 0) return res.status(409).json({ success: false, error: 'La suppression est déjà en cours ou terminée.' });
  await logAdminAction(req, 'cancel_scheduled_delete', 'user', userId, { scheduleId: userResult.rows[0].id });
  res.json({ success: true, message: 'Suppression programmée annulée.' });
});

const sendUserSecurityNotice = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const message = String(req.body?.message || '').trim();
  if (!message || message.length > 2000) {
    return res.status(400).json({ success: false, error: 'Le message doit contenir entre 1 et 2000 caractères.' });
  }
  const userResult = await query(
    'SELECT full_name, email FROM public.profiles WHERE id = $1 AND is_global_admin = FALSE',
    [userId]
  );
  const user = userResult.rows[0];
  if (!user) return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });
  if (!user.email) return res.status(400).json({ success: false, error: 'Aucune adresse e-mail enregistrée pour ce compte.' });
  if (!req.user.is_global_admin && !req.user.granular_permissions?.users?.includes('notify')) {
    return res.status(403).json({ success: false, error: 'Vous ne pouvez pas envoyer les avis de sécurité.' });
  }

  const canExecute = await processSensitiveAction(
    req,
    'send_security_notice',
    userId,
    user.full_name,
    { message },
    'users',
    'notify'
  );
  if (!canExecute) {
    return res.json({ success: true, pending: true, message: 'L’avis de sécurité a été envoyé à l’administrateur principal pour approbation.' });
  }

  const sent = await mailService.sendSecurityNoticeEmail(user.email, user.full_name, message);
  if (!sent) return res.status(502).json({ success: false, error: 'L’e-mail n’a pas pu être envoyé. Vérifiez le service de messagerie.' });
  await logAdminAction(req, 'send_security_notice', 'user', userId, { email: user.email });
  res.json({ success: true, message: 'Notification de sécurité envoyée par e-mail.' });
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
  const canExecute = await processSensitiveAction(req, 'toggle_user_lock', userId, user.rows[0].full_name, { isLocked }, 'users', 'lock');
  if (!canExecute) return res.json({ success: true, pending: true, message: `Action de ${isLocked ? 'blocage' : 'déblocage'} mise en attente.` });

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
  const canExecute = await processSensitiveAction(req, 'toggle_user_badge', userId, user.rows[0].full_name, { isVerified }, 'users', 'verify');
  if (!canExecute) return res.json({ success: true, pending: true, message: 'Demande de gestion de badge mise en attente.' });

  await query('UPDATE public.profiles SET is_verified = $1 WHERE id = $2', [isVerified, userId]);
  await logAdminAction(req, isVerified ? 'verify_user' : 'unverify_user', 'user', userId, { isVerified });

  // Real-time update via socket
  socketService.broadcast('admin:user_verification_updated', { userId, isVerified });

  res.json({ success: true });
});

/**
 * @desc    Réinitialiser le mot de passe d'un utilisateur
 */
const resetUserPassword = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const userRes = await query('SELECT full_name, email FROM public.profiles WHERE id = $1', [userId]);
  if (!userRes.rows[0]) return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });
  const user = userRes.rows[0];

  const canExecute = await processSensitiveAction(req, 'reset_password', userId, user.full_name, {}, 'users', 'reset_pass');
  if (!canExecute) return res.json({ success: true, pending: true, message: 'Demande de réinitialisation mise en attente.' });

  // 1. Générer MDP
  const tempPassword = crypto.randomBytes(4).toString('hex').toUpperCase();
  const hashedPassword = await bcrypt.hash(tempPassword, 10);

  // 2. Maj DB
  await query(
    'UPDATE public.profiles SET password = $1, must_change_password = TRUE WHERE id = $2',
    [hashedPassword, userId]
  );

  // 3. Envoyer Email
  await mailService.sendPasswordResetEmail(user.email, user.full_name, tempPassword);

  await logAdminAction(req, 'reset_password', 'user', userId, { email: user.email });
  res.json({ success: true, message: 'Le mot de passe a été réinitialisé et envoyé par e-mail.' });
});

/**
 * @desc    Lister les groupes
 */
const getGroups = asyncHandler(async (req, res) => {
  await ensureAdminTables();

  const hasReadPerm = req.user.is_global_admin || (req.user.granular_permissions && req.user.granular_permissions.groups && req.user.granular_permissions.groups.includes('read'));
  if (!hasReadPerm) {
    return res.status(403).json({ success: false, error: 'Accès refusé : Vous n\'avez pas le droit de voir la liste des groupes.' });
  }

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

  const canExecute = await processSensitiveAction(req, 'toggle_group_ban', chatId, group.rows[0].name, { isBanned }, 'groups', 'ban');
  if (!canExecute) return res.json({ success: true, pending: true, message: `Action de ${isBanned ? 'bannissement' : 'débannissement'} mise en attente.` });

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

  const canExecute = await processSensitiveAction(req, 'delete_group', chatId, group.rows[0].name, { deleted: true }, 'groups', 'moderate');
  if (!canExecute) return res.json({ success: true, pending: true, message: 'Demande de suppression de groupe mise en attente.' });

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
  const hasReadPerm = req.user.is_global_admin || (req.user.granular_permissions && req.user.granular_permissions.support && req.user.granular_permissions.support.includes('read'));
  if (!hasReadPerm) {
    return res.status(403).json({ success: false, error: 'Accès refusé : Vous n\'avez pas le droit de voir les contestations.' });
  }

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

  const canExecute = await processSensitiveAction(req, 'reply_appeal', id, 'Appeal', { reply, action }, 'support', 'reply');
  if (!canExecute) return res.json({ success: true, pending: true, message: 'Votre réponse a été mise en attente d\'approbation.' });

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
  const { title, message, target = 'all', targetValue, scheduledAt, theme = 'amazon', ctaText, ctaUrl, fileUrl, fileName } = req.body;
  if (!title || !message) {
    return res.status(400).json({ success: false, error: 'Titre et message requis' });
  }

  await ensureAdminTables();

  const canExecute = await processSensitiveAction(req, 'create_campaign', null, title, req.body, 'campaigns', 'create');
  if (!canExecute) return res.json({ success: true, pending: true, message: 'Votre campagne a été mise en attente pour approbation par l\'Administrateur Principal.' });

  // Si scheduledAt est fourni et est dans le futur, on enregistre seulement
  const now = new Date();
  const scheduledDate = scheduledAt ? new Date(scheduledAt) : now;
  if (scheduledAt && (Number.isNaN(scheduledDate.getTime()) || scheduledDate <= now)) {
    return res.status(400).json({ success: false, error: 'Choisissez une date et une heure futures valides.' });
  }
  const isFuture = scheduledDate > now;

  const campaign = await query(
    `INSERT INTO public.notification_campaigns (title, message, target, target_value, created_by, status, scheduled_at, sent_count, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8) RETURNING *`,
    [title, message, target || 'all', targetValue || null, req.user?.id || null, isFuture ? 'scheduled' : 'sent', scheduledDate, JSON.stringify({ theme, ctaText, ctaUrl, fileUrl, fileName })]
  );

  // Si l'envoi est immédiat
  if (!isFuture) {
    const cta = ctaText ? { text: ctaText, url: ctaUrl } : null;
    const attachment = fileUrl ? { url: fileUrl, name: fileName || 'document.pdf' } : null;

    if (target === 'all') {
      const users = await query('SELECT id, email, full_name FROM public.profiles WHERE is_global_admin = FALSE');
      for (const user of users.rows) {
        socketService.sendToUser(user.id, 'push_notification', { title, body: message, type: 'campaign' });
        await mailService.sendSystemEmail(user.email, title, message, theme, user.full_name || 'Utilisateur', cta, attachment);
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
        const success = await mailService.sendSystemEmail(email, title, message, theme, userName, cta, attachment);
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
  if (scheduledAt) {
    const nextDate = new Date(scheduledAt);
    if (Number.isNaN(nextDate.getTime()) || nextDate <= new Date()) {
      return res.status(400).json({ success: false, error: 'Choisissez une date et une heure futures valides.' });
    }
  }

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

  const canExecute = await processSensitiveAction(req, 'delete_campaign', id, 'Campaign', { deleted: true }, 'campaigns', 'delete');
  if (!canExecute) return res.json({ success: true, pending: true, message: 'Demande de suppression de campagne mise en attente.' });

  const result = await query('DELETE FROM public.notification_campaigns WHERE id = $1 AND status = \'scheduled\' RETURNING id');

  if (result.rows.length === 0) {
    return res.status(404).json({ success: false, error: 'Campagne introuvable ou déjà envoyée' });
  }

  await logAdminAction(req, 'delete_campaign', 'campaign', id);
  res.json({ success: true, message: 'Campagne supprimée' });
});

const resendCampaign = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, message, target, targetValue, scheduledAt } = req.body;
  const scheduledDate = new Date(scheduledAt);

  if (!title?.trim() || !message?.trim()) {
    return res.status(400).json({ success: false, error: 'Titre et message requis.' });
  }
  if (Number.isNaN(scheduledDate.getTime()) || scheduledDate <= new Date()) {
    return res.status(400).json({ success: false, error: 'Choisissez une date et une heure futures valides.' });
  }
  if (!['all', 'specific'].includes(target)) {
    return res.status(400).json({ success: false, error: 'Cible de campagne invalide.' });
  }
  if (target === 'specific' && !targetValue?.trim()) {
    return res.status(400).json({ success: false, error: 'Indiquez au moins une adresse e-mail destinataire.' });
  }

  const originalResult = await query(
    `SELECT id, metadata FROM public.notification_campaigns
     WHERE id = $1 AND status = 'sent'`,
    [id]
  );
  if (originalResult.rows.length === 0) {
    return res.status(404).json({ success: false, error: 'Campagne envoyée introuvable.' });
  }

  const canExecute = await processSensitiveAction(
    req,
    'resend_campaign',
    id,
    title.trim(),
    { sourceCampaignId: id, scheduledAt: scheduledDate.toISOString() },
    'campaigns',
    'create'
  );
  if (!canExecute) {
    return res.json({ success: true, pending: true, message: 'La demande de renvoi a été envoyée pour approbation.' });
  }

  const campaign = await query(
    `INSERT INTO public.notification_campaigns
       (title, message, target, target_value, created_by, status, scheduled_at, sent_count, metadata)
     VALUES ($1, $2, $3, $4, $5, 'scheduled', $6, 0, $7)
     RETURNING *`,
    [
      title.trim(),
      message.trim(),
      target,
      target === 'specific' ? targetValue.trim() : null,
      req.user?.id || null,
      scheduledDate.toISOString(),
      JSON.stringify(originalResult.rows[0].metadata || {})
    ]
  );

  await logAdminAction(req, 'resend_campaign', 'campaign', campaign.rows[0].id, {
    sourceCampaignId: id,
    scheduledAt: scheduledDate.toISOString()
  });
  res.status(201).json({ success: true, data: campaign.rows[0], message: 'Nouvelle campagne de renvoi programmée.' });
});

const getAnalytics = asyncHandler(async (req, res) => {
  await employerController.ensureEmployerTables();

  const normalizedSchoolStatus = (column) => `translate(
    regexp_replace(lower(COALESCE(${column}, '')), '[[:space:]_-]+', '', 'g'),
    'áàâäãéèêëíìîïóòôöõúùûüç',
    'aaaaaeeeeiiiiooooouuuuc'
  )`;
  const approvedStatus = (column = 'status') => `${normalizedSchoolStatus(column)} IN ('approuve', 'approuvee', 'approved', 'approve', 'valide', 'validee')`;
  const pendingStatus = (column = 'status') => `${normalizedSchoolStatus(column)} IN ('enattente', 'attente', 'pending')`;

  const [schoolTotals, schoolStudents, employmentTotals, monthlyTrend] = await Promise.all([
    query(`
      SELECT
        COUNT(*) FILTER (WHERE ${approvedStatus()}) AS approved_schools,
        COUNT(*) FILTER (WHERE ${pendingStatus()}) AS pending_school_requests
      FROM public.school_requests
    `),
    query(`
      SELECT sr.school_name, COUNT(ss.id)::int AS student_count
      FROM public.school_requests sr
      LEFT JOIN public.school_students ss ON ss.school_id = sr.id
      WHERE ${approvedStatus('sr.status')}
      GROUP BY sr.id, sr.school_name
      ORDER BY student_count DESC, lower(sr.school_name) ASC
    `),
    query(`
      SELECT
        COUNT(*)::int AS applications,
        COUNT(*) FILTER (WHERE lower(COALESCE(status, '')) = 'hired')::int AS hires
      FROM public.job_applications
    `),
    query(`
      WITH months AS (
        SELECT generate_series(
          date_trunc('month', CURRENT_DATE) - INTERVAL '5 months',
          date_trunc('month', CURRENT_DATE),
          INTERVAL '1 month'
        ) AS month_start
      )
      SELECT
        months.month_start,
        COUNT(DISTINCT p.id)::int AS signups,
        COUNT(DISTINCT sr.id)::int AS school_requests_created,
        COUNT(DISTINCT ja.id)::int AS applications
      FROM months
      LEFT JOIN public.profiles p
        ON p.is_global_admin = FALSE
        AND p.created_at >= months.month_start
        AND p.created_at < months.month_start + INTERVAL '1 month'
      LEFT JOIN public.school_requests sr
        ON sr.created_at >= months.month_start
        AND sr.created_at < months.month_start + INTERVAL '1 month'
      LEFT JOIN public.job_applications ja
        ON ja.applied_at >= months.month_start
        AND ja.applied_at < months.month_start + INTERVAL '1 month'
      GROUP BY months.month_start
      ORDER BY months.month_start ASC
    `),
  ]);

  const schools = schoolStudents.rows.map((row) => ({
    schoolName: row.school_name,
    studentCount: Number(row.student_count) || 0,
  }));

  res.json({
    success: true,
    data: {
      approvedSchools: Number(schoolTotals.rows[0].approved_schools) || 0,
      pendingSchoolRequests: Number(schoolTotals.rows[0].pending_school_requests) || 0,
      totalStudents: schools.reduce((total, school) => total + school.studentCount, 0),
      schoolStudents: schools,
      employment: {
        applications: Number(employmentTotals.rows[0].applications) || 0,
        hires: Number(employmentTotals.rows[0].hires) || 0,
      },
      monthlyTrend: monthlyTrend.rows.map((row) => ({
        month: row.month_start,
        signups: Number(row.signups) || 0,
        schoolRequestsCreated: Number(row.school_requests_created) || 0,
        applications: Number(row.applications) || 0,
      })),
    },
  });
});

const getUsageAnalytics = asyncHandler(async (req, res) => {
  if (!req.user.is_global_admin && (!Array.isArray(req.user.allowed_modules) || !req.user.allowed_modules.includes('stats'))) {
    return res.status(403).json({ success: false, error: 'Permission insuffisante : stats' });
  }

  const period = ['30d', '90d', '365d', 'all'].includes(req.query.period) ? req.query.period : '30d';
  const parsedOffset = Number.parseInt(req.query.offset, 10);
  const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? Math.min(parsedOffset, 1000000) : 0;
  const limit = 50;
  const periodStart = period === 'all' ? null : new Date(Date.now() - Number.parseInt(period, 10) * 24 * 60 * 60 * 1000);

  const actionSources = [
    { table: 'messages', userColumn: 'sender_id', timeColumn: 'created_at', key: 'messagesSent' },
    { table: 'statuses', userColumn: 'user_id', timeColumn: 'created_at', key: 'statusesPosted' },
    { table: 'status_views', userColumn: 'user_id', timeColumn: 'viewed_at', key: 'statusViews' },
    { table: 'job_views', userColumn: 'viewer_id', timeColumn: 'viewed_at', key: 'jobViews' },
    { table: 'job_applications', userColumn: 'applicant_id', timeColumn: 'applied_at', key: 'jobApplications' },
    { table: 'calls', userColumn: 'caller_id', timeColumn: 'created_at', key: 'callsInitiated' },
  ];
  const sourceColumns = await query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [actionSources.map((source) => source.table)]
  );
  const columnsByTable = new Map();
  sourceColumns.rows.forEach((row) => {
    if (!columnsByTable.has(row.table_name)) columnsByTable.set(row.table_name, new Set());
    columnsByTable.get(row.table_name).add(row.column_name);
  });
  const availableSources = actionSources.filter((source) => {
    const columns = columnsByTable.get(source.table);
    return columns && columns.has(source.userColumn) && columns.has(source.timeColumn);
  });
  const availableActions = availableSources.map((source) => source.key);
  const actionQueries = availableSources.map((source) => (
    `SELECT ${source.userColumn} AS user_id, ${source.timeColumn} AS action_at, '${source.key}'::text AS action_type
     FROM public.${source.table}
     WHERE ${source.userColumn} IS NOT NULL ${periodStart ? `AND ${source.timeColumn} >= $1` : ''}`
  ));
  const observedActions = actionQueries.length
    ? actionQueries.join('\nUNION ALL\n')
    : 'SELECT NULL::uuid AS user_id, NULL::timestamptz AS action_at, NULL::text AS action_type WHERE FALSE';
  const pagingParameters = periodStart ? [periodStart, limit, offset] : [limit, offset];
  const limitParameter = periodStart ? '$2' : '$1';
  const offsetParameter = periodStart ? '$3' : '$2';

  const [registeredUsersTrend, totalUsers, userRows] = await Promise.all([
    query(`
      WITH bounds AS (
        SELECT date_trunc('month', MIN(created_at)) AS first_month
        FROM public.profiles
        WHERE is_global_admin = FALSE AND created_at IS NOT NULL
      ),
      months AS (
        SELECT generate_series(first_month, date_trunc('month', CURRENT_DATE), INTERVAL '1 month') AS month_start
        FROM bounds
        WHERE first_month IS NOT NULL
      ),
      monthly_signups AS (
        SELECT date_trunc('month', created_at) AS month_start, COUNT(*) AS signups
        FROM public.profiles
        WHERE is_global_admin = FALSE AND created_at IS NOT NULL
        GROUP BY 1
      )
      SELECT months.month_start::date AS month,
             (months.month_start = date_trunc('month', CURRENT_DATE)) AS is_current_month,
             SUM(COALESCE(monthly_signups.signups, 0)) OVER (ORDER BY months.month_start)::int AS cumulative_users
      FROM months
      LEFT JOIN monthly_signups USING (month_start)
      ORDER BY months.month_start
    `),
    query('SELECT COUNT(*)::int AS total FROM public.profiles WHERE is_global_admin = FALSE'),
    query(`
      WITH observed_actions AS (
        ${observedActions}
      ),
      activity_by_user AS (
        SELECT user_id,
          COUNT(*) FILTER (WHERE action_type = 'messagesSent')::int AS messages_sent,
          COUNT(*) FILTER (WHERE action_type = 'statusesPosted')::int AS statuses_posted,
          COUNT(*) FILTER (WHERE action_type = 'statusViews')::int AS status_views,
          COUNT(*) FILTER (WHERE action_type = 'jobViews')::int AS job_views,
          COUNT(*) FILTER (WHERE action_type = 'jobApplications')::int AS job_applications,
          COUNT(*) FILTER (WHERE action_type = 'callsInitiated')::int AS calls_initiated,
          MAX(action_at) AS last_activity_at
        FROM observed_actions
        GROUP BY user_id
      )
      SELECT p.id AS user_id,
        COALESCE(NULLIF(BTRIM(p.full_name), ''), NULLIF(BTRIM(p.username), ''), 'Utilisateur') AS display_name,
        p.username,
        COALESCE(a.messages_sent, 0) AS messages_sent,
        COALESCE(a.statuses_posted, 0) AS statuses_posted,
        COALESCE(a.status_views, 0) AS status_views,
        COALESCE(a.job_views, 0) AS job_views,
        COALESCE(a.job_applications, 0) AS job_applications,
        COALESCE(a.calls_initiated, 0) AS calls_initiated,
        a.last_activity_at
      FROM public.profiles p
      LEFT JOIN activity_by_user a ON a.user_id = p.id
      WHERE p.is_global_admin = FALSE
      ORDER BY a.last_activity_at DESC NULLS LAST, p.created_at DESC NULLS LAST, p.id
      LIMIT ${limitParameter} OFFSET ${offsetParameter}
    `, pagingParameters),
  ]);

  res.json({
    success: true,
    data: {
      period,
      periodStart: periodStart ? periodStart.toISOString() : null,
      registeredUsersTrend: registeredUsersTrend.rows.map((row) => ({
        month: row.month,
        isCurrentMonth: row.is_current_month,
        cumulativeUsers: Number(row.cumulative_users) || 0,
      })),
      userActivity: {
        availableActions,
        users: userRows.rows.map((row) => ({
          userId: row.user_id,
          displayName: row.display_name,
          username: row.username,
          messagesSent: Number(row.messages_sent) || 0,
          statusesPosted: Number(row.statuses_posted) || 0,
          statusViews: Number(row.status_views) || 0,
          jobViews: Number(row.job_views) || 0,
          jobApplications: Number(row.job_applications) || 0,
          callsInitiated: Number(row.calls_initiated) || 0,
          lastActivityAt: row.last_activity_at,
        })),
        total: Number(totalUsers.rows[0].total) || 0,
        offset,
        limit,
      },
    },
  });
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
  const { content, title, target = 'all', specificEmail, scheduledAt, theme = 'amazon', ctaText, ctaUrl, fileUrl, fileName } = req.body;
  if (!content || !title) return res.status(400).json({ success: false, error: 'Titre et contenu requis' });

  await ensureAdminTables();

  const canExecute = await processSensitiveAction(req, 'broadcast_message', null, title, req.body, 'campaigns', 'create');
  if (!canExecute) return res.json({ success: true, pending: true, message: 'Votre diffusion a été mise en attente pour approbation par l\'Administrateur Principal.' });

  // Si scheduledAt est fourni et est dans le futur, on enregistre dans notification_campaigns avec le type 'broadcast'
  const now = new Date();
  const scheduledDate = scheduledAt ? new Date(scheduledAt) : now;
  const isFuture = scheduledDate > now;

  if (isFuture) {
    const campaign = await query(
      `INSERT INTO public.notification_campaigns (title, message, target, target_value, created_by, status, scheduled_at, sent_count, metadata)
       VALUES ($1, $2, $3, $4, $5, 'scheduled', $6, 0, $7) RETURNING *`,
      [title, content, target, specificEmail || null, req.user?.id || null, scheduledDate, JSON.stringify({ theme, isBroadcast: true, ctaText, ctaUrl, fileUrl, fileName })]
    );
    await logAdminAction(req, 'broadcast_scheduled', 'system', campaign.rows[0].id, { title, target, scheduledAt });
    return res.json({ success: true, message: 'Diffusion programmée avec succès.' });
  }

  const cta = ctaText ? { text: ctaText, url: ctaUrl } : null;
  const attachment = fileUrl ? { url: fileUrl, name: fileName || 'document.pdf' } : null;

  if (target === 'all') {
    socketService.broadcast('push_notification', { title, body: content, type: 'system' });
    const users = await query('SELECT email, full_name FROM public.profiles WHERE is_global_admin = FALSE');
    for (const user of users.rows) {
      await mailService.sendSystemEmail(user.email, title, content, theme, user.full_name || 'Utilisateur', cta, attachment);
    }

    // Sauvegarder dans l'historique
    await query(
      `INSERT INTO public.notification_campaigns (title, message, target, target_value, created_by, status, scheduled_at, sent_count, metadata)
       VALUES ($1, $2, $3, $4, $5, 'sent', NOW(), $6, $7)`,
      [title, content, 'all', null, req.user?.id || null, users.rows.length, JSON.stringify({ theme, isBroadcast: true, ctaText, ctaUrl, fileUrl, fileName })]
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
      const success = await mailService.sendSystemEmail(email, title, content, theme, userName, cta, attachment);
      if (success) sentCount++;
    }

    // Sauvegarder dans l'historique
    await query(
      `INSERT INTO public.notification_campaigns (title, message, target, target_value, created_by, status, scheduled_at, sent_count, metadata)
       VALUES ($1, $2, $3, $4, $5, 'sent', NOW(), $6, $7)`,
      [title, content, 'specific', specificEmail, req.user?.id || null, sentCount, JSON.stringify({ theme, isBroadcast: true, ctaText, ctaUrl, fileUrl, fileName })]
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

  const currentAppVersion = '93.0.0';

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

  const canExecute = await processSensitiveAction(req, 'delete_config', id, 'AppConfig', { deleted: true }, 'config', 'update');
  if (!canExecute) return res.json({ success: true, pending: true, message: 'Demande de suppression config mise en attente.' });

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

  const canExecute = await processSensitiveAction(req, 'delete_legal', type, 'LegalDoc', { deleted: true }, 'legal', 'update');
  if (!canExecute) return res.json({ success: true, pending: true, message: 'Demande de suppression doc légal mise en attente.' });

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
  const hasReadPerm = req.user.is_global_admin || (req.user.granular_permissions && req.user.granular_permissions['market-requests'] && req.user.granular_permissions['market-requests'].includes('read'));
  if (!hasReadPerm) {
    return res.status(403).json({ success: false, error: 'Accès refusé : Vous n\'avez pas le droit de voir les demandes Market.' });
  }

  const result = await query(`
    SELECT mb.*, p.full_name as owner_name, p.email as owner_email
    FROM public.market_businesses mb
    JOIN public.profiles p ON mb.user_id = p.id
    ORDER BY mb.created_at DESC
  `);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Get all school requests for admin
 */
const getSchoolRequests = asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT sr.*, p.full_name as owner_name, p.email as owner_email
    FROM public.school_requests sr
    JOIN public.profiles p ON sr.user_id = p.id
    ORDER BY sr.created_at DESC
  `);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Approve, Reject or Modify School request access
 */
const handleSchoolRequest = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // approuve, rejete, en_attente

  await query('UPDATE public.school_requests SET status = $1, updated_at = NOW() WHERE id = $2', [status, id]);
  res.json({ success: true, message: 'Statut de l\'école mis à jour avec succès.' });
});

/**
 * @desc    Toggle block a school request
 */
const toggleSchoolBlock = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // e.g. 'bloque' or 'en_attente'

  await query('UPDATE public.school_requests SET status = $1, updated_at = NOW() WHERE id = $2', [status, id]);
  res.json({ success: true, message: 'Statut de blocage école mis à jour.' });
});

/**
 * @desc    Get all school staff account requests for Admin
 */
const getAdminSchoolAccountRequests = asyncHandler(async (req, res) => {
  const result = await query(`
    SELECT sar.*, sr.school_name
    FROM public.school_account_requests sar
    JOIN public.school_requests sr ON sar.school_id = sr.id
    ORDER BY sar.created_at DESC
  `);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Approve school staff account request and create official account
 */
const approveAdminSchoolAccountRequest = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { action } = req.body; // approuve or rejete

  if (!['approuve', 'rejete'].includes(action)) {
    return res.status(400).json({ success: false, error: 'Action d’approbation invalide.' });
  }

  const check = await query('SELECT * FROM public.school_account_requests WHERE id = $1', [id]);
  if (check.rows.length === 0) return res.status(404).json({ success: false, error: 'Demande introuvable' });
  const staff = check.rows[0];

  if (staff.status !== 'en_attente') {
    return res.status(409).json({ success: false, error: 'Cette demande a déjà été traitée.' });
  }

  if (action === 'rejete') {
    await query("UPDATE public.school_account_requests SET status = 'rejete' WHERE id = $1", [id]);
    return res.json({ success: true, message: 'Demande rejetée.' });
  }

  // Mettre à jour le statut
  await query("UPDATE public.school_account_requests SET status = 'approuve' WHERE id = $1", [id]);

  res.json({
    success: true,
    message: 'Compte scolaire approuvé avec succès ! Code d\'accès unique généré : ' + staff.generated_code,
    code: staff.generated_code
  });
});

/**
 * @desc    Delete a school request
 */
const deleteSchoolRequest = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await query('DELETE FROM public.school_requests WHERE id = $1', [id]);
  res.json({ success: true, message: 'École supprimée avec succès.' });
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

  const canExecute = await processSensitiveAction(req, 'handle_market', id, business.business_name, { status, admin_notes }, 'market-requests', 'approve');
  if (!canExecute) return res.json({ success: true, pending: true, message: 'Demande de validation boutique mise en attente.' });

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
    const ownerRes = await query('SELECT full_name, email FROM public.profiles WHERE id = $1', [userId]);
    if (ownerRes.rows.length > 0) {
      await mailService.sendMarketApprovalEmail(
        ownerRes.rows[0].email,
        ownerRes.rows[0].full_name,
        business.business_name,
        business.category,
        groupName
      );
    } else {
      logger.warn(`Profil propriétaire introuvable pour le business approuvé ${id}.`);
    }

  } else {
    await query(
      'UPDATE public.market_businesses SET status = $1, rejection_reason = $2, updated_at = NOW() WHERE id = $3',
      ['rejected', admin_notes, id]
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

  const businessRes = await query('SELECT business_name, user_id FROM public.market_businesses WHERE id = $1', [id]);
  if (businessRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Business non trouvé' });

  const business = businessRes.rows[0];
  const newStatus = block ? 'blocked' : 'approved';

  const canExecute = await processSensitiveAction(req, 'toggle_market_block', id, business.business_name, { status: newStatus }, 'market-requests', 'delete');
  if (!canExecute) return res.json({ success: true, pending: true, message: `Action de ${block ? 'blocage' : 'déblocage'} boutique mise en attente.` });

  await query('UPDATE public.market_businesses SET status = $1, updated_at = NOW() WHERE id = $2', [newStatus, id]);

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

  const businessRes = await query('SELECT business_name, user_id FROM public.market_businesses WHERE id = $1', [id]);
  if (businessRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Business non trouvé' });

  const business = businessRes.rows[0];

  const canExecute = await processSensitiveAction(req, 'delete_market', id, business.business_name, { deleted: true }, 'market-requests', 'delete');
  if (!canExecute) return res.json({ success: true, pending: true, message: 'Demande de suppression de boutique mise en attente.' });

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
  const {
    full_name: providedName,
    fullName,
    email,
    username,
    avatar_url,
    modules,
    collab_start_at,
    collab_end_at,
    collabAdminRights = {},
    userAdminRights = {}
  } = req.body;
  const cleanName = typeof providedName === 'string' ? providedName.trim() : (typeof fullName === 'string' ? fullName.trim() : '');
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const cleanUsername = typeof username === 'string' ? username.trim().toLowerCase() : '';

  if (!cleanEmail || !cleanName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ success: false, error: 'Un nom et une adresse email valide sont obligatoires.' });
  }

  // Vérifier si l'utilisateur existe déjà
  const existing = await query(
    'SELECT id FROM public.profiles WHERE LOWER(email) = $1 OR ($2 <> \'\' AND LOWER(username) = $2)',
    [cleanEmail, cleanUsername]
  );
  if (existing.rows.length > 0) {
    return res.status(409).json({ success: false, error: 'Cet email ou nom d’utilisateur est déjà utilisé.' });
  }

  // Générer un mot de passe temporaire
  const tempPassword = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 caractères
  const hashedPassword = await bcrypt.hash(tempPassword, 10);
  const userId = crypto.randomUUID();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO public.profiles (id, full_name, email, password, username, avatar_url, is_collaborator, account_type, collab_start_at, collab_end_at, is_verified, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, 'collaborator', $7, $8, TRUE, TRUE)`,
      [userId, cleanName, cleanEmail, hashedPassword, cleanUsername || `${cleanEmail.split('@')[0]}_${userId.slice(0, 8)}`, avatar_url || null, collab_start_at || new Date(), collab_end_at || null]
    );

    await client.query(
      `INSERT INTO public.admin_delegations (user_id, modules, is_active, collab_admin_rights, user_admin_rights)
       VALUES ($1, $2, TRUE, $3, $4)`,
      [userId, Array.isArray(modules) ? modules : [], JSON.stringify(collabAdminRights), JSON.stringify(userAdminRights)]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(409).json({ success: false, error: 'Cet email ou nom d’utilisateur est déjà utilisé.' });
    }
    throw error;
  } finally {
    client.release();
  }

  // 3. Envoyer l'email avec le mot de passe temporaire
  const emailSent = await mailService.sendCollaboratorAccountEmail(cleanEmail, cleanName, tempPassword, 'collaborator');

  // 4. Ajouter à l'équipe par défaut si le module collaboration est présent
  if (Array.isArray(modules) && modules.includes('collaboration')) {
    try {
      const defaultTeamRes = await query("SELECT id FROM public.collab_teams WHERE name = 'Together Tech Community' LIMIT 1");
      if (defaultTeamRes.rows.length > 0) {
        await query(
          'INSERT INTO public.collab_team_members (team_id, user_id, role) VALUES ($1, $2, \'collaborator\') ON CONFLICT DO NOTHING',
          [defaultTeamRes.rows[0].id, userId]
        );
        logger.info(`✅ Collaborateur ${cleanName} ajouté à l'équipe par défaut.`);
      }
    } catch (err) {
      logger.error('Erreur lors de l\'ajout à l\'équipe par défaut:', err.message);
    }
  }

  await logAdminAction(req, 'create_collaborator', 'user', userId, { email: cleanEmail, full_name: cleanName, tempPassword_sent: emailSent });

  res.status(201).json({
    success: true,
    message: emailSent ? 'Compte collaborateur créé et email envoyé.' : 'Compte collaborateur créé, mais l’email n’a pas pu être envoyé.',
    data: { id: userId, emailSent, ...(emailSent ? {} : { temporaryPassword: tempPassword }) }
  });
});

/**
 * @desc    Mettre à jour un collaborateur
 */
const updateCollaborator = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { allowedModules, is_active } = req.body;

  await query(
    'UPDATE public.admin_delegations SET modules = $1, is_active = $2, updated_at = NOW() WHERE user_id = $3',
    [allowedModules || [], is_active !== undefined ? is_active : true, userId]
  );

  await logAdminAction(req, 'update_collaborator', 'collaborator', userId, { modules: allowedModules, isActive: is_active });
  res.json({ success: true, message: 'Compte collaborateur mis à jour.' });
});

/**
 * @desc    Supprimer un collaborateur (Soft delete avec date)
 */
const deleteCollaborator = asyncHandler(async (req, res) => {
  const { userId } = req.params;

  const userRes = await query('SELECT full_name, is_global_admin FROM public.profiles WHERE id = $1', [userId]);
  if (userRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Collaborateur non trouvé.' });
  if (userRes.rows[0].is_global_admin) return res.status(403).json({ success: false, error: 'Action interdite sur un admin global.' });

  const canExecute = await processSensitiveAction(req, 'delete_collaborator', userId, userRes.rows[0].full_name, { terminated: true }, 'collaboration', 'manage_teams');
  if (!canExecute) return res.json({ success: true, pending: true, message: 'Demande de fin de collaboration mise en attente.' });

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

/**
 * @desc    Get all recent content for moderation
 * @route   GET /api/admin/moderation/feed
 */
const getModerationFeed = asyncHandler(async (req, res) => {
  // 1. Fetch recent social statuses
  const statuses = await query(`
    SELECT s.*, p.full_name as author_name, p.email as author_email, p.avatar_url as author_avatar, 'social' as content_type
    FROM public.statuses s
    JOIN public.profiles p ON s.user_id = p.id
    WHERE p.is_global_admin = FALSE
    ORDER BY s.created_at DESC LIMIT 30
  `);

  // 2. Fetch recent market posts
  const market = await query(`
    SELECT mp.*, b.business_name as author_name, p.email as author_email, b.logo_url as author_avatar, 'market' as content_type
    FROM public.market_posts mp
    JOIN public.market_businesses b ON mp.business_id = b.id
    JOIN public.profiles p ON b.user_id = p.id
    WHERE p.is_global_admin = FALSE
    ORDER BY mp.created_at DESC LIMIT 30
  `);

  // 3. Fetch recent job postings
  const jobs = await query(`
    SELECT jp.*, b.company_name as author_name, p.email as author_email, b.logo_url as author_avatar, 'job' as content_type
    FROM public.job_postings jp
    JOIN public.employer_profiles b ON jp.employer_id = b.id
    JOIN public.profiles p ON b.user_id = p.id
    WHERE p.is_global_admin = FALSE
    ORDER BY jp.created_at DESC LIMIT 30
  `);

  res.json({
    success: true,
    data: {
      social: statuses.rows,
      market: market.rows,
      jobs: jobs.rows
    }
  });
});

/**
 * @desc    Moderate content (Delete, Correction, Boost)
 * @route   POST /api/admin/moderation/action
 */
const moderateContent = asyncHandler(async (req, res) => {
  const { contentId, contentType, action, reason, contentTitle, authorEmail, authorName } = req.body;

  if (!contentId || !contentType || !action) {
    return res.status(400).json({ success: false, error: 'Informations manquantes' });
  }

  let tableName = "";
  if (contentType === 'social') tableName = "public.statuses";
  else if (contentType === 'market') tableName = "public.market_posts";
  else if (contentType === 'job') tableName = "public.job_postings";

  if (!tableName) return res.status(400).json({ success: false, error: 'Type de contenu invalide' });

  try {
    if (action === 'delete') {
      await query(`DELETE FROM ${tableName} WHERE id = $1`, [contentId]);

      // Notifier par email
      if (authorEmail) {
        await mailService.sendModerationAlertEmail(authorEmail, authorName || 'Utilisateur', contentType, contentTitle || 'votre publication', 'deleted', reason);
      }

      await logAdminAction(req, `moderate_delete_${contentType}`, contentType, contentId, { reason });
    }
    else if (action === 'correction') {
      // Pour correction, on pourrait par exemple passer le contenu en 'draft' ou 'pending'
      // Ici on va juste envoyer le mail et laisser le contenu (ou on pourrait ajouter une colonne 'moderation_status')
      if (authorEmail) {
        await mailService.sendModerationAlertEmail(authorEmail, authorName || 'Utilisateur', contentType, contentTitle || 'votre publication', 'correction_required', reason);
      }
      await logAdminAction(req, `moderate_correction_${contentType}`, contentType, contentId, { reason });
    }
    else if (action === 'boost') {
      await query(`UPDATE ${tableName} SET is_boosted = NOT is_boosted, updated_at = NOW() WHERE id = $1`, [contentId]);
      await logAdminAction(req, `moderate_boost_${contentType}`, contentType, contentId);
    }

    // Informer via socket pour mise à jour temps réel
    socketService.broadcast('admin:content_moderated', { contentId, contentType, action });

    res.json({ success: true, message: 'Action de modération effectuée avec succès.' });

  } catch (error) {
    logger.error('Moderation Error:', error.message);
    res.status(500).json({ success: false, error: 'Erreur lors de la modération' });
  }
});

/**
 * @desc    Get all pending employer requests
 * @route   GET /api/admin/employer-requests
 */
const getEmployerRequests = asyncHandler(async (req, res) => {
  const hasReadPerm = req.user.is_global_admin || (req.user.granular_permissions && req.user.granular_permissions['employer-requests'] && req.user.granular_permissions['employer-requests'].includes('read'));
  if (!hasReadPerm) {
    return res.status(403).json({ success: false, error: 'Accès refusé : Vous n\'avez pas le droit de voir les demandes Employeur.' });
  }

  const result = await query(`
    SELECT er.*, p.full_name as user_name, p.email as user_email
    FROM public.employer_requests er
    JOIN public.profiles p ON er.user_id = p.id
    ORDER BY er.created_at DESC
  `);
  res.json({ success: true, data: result.rows });
});

/**
 * @desc    Approve or reject employer request
 * @route   PUT /api/admin/employer-requests/:id
 */
const handleEmployerRequest = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, admin_notes } = req.body; // 'approved' or 'rejected'

  const requestRes = await query('SELECT * FROM public.employer_requests WHERE id = $1', [id]);
  if (requestRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Demande introuvable' });

  const request = requestRes.rows[0];

  const canExecute = await processSensitiveAction(req, 'handle_employer', id, request.company_name, {
      status,
      admin_notes,
      userId: request.user_id,
      email: request.company_email,
      industry: request.industry
  }, 'employer-requests', 'approve');
  if (!canExecute) return res.json({ success: true, pending: true, message: 'Demande employeur mise en attente.' });

  if (status === 'approved') {
    await query(
      "UPDATE public.employer_requests SET status = 'approved', updated_at = NOW() WHERE id = $1",
      [id]
    );

    // Create employer profile
    await query(
      `INSERT INTO public.employer_profiles (user_id, request_id, company_name, company_email, industry)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET is_active = true`,
      [request.user_id, id, request.company_name, request.company_email, request.industry]
    );

    // Get user info for email
    const userRes = await query('SELECT full_name, email FROM public.profiles WHERE id = $1', [request.user_id]);
    if (userRes.rows.length > 0) {
      await mailService.sendEmployerApprovalEmail(userRes.rows[0].email, userRes.rows[0].full_name, request.company_name);
    }

    // Force real-time refresh on client side
    socketService.emitToUser(request.user_id, 'employer:request_approved', {
      companyName: request.company_name
    });

  } else {
    await query(
      "UPDATE public.employer_requests SET status = 'rejected', updated_at = NOW() WHERE id = $2",
      [id]
    );
  }

  await logAdminAction(req, `employer_request_${status}`, 'employer', id, { companyName: request.company_name });
  res.json({ success: true, message: `Demande ${status === 'approved' ? 'approuvée' : 'rejetée'}.` });
});

module.exports = {
  getStats,
  getUsers,
  getReports,
  resolveReport,
  deleteUser,
  scheduleUserDeletion,
  cancelScheduledUserDeletion,
  sendUserSecurityNotice,
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
  getUsageAnalytics,
  getCampaigns,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  resendCampaign,
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
  getSchoolRequests,
  handleSchoolRequest,
  toggleSchoolBlock,
  deleteSchoolRequest,
  getAdminSchoolAccountRequests,
  approveAdminSchoolAccountRequest,
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
  getManagedAccounts,
  createManagedAccount,
  saveDelegation,
  createCollaborator,
  updateCollaborator,
  deleteCollaborator,
  getModerationFeed,
  moderateContent,
  getEmployerRequests,
  handleEmployerRequest,
  resetUserPassword,
  ensureAdminTables,
  ensureScheduledUserDeletionsTable,
  processSensitiveAction
};
