const { query } = require('../config/db');
const { asyncHandler } = require('../middleware/error.middleware');
const socketService = require('../services/socket.service');
const adminController = require('./admin.controller');

let tableInitialization;

const ensureAnnouncementsTable = () => {
  if (!tableInitialization) {
    tableInitialization = query(`
      CREATE TABLE IF NOT EXISTS public.app_announcements (
        id BIGSERIAL PRIMARY KEY,
        title VARCHAR(160) NOT NULL,
        content TEXT NOT NULL,
        type VARCHAR(20) NOT NULL DEFAULT 'info'
          CHECK (type IN ('info', 'update', 'maintenance', 'important')),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        expires_at TIMESTAMP WITH TIME ZONE,
        created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `).then(() => query(`
      CREATE INDEX IF NOT EXISTS app_announcements_active_updated_idx
      ON public.app_announcements (is_active, updated_at DESC)
    `)).catch((error) => {
      tableInitialization = null;
      throw error;
    });
  }
  return tableInitialization;
};

const canReadAnnouncements = (req) => (
  req.user?.is_global_admin ||
  req.user?.granular_permissions?.campaigns?.includes('read')
);

const canManageAnnouncements = (req, permission) => (
  req.user?.is_global_admin ||
  req.user?.granular_permissions?.campaigns?.includes(permission)
);

const parseAnnouncementId = (id) => (/^[1-9]\d*$/.test(String(id)) ? id : null);

const validateAnnouncement = (body) => {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const type = body.type || 'info';
  const validTypes = ['info', 'update', 'maintenance', 'important'];

  if (!title || title.length > 160) return { error: 'Le titre est requis et ne peut pas dépasser 160 caractères.' };
  if (!content || content.length > 4000) return { error: 'Le message est requis et ne peut pas dépasser 4 000 caractères.' };
  if (!validTypes.includes(type)) return { error: 'Le type d’annonce est invalide.' };

  let expiresAt = null;
  if (body.expiresAt) {
    expiresAt = new Date(body.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) return { error: 'La date d’expiration est invalide.' };
  }

  return {
    value: {
      title,
      content,
      type,
      isActive: body.isActive !== false,
      expiresAt,
    },
  };
};

const getActiveAnnouncements = asyncHandler(async (req, res) => {
  await ensureAnnouncementsTable();
  const result = await query(`
    SELECT id, title, content, type, updated_at, expires_at
    FROM public.app_announcements
    WHERE is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY updated_at DESC
    LIMIT 10
  `);
  res.json({ success: true, data: result.rows });
});

const getAnnouncements = asyncHandler(async (req, res) => {
  if (!canReadAnnouncements(req)) {
    return res.status(403).json({ success: false, error: 'Accès refusé : permission de lecture des annonces requise.' });
  }

  await ensureAnnouncementsTable();
  const result = await query(`
    SELECT a.id, a.title, a.content, a.type, a.is_active, a.expires_at, a.created_at, a.updated_at,
           p.full_name AS author_name
    FROM public.app_announcements a
    LEFT JOIN public.profiles p ON p.id = a.created_by
    ORDER BY a.created_at DESC
    LIMIT 100
  `);
  res.json({ success: true, data: result.rows });
});

const createAnnouncement = asyncHandler(async (req, res) => {
  if (!canManageAnnouncements(req, 'create')) {
    return res.status(403).json({ success: false, error: 'Accès refusé : permission de publication des annonces requise.' });
  }

  const validation = validateAnnouncement(req.body);
  if (validation.error) return res.status(400).json({ success: false, error: validation.error });

  const { title, content, type, isActive, expiresAt } = validation.value;
  const canExecute = await adminController.processSensitiveAction(
    req,
    'create_announcement',
    null,
    title,
    { title, content, type, isActive, expiresAt },
    'campaigns',
    'create'
  );
  if (!canExecute) {
    return res.status(202).json({ success: true, pending: true, message: 'La publication de cette annonce attend l’approbation de l’administrateur principal.' });
  }

  await ensureAnnouncementsTable();
  const result = await query(`
    INSERT INTO public.app_announcements (title, content, type, is_active, expires_at, created_by)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, title, content, type, is_active, expires_at, created_at, updated_at
  `, [title, content, type, isActive, expiresAt, req.userId]);

  const announcement = result.rows[0];
  socketService.broadcast('announcement_updated', { action: 'created', announcement });
  res.status(201).json({ success: true, data: announcement, message: 'Annonce publiée.' });
});

const updateAnnouncement = asyncHandler(async (req, res) => {
  if (!canManageAnnouncements(req, 'create')) {
    return res.status(403).json({ success: false, error: 'Accès refusé : permission de gestion des annonces requise.' });
  }
  const id = parseAnnouncementId(req.params.id);
  if (!id) return res.status(400).json({ success: false, error: 'Identifiant d’annonce invalide.' });

  const validation = validateAnnouncement(req.body);
  if (validation.error) return res.status(400).json({ success: false, error: validation.error });

  const { title, content, type, isActive, expiresAt } = validation.value;
  const canExecute = await adminController.processSensitiveAction(
    req,
    'update_announcement',
    id,
    title,
    { title, content, type, isActive, expiresAt },
    'campaigns',
    'create'
  );
  if (!canExecute) {
    return res.status(202).json({ success: true, pending: true, message: 'La modification de cette annonce attend l’approbation de l’administrateur principal.' });
  }

  await ensureAnnouncementsTable();
  const result = await query(`
    UPDATE public.app_announcements
    SET title = $1, content = $2, type = $3, is_active = $4, expires_at = $5, updated_at = NOW()
    WHERE id = $6
    RETURNING id, title, content, type, is_active, expires_at, created_at, updated_at
  `, [title, content, type, isActive, expiresAt, id]);

  if (!result.rows.length) return res.status(404).json({ success: false, error: 'Annonce introuvable.' });

  const announcement = result.rows[0];
  socketService.broadcast('announcement_updated', { action: 'updated', announcement });
  res.json({ success: true, data: announcement, message: 'Annonce mise à jour.' });
});

const deleteAnnouncement = asyncHandler(async (req, res) => {
  if (!canManageAnnouncements(req, 'delete')) {
    return res.status(403).json({ success: false, error: 'Accès refusé : permission de suppression des annonces requise.' });
  }
  const id = parseAnnouncementId(req.params.id);
  if (!id) return res.status(400).json({ success: false, error: 'Identifiant d’annonce invalide.' });

  const canExecute = await adminController.processSensitiveAction(
    req,
    'delete_announcement',
    id,
    `Annonce #${id}`,
    { deleted: true },
    'campaigns',
    'delete'
  );
  if (!canExecute) {
    return res.status(202).json({ success: true, pending: true, message: 'La suppression de cette annonce attend l’approbation de l’administrateur principal.' });
  }

  await ensureAnnouncementsTable();
  const result = await query(
    'DELETE FROM public.app_announcements WHERE id = $1 RETURNING id',
    [id]
  );
  if (!result.rows.length) return res.status(404).json({ success: false, error: 'Annonce introuvable.' });

  socketService.broadcast('announcement_updated', { action: 'deleted', id: result.rows[0].id });
  res.json({ success: true, message: 'Annonce supprimée.' });
});

module.exports = {
  ensureAnnouncementsTable,
  getActiveAnnouncements,
  getAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
};
