const axios = require('axios');
const crypto = require('crypto');
const NodeCache = require('node-cache');
const { pool, query } = require('../config/db');
const { asyncHandler } = require('../middleware/error.middleware');
const logger = require('../utils/logger');
const notificationService = require('../services/notification.service');
const socketService = require('../services/socket.service');

const directoryCache = new NodeCache({ stdTTL: 6 * 60 * 60, checkperiod: 600 });
const geocodeCache = new NodeCache({ stdTTL: 24 * 60 * 60, checkperiod: 3600 });
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const nominatimUrl = 'https://nominatim.openstreetmap.org/search';
const overpassUrl = 'https://overpass-api.de/api/interpreter';
const searchRadiusMeters = 12000;
const maxResults = 80;
let nominatimQueue = Promise.resolve();
let lastNominatimRequestAt = 0;

const withNominatimRateLimit = (request) => {
  const result = nominatimQueue.then(async () => {
    const waitMs = Math.max(0, 1000 - (Date.now() - lastNominatimRequestAt));
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastNominatimRequestAt = Date.now();
    return request();
  });
  nominatimQueue = result.then(() => undefined, () => undefined);
  return result;
};

const searchLocation = async (location) => {
  const cacheKey = location.toLowerCase().replace(/\s+/g, ' ');
  const cached = geocodeCache.get(cacheKey);
  if (cached) return cached;

  const params = { q: location, format: 'jsonv2', addressdetails: 1, limit: 1 };
  if (process.env.OSM_CONTACT_EMAIL) params.email = process.env.OSM_CONTACT_EMAIL;
  const contact = process.env.OSM_CONTACT_EMAIL ? `; contact: ${process.env.OSM_CONTACT_EMAIL}` : '';
  const response = await withNominatimRateLimit(() => axios.get(nominatimUrl, {
    params,
    timeout: 10000,
    headers: {
      'User-Agent': `TogetherTechMeetMe/1.0 (school directory${contact})`
    }
  }));
  const place = response.data?.[0];
  if (!place || !Number.isFinite(Number(place.lat)) || !Number.isFinite(Number(place.lon))) return null;

  const result = {
    latitude: Number(place.lat),
    longitude: Number(place.lon),
    displayName: place.display_name,
    city: place.address?.city || place.address?.town || place.address?.village
      || place.address?.municipality || place.address?.county || '',
    country: place.address?.country || ''
  };
  geocodeCache.set(cacheKey, result);
  return result;
};

const getSchoolType = (tags) => {
  const type = tags.amenity || tags.school || tags.building || 'school';
  const labels = {
    school: 'École',
    university: 'Université',
    college: 'Institut / Collège',
    kindergarten: 'Maternelle',
    language_school: 'École de langues',
    driving_school: 'Auto-école'
  };
  return labels[type] || 'Établissement scolaire';
};

const formatSchool = (element, place) => {
  const tags = element.tags || {};
  const latitude = Number(element.lat ?? element.center?.lat);
  const longitude = Number(element.lon ?? element.center?.lon);
  if (!tags.name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  const city = tags['addr:city'] || tags['addr:town'] || tags['addr:village'] || place.city;
  const address = [street, tags['addr:suburb'], city, tags['addr:postcode']]
    .filter((part, index, parts) => part && parts.indexOf(part) === index)
    .join(', ');

  return {
    id: `${element.type}/${element.id}`,
    name: tags.name,
    type: getSchoolType(tags),
    city,
    country: tags['addr:country'] || place.country,
    address,
    website: tags.website || tags['contact:website'] || null,
    phone: tags.phone || tags['contact:phone'] || null,
    latitude,
    longitude,
    source: 'OpenStreetMap'
  };
};

const persistOsmSchools = async (schools) => {
  if (!schools.length) return [];

  await query(
    `INSERT INTO public.schools (
       external_id, name, school_type, country, city, address, phone, website,
       latitude, longitude, source, status, updated_at
     )
     SELECT item.external_id, item.name, item.school_type, item.country, item.city,
            item.address, item.phone, item.website, item.latitude, item.longitude,
            'openstreetmap', 'active', NOW()
     FROM jsonb_to_recordset($1::jsonb) AS item(
       external_id TEXT, name TEXT, school_type TEXT, country TEXT, city TEXT,
       address TEXT, phone TEXT, website TEXT, latitude NUMERIC, longitude NUMERIC
     )
     ON CONFLICT (external_id) DO UPDATE SET
       name = EXCLUDED.name,
       school_type = EXCLUDED.school_type,
       country = EXCLUDED.country,
       city = EXCLUDED.city,
       address = EXCLUDED.address,
       phone = EXCLUDED.phone,
       website = EXCLUDED.website,
       latitude = EXCLUDED.latitude,
       longitude = EXCLUDED.longitude,
       source = 'openstreetmap',
       updated_at = NOW()`,
    [JSON.stringify(schools.map((school) => ({
      external_id: school.id,
      name: school.name,
      school_type: school.type,
      country: school.country || null,
      city: school.city || null,
      address: school.address || null,
      phone: school.phone,
      website: school.website,
      latitude: school.latitude,
      longitude: school.longitude
    })))]
  );

  const result = await query(
    `SELECT external_id, is_partner, claimed
     FROM public.schools
     WHERE external_id = ANY($1::text[])`,
    [schools.map((school) => school.id)]
  );
  const statuses = new Map(result.rows.map((row) => [row.external_id, row]));
  return schools.map((school) => ({
    ...school,
    isPartner: Boolean(statuses.get(school.id)?.is_partner),
    claimed: Boolean(statuses.get(school.id)?.claimed)
  }));
};

const searchSchools = asyncHandler(async (req, res) => {
  const location = typeof req.query.location === 'string' ? req.query.location.trim() : '';
  if (location.length < 2 || location.length > 120) {
    return res.status(400).json({
      success: false,
      error: 'Indiquez une ville ou une localité (2 à 120 caractères).'
    });
  }

  const cacheKey = location.toLowerCase().replace(/\s+/g, ' ');
  const cached = directoryCache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, cached: true });

  let place;
  let elements = [];
  try {
    place = await searchLocation(location);
    if (place) {
      const lat = place.latitude.toFixed(5);
      const lon = place.longitude.toFixed(5);
      const query = `[out:json][timeout:20];(node(around:${searchRadiusMeters},${lat},${lon})["amenity"~"^(school|university|college|kindergarten|language_school|driving_school)$"];way(around:${searchRadiusMeters},${lat},${lon})["amenity"~"^(school|university|college|kindergarten|language_school|driving_school)$"];relation(around:${searchRadiusMeters},${lat},${lon})["amenity"~"^(school|university|college|kindergarten|language_school|driving_school)$"];node(around:${searchRadiusMeters},${lat},${lon})["office"="educational_institution"];way(around:${searchRadiusMeters},${lat},${lon})["office"="educational_institution"];relation(around:${searchRadiusMeters},${lat},${lon})["office"="educational_institution"];);out tags center ${maxResults};`;
      const response = await axios.post(overpassUrl, `data=${encodeURIComponent(query)}`, {
        timeout: 25000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': `TogetherTechMeetMe/1.0 (school directory${process.env.OSM_CONTACT_EMAIL ? `; contact: ${process.env.OSM_CONTACT_EMAIL}` : ''})`
        }
      });
      elements = Array.isArray(response.data?.elements) ? response.data.elements : [];
    }
  } catch (error) {
    logger.warn(`School directory provider request failed for "${location}": ${error.message}`);
    return res.status(503).json({
      success: false,
      error: 'Le service cartographique est temporairement indisponible. Réessayez dans quelques instants.'
    });
  }

  const osmSchools = place
    ? elements
      .map((element) => formatSchool(element, place))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    : [];
  let schools;
  try {
    schools = await persistOsmSchools(osmSchools);
    if (place?.city && place?.country) {
      const localResult = await query(
        `SELECT id, name, school_type, country, city, address, phone, website,
                latitude, longitude, source, is_partner, claimed
         FROM public.schools
         WHERE external_id IS NULL AND status = 'active'
           AND LOWER(city) = LOWER($1) AND LOWER(country) = LOWER($2)`,
        [place.city, place.country]
      );
      const schoolKeys = new Map(
        schools.map((school, index) => [`${school.name.toLowerCase()}|${school.city.toLowerCase()}`, index])
      );
      for (const row of localResult.rows) {
        const key = `${row.name.toLowerCase()}|${String(row.city || '').toLowerCase()}`;
        const existingIndex = schoolKeys.get(key);
        if (existingIndex !== undefined) {
          schools[existingIndex].isPartner ||= Boolean(row.is_partner);
          schools[existingIndex].claimed ||= Boolean(row.claimed);
          continue;
        }
        schools.push({
          id: `local/${row.id}`,
          name: row.name,
          type: row.school_type || 'Établissement scolaire',
          city: row.city,
          country: row.country,
          address: row.address || '',
          website: row.website,
          phone: row.phone,
          latitude: row.latitude === null ? null : Number(row.latitude),
          longitude: row.longitude === null ? null : Number(row.longitude),
          source: row.source,
          isPartner: Boolean(row.is_partner),
          claimed: Boolean(row.claimed)
        });
      }
      schools.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    }
  } catch (error) {
    logger.error(`Unable to persist OpenStreetMap school results for "${location}": ${error.message}`);
    return res.status(503).json({
      success: false,
      error: 'Impossible d’enregistrer les résultats pour le moment. Réessayez plus tard.'
    });
  }
  const data = {
    location,
    resolvedLocation: place?.displayName,
    schools,
    attribution: '© OpenStreetMap contributors'
  };
  directoryCache.set(cacheKey, data);
  return res.json({ success: true, data });
});

const proposeSchool = asyncHandler(async (req, res) => {
  const cleanText = (value, maxLength) => (
    typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
  );
  const name = cleanText(req.body.name, 180);
  const schoolType = cleanText(req.body.schoolType, 80);
  const country = cleanText(req.body.country, 100);
  const city = cleanText(req.body.city, 120);
  const address = cleanText(req.body.address, 500);
  const phone = cleanText(req.body.phone, 50);
  const website = cleanText(req.body.website, 255);

  if (!name || !country || !city) {
    return res.status(400).json({
      success: false,
      error: 'Le nom de l’établissement, le pays et la ville sont obligatoires.'
    });
  }
  if (website && !/^https?:\/\/\S+$/i.test(website)) {
    return res.status(400).json({ success: false, error: 'Le site web doit commencer par http:// ou https://.' });
  }

  const result = await query(
    `INSERT INTO public.school_directory_proposals
       (submitted_by, name, school_type, country, city, address, phone, website)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, school_type, country, city, status, created_at`,
    [req.userId, name, schoolType || null, country, city, address || null, phone || null, website || null]
  );

  try {
    await socketService.persistAdminNotification(
      'school_directory_proposal',
      'Nouvelle école proposée',
      `${name} — ${city}, ${country}`,
      result.rows[0].id,
      { proposalStatus: 'pending' }
    );
  } catch (error) {
    logger.error(`Unable to notify admins about school proposal ${result.rows[0].id}: ${error.message}`);
  }

  return res.status(201).json({
    success: true,
    data: result.rows[0],
    message: 'Votre proposition a été transmise à l’équipe pour vérification.'
  });
});

const reviewSchoolProposal = asyncHandler(async (req, res) => {
  if (!req.user?.is_global_admin) {
    return res.status(403).json({ success: false, error: 'Cette action est réservée à l’administrateur principal.' });
  }

  const status = req.body.status;
  if (!['accepted', 'rejected'].includes(status)) {
    return res.status(400).json({ success: false, error: 'La décision doit être accepted ou rejected.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const proposalResult = await client.query(
      `UPDATE public.school_directory_proposals
       SET status = $1, reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $3 AND status = 'pending'
       RETURNING id, name, school_type, country, city, address, phone, website`,
      [status, req.userId, req.params.proposalId]
    );
    if (proposalResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Proposition introuvable ou déjà traitée.' });
    }

    const proposal = proposalResult.rows[0];
    if (status === 'accepted') {
      await client.query(
        `INSERT INTO public.schools (name, school_type, country, city, address, phone, website, source, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'community', 'active')`,
        [proposal.name, proposal.school_type, proposal.country, proposal.city, proposal.address, proposal.phone, proposal.website]
      );
    }

    await client.query(
      `UPDATE public.admin_notifications
       SET metadata = metadata || jsonb_build_object('proposalStatus', $1::text)
       WHERE source_type = 'school_directory_proposal' AND source_id = $2`,
      [status, proposal.id]
    );
    await client.query('COMMIT');

    directoryCache.flushAll();
    return res.json({
      success: true,
      message: status === 'accepted' ? 'Établissement ajouté au répertoire.' : 'Proposition refusée.',
      data: { id: proposal.id, status }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

const submitSchoolClaim = asyncHandler(async (req, res) => {
  const cleanText = (value, maxLength) => (
    typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
  );
  const schoolRef = typeof req.params.schoolRef === 'string' ? req.params.schoolRef : '';
  const osmIdMatch = schoolRef.match(/^(node|way|relation)\/(\d+)$/);
  const localIdMatch = schoolRef.match(/^local\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (!osmIdMatch && !localIdMatch) {
    return res.status(400).json({ success: false, error: 'Référence d’établissement invalide.' });
  }

  const fullName = cleanText(req.body.fullName, 180);
  const role = cleanText(req.body.role, 100);
  const officialEmail = cleanText(req.body.officialEmail, 255).toLowerCase();
  const phone = cleanText(req.body.phone, 50);
  const evidence = cleanText(req.body.evidence, 1200);
  if (!fullName || !role || !officialEmail || !phone || !evidence) {
    return res.status(400).json({
      success: false,
      error: 'Tous les champs sont requis, y compris les informations permettant de vérifier votre mandat.'
    });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(officialEmail)) {
    return res.status(400).json({ success: false, error: 'Adresse e-mail officielle invalide.' });
  }

  const schoolResult = osmIdMatch
    ? await query('SELECT id, name, city, country, is_partner, claimed FROM public.schools WHERE external_id = $1 AND status = \'active\'', [schoolRef])
    : await query('SELECT id, name, city, country, is_partner, claimed FROM public.schools WHERE id = $1 AND status = \'active\'', [localIdMatch[1]]);
  if (schoolResult.rows.length === 0) {
    return res.status(404).json({ success: false, error: 'Établissement introuvable. Relancez la recherche puis réessayez.' });
  }

  const school = schoolResult.rows[0];
  if (school.is_partner || school.claimed) {
    return res.status(409).json({ success: false, error: 'Cet établissement est déjà partenaire ou réclamé.' });
  }

  try {
    const result = await query(
      `INSERT INTO public.school_directory_claims
         (school_id, submitted_by, full_name, role, official_email, phone, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, school_id, full_name, role, official_email, phone, status, created_at`,
      [school.id, req.userId, fullName, role, officialEmail, phone, evidence]
    );
    const claim = result.rows[0];

    try {
      await socketService.persistAdminNotification(
        'school_directory_claim',
        'Demande de réclamation d’école',
        `${school.name} — ${fullName}, ${role} (${school.city}, ${school.country})`,
        claim.id,
        {
          claimStatus: 'pending',
          schoolId: school.id,
          officialEmail,
          phone,
          evidence,
          submittedBy: req.userId
        }
      );
    } catch (error) {
      logger.error(`Unable to notify admins about school claim ${claim.id}: ${error.message}`);
    }

    return res.status(201).json({
      success: true,
      data: claim,
      message: 'Votre demande de réclamation a été transmise à l’équipe pour vérification.'
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        error: 'Une demande de réclamation est déjà en cours pour cet établissement.'
      });
    }
    throw error;
  }
});

const reviewSchoolClaim = asyncHandler(async (req, res) => {
  if (!req.user?.is_global_admin) {
    return res.status(403).json({ success: false, error: 'Cette action est réservée à l’administrateur principal.' });
  }

  const status = req.body.status;
  if (!['accepted', 'rejected'].includes(status)) {
    return res.status(400).json({ success: false, error: 'La décision doit être accepted ou rejected.' });
  }

  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const claimResult = await client.query(
      `UPDATE public.school_directory_claims
       SET status = $1, reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $3 AND status = 'pending'
       RETURNING id, school_id, submitted_by, full_name, official_email, phone`,
      [status, req.userId, req.params.claimId]
    );
    if (claimResult.rows.length === 0) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return res.status(404).json({ success: false, error: 'Demande introuvable ou déjà traitée.' });
    }

    const claim = claimResult.rows[0];
    if (status === 'accepted') {
      const schoolResult = await client.query(
        `SELECT id, name, school_type, country, city, address, phone, is_partner, claimed
         FROM public.schools WHERE id = $1 FOR UPDATE`,
        [claim.school_id]
      );
      if (schoolResult.rows.length === 0) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(404).json({ success: false, error: 'Établissement introuvable.' });
      }

      const school = schoolResult.rows[0];
      if (school.is_partner || school.claimed) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(409).json({ success: false, error: 'Cet établissement est déjà partenaire ou réclamé.' });
      }

      const existingRequest = await client.query(
        `SELECT id, directory_school_id
         FROM public.school_requests
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [claim.submitted_by]
      );
      if (existingRequest.rows.length
        && existingRequest.rows[0].directory_school_id
        && existingRequest.rows[0].directory_school_id !== school.id) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(409).json({
          success: false,
          error: 'Ce compte possède déjà un espace scolaire. Utilisez le compte responsable de cet établissement ou contactez le support.'
        });
      }

      if (existingRequest.rows.length) {
        await client.query(
          `UPDATE public.school_requests
           SET school_name = $1, school_email = $2, school_phone = $3, school_address = $4,
               school_type = COALESCE($5, school_type), status = 'approuve',
               directory_school_id = $7, updated_at = NOW()
           WHERE id = $6`,
          [school.name, claim.official_email, claim.phone, school.address, school.school_type, existingRequest.rows[0].id, school.id]
        );
      } else {
        await client.query(
          `INSERT INTO public.school_requests
             (user_id, school_name, school_email, school_phone, school_address, school_type, status, directory_school_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'approuve', $7)`,
          [claim.submitted_by, school.name, claim.official_email, claim.phone, school.address, school.school_type, school.id]
        );
      }

      await client.query(
        `UPDATE public.schools
         SET is_partner = TRUE, claimed = TRUE, claimed_by = $1, claimed_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [claim.submitted_by, school.id]
      );
    }

    await client.query(
      `UPDATE public.admin_notifications
       SET metadata = metadata || jsonb_build_object('claimStatus', $1::text)
       WHERE source_type = 'school_directory_claim' AND source_id = $2`,
      [status, claim.id]
    );
    await client.query('COMMIT');
    transactionOpen = false;

    directoryCache.flushAll();
    return res.json({
      success: true,
      message: status === 'accepted'
        ? 'École vérifiée et partenaire activée. Le responsable peut accéder au tableau de bord École.'
        : 'Demande de réclamation refusée.',
      data: { id: claim.id, status }
    });
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

const getSchoolClaimStatus = asyncHandler(async (req, res) => {
  const schoolRef = typeof req.params.schoolRef === 'string' ? req.params.schoolRef : '';
  const osmIdMatch = schoolRef.match(/^(node|way|relation)\/(\d+)$/);
  const localIdMatch = schoolRef.match(/^local\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (!osmIdMatch && !localIdMatch) {
    return res.status(400).json({ success: false, error: 'Référence d’établissement invalide.' });
  }

  const schoolResult = osmIdMatch
    ? await query('SELECT id FROM public.schools WHERE external_id = $1 AND status = \'active\'', [schoolRef])
    : await query('SELECT id FROM public.schools WHERE id = $1 AND status = \'active\'', [localIdMatch[1]]);
  if (schoolResult.rows.length === 0) {
    return res.status(404).json({ success: false, error: 'Établissement introuvable.' });
  }

  const result = await query(
    `SELECT status, created_at
     FROM public.school_directory_claims
     WHERE school_id = $1 AND submitted_by = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [schoolResult.rows[0].id, req.userId]
  );
  return res.json({ success: true, data: result.rows[0] || null });
});

const resolveAdmissionSchool = async (req) => {
  if (req.schoolSession) {
    if (req.schoolSession.role !== 'directeur') return null;
    const result = await query(
      `SELECT sr.id AS school_request_id, sr.directory_school_id AS school_id,
              s.name AS school_name, s.claimed_by AS owner_id
       FROM public.school_requests sr
       JOIN public.schools s ON s.id = sr.directory_school_id
       WHERE sr.id = $1 AND LOWER(sr.status) IN ('approuve', 'approuvé')
         AND s.is_partner = TRUE AND s.claimed = TRUE AND s.status = 'active'`,
      [req.schoolSession.schoolId]
    );
    return result.rows[0] || null;
  }

  const result = await query(
    `SELECT sr.id AS school_request_id, sr.directory_school_id AS school_id,
            s.name AS school_name, s.claimed_by AS owner_id
     FROM public.school_requests sr
     JOIN public.schools s ON s.id = sr.directory_school_id
     WHERE sr.user_id = $1 AND LOWER(sr.status) IN ('approuve', 'approuvé')
       AND s.is_partner = TRUE AND s.claimed = TRUE AND s.status = 'active'
     ORDER BY sr.created_at DESC
     LIMIT 1`,
    [req.userId]
  );
  return result.rows[0] || null;
};

const insertAdmissionNotification = async (client, recipientId, applicationId, title, body) => {
  await client.query(
    `INSERT INTO public.school_admission_notifications (recipient_id, application_id, title, body)
     VALUES ($1, $2, $3, $4)`,
    [recipientId, applicationId, title, body]
  );
};

const sendAdmissionNotification = async (recipientId, applicationId, title, body) => {
  try {
    const result = await query('SELECT push_token FROM public.profiles WHERE id = $1', [recipientId]);
    socketService.sendToUser(recipientId, 'school:admission_notification', {
      applicationId,
      title,
      body
    });
    const pushToken = result.rows[0]?.push_token;
    if (pushToken) {
      await notificationService.sendNotification(pushToken, {
        title,
        body,
        data: { type: 'school_admission', applicationId }
      });
    }
  } catch (error) {
    logger.error(`Unable to deliver admission notification for application ${applicationId}: ${error.message}`);
  }
};

const submitSchoolAdmission = asyncHandler(async (req, res) => {
  const schoolRef = typeof req.params.schoolRef === 'string' ? req.params.schoolRef : '';
  const osmIdMatch = schoolRef.match(/^(node|way|relation)\/(\d+)$/);
  const localIdMatch = schoolRef.match(/^local\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (!osmIdMatch && !localIdMatch) {
    return res.status(400).json({ success: false, error: 'Référence d’établissement invalide.' });
  }

  const cleanText = (value, maxLength) => (
    typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
  );
  const fullName = cleanText(req.body.fullName, 180);
  const email = cleanText(req.body.email, 255).toLowerCase();
  const phone = cleanText(req.body.phone, 50);
  const currentLevel = cleanText(req.body.currentLevel, 120);
  const requestedProgram = cleanText(req.body.requestedProgram, 180);
  const motivation = cleanText(req.body.motivation, 2000);
  if (!fullName || !email || !phone || !currentLevel || !requestedProgram || !motivation) {
    return res.status(400).json({ success: false, error: 'Tous les champs du dossier sont obligatoires.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: 'Adresse e-mail invalide.' });
  }

  const schoolResult = osmIdMatch
    ? await query(
      `SELECT id, name, is_partner, claimed, claimed_by, status FROM public.schools WHERE external_id = $1`,
      [schoolRef]
    )
    : await query(
      `SELECT id, name, is_partner, claimed, claimed_by, status FROM public.schools WHERE id = $1`,
      [localIdMatch[1]]
    );
  const school = schoolResult.rows[0];
  if (!school || school.status !== 'active') {
    return res.status(404).json({ success: false, error: 'Établissement introuvable ou inactif.' });
  }
  if (!school.is_partner || !school.claimed || !school.claimed_by) {
    return res.status(409).json({
      success: false,
      error: 'Les candidatures en ligne ne sont pas encore ouvertes pour cet établissement.'
    });
  }

  const acceptedApplication = await query(
    `SELECT id FROM public.school_admission_applications
     WHERE school_id = $1 AND applicant_id = $2 AND status = 'accepted'
     LIMIT 1`,
    [school.id, req.userId]
  );
  if (acceptedApplication.rows.length) {
    return res.status(409).json({ success: false, error: 'Votre candidature à cet établissement a déjà été acceptée.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO public.school_admission_applications
         (school_id, applicant_id, full_name, email, phone, current_level, requested_program, motivation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, school_id, full_name, status, created_at`,
      [school.id, req.userId, fullName, email, phone, currentLevel, requestedProgram, motivation]
    );
    const application = result.rows[0];
    await client.query(
      `INSERT INTO public.school_admission_application_events
         (application_id, actor_id, actor_type, event_type, message)
       VALUES ($1, $2, 'applicant', 'submitted', NULL)`,
      [application.id, req.userId]
    );
    const schoolMessage = `Nouvelle candidature de ${fullName} pour ${requestedProgram}.`;
    const studentMessage = `Votre candidature à ${school.name} a bien été envoyée.`;
    await insertAdmissionNotification(client, school.claimed_by, application.id, 'Nouvelle candidature', schoolMessage);
    await insertAdmissionNotification(client, req.userId, application.id, 'Candidature envoyée', studentMessage);
    await client.query('COMMIT');

    await Promise.all([
      sendAdmissionNotification(school.claimed_by, application.id, 'Nouvelle candidature', schoolMessage),
      sendAdmissionNotification(req.userId, application.id, 'Candidature envoyée', studentMessage)
    ]);
    return res.status(201).json({
      success: true,
      data: application,
      message: 'Votre candidature a été envoyée à l’établissement partenaire.'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(409).json({ success: false, error: 'Une candidature est déjà en cours pour cet établissement.' });
    }
    throw error;
  } finally {
    client.release();
  }
});

const getMySchoolAdmissions = asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT a.id, a.full_name, a.email, a.phone, a.current_level, a.requested_program,
            a.motivation, a.applicant_response, a.status, a.decision_message,
            a.created_at, a.updated_at, s.name AS school_name, s.city, s.country,
            student.access_code AS school_access_code,
            COALESCE((
              SELECT json_agg(json_build_object(
                'actorType', e.actor_type, 'eventType', e.event_type,
                'message', e.message, 'createdAt', e.created_at
              ) ORDER BY e.created_at ASC)
              FROM public.school_admission_application_events e
              WHERE e.application_id = a.id
            ), '[]'::json) AS history
     FROM public.school_admission_applications a
     JOIN public.schools s ON s.id = a.school_id
     LEFT JOIN public.school_students student ON student.id = a.student_record_id
     WHERE a.applicant_id = $1
     ORDER BY a.created_at DESC`,
    [req.userId]
  );
  return res.json({ success: true, data: result.rows });
});

const getSchoolAdmissionInbox = asyncHandler(async (req, res) => {
  const schoolAccess = await resolveAdmissionSchool(req);
  if (!schoolAccess) return res.status(403).json({ success: false, error: 'Accès réservé au directeur d’une école partenaire vérifiée.' });

  const result = await query(
    `SELECT a.id, a.full_name, a.email, a.phone, a.current_level, a.requested_program,
            a.motivation, a.applicant_response, a.status, a.decision_message,
            a.created_at, a.updated_at,
            COALESCE((
              SELECT json_agg(json_build_object(
                'actorType', e.actor_type, 'eventType', e.event_type,
                'message', e.message, 'createdAt', e.created_at
              ) ORDER BY e.created_at ASC)
              FROM public.school_admission_application_events e
              WHERE e.application_id = a.id
            ), '[]'::json) AS history
     FROM public.school_admission_applications a
     WHERE a.school_id = $1
     ORDER BY a.created_at DESC`,
    [schoolAccess.school_id]
  );
  return res.json({ success: true, data: result.rows, school: { name: schoolAccess.school_name } });
});

const decideSchoolAdmission = asyncHandler(async (req, res) => {
  const schoolAccess = await resolveAdmissionSchool(req);
  if (!schoolAccess) return res.status(403).json({ success: false, error: 'Accès réservé au directeur d’une école partenaire vérifiée.' });
  if (!UUID_PATTERN.test(req.params.applicationId)) {
    return res.status(400).json({ success: false, error: 'Identifiant de candidature invalide.' });
  }

  const status = req.body.status;
  const decisionMessage = typeof req.body.message === 'string' ? req.body.message.trim().slice(0, 1200) : '';
  if (!['info_requested', 'accepted', 'rejected'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Choisissez accepter, refuser ou demander des informations.' });
  }
  if (status === 'info_requested' && !decisionMessage) {
    return res.status(400).json({ success: false, error: 'Précisez les informations complémentaires attendues.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const applicationResult = await client.query(
      `SELECT id, applicant_id, full_name, requested_program
       FROM public.school_admission_applications
       WHERE id = $1 AND school_id = $2 AND status IN ('pending', 'info_requested')
       FOR UPDATE`,
      [req.params.applicationId, schoolAccess.school_id]
    );
    if (applicationResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Candidature introuvable ou déjà traitée.' });
    }
    const application = applicationResult.rows[0];
    let studentRecordId = null;
    if (status === 'accepted') {
      const existingStudent = await client.query(
        `SELECT id FROM public.school_students
         WHERE school_id = $1 AND profile_id = $2
         LIMIT 1 FOR UPDATE`,
        [schoolAccess.school_request_id, application.applicant_id]
      );
      if (existingStudent.rows.length) {
        studentRecordId = existingStudent.rows[0].id;
        await client.query(
          'UPDATE public.school_students SET full_name = $1, is_active = TRUE WHERE id = $2',
          [application.full_name, studentRecordId]
        );
      } else {
        const accessCode = `STU-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
        const newStudent = await client.query(
          `INSERT INTO public.school_students (school_id, full_name, access_code, is_active, profile_id)
           VALUES ($1, $2, $3, TRUE, $4)
           RETURNING id`,
          [schoolAccess.school_request_id, application.full_name, accessCode, application.applicant_id]
        );
        studentRecordId = newStudent.rows[0].id;
      }
    }

    await client.query(
      `UPDATE public.school_admission_applications
       SET status = $1, decision_message = $2, decided_by = $3, decided_at = NOW(),
           student_record_id = COALESCE($4, student_record_id), updated_at = NOW()
       WHERE id = $5`,
      [status, decisionMessage || null, req.userId, studentRecordId, application.id]
    );
    await client.query(
      `INSERT INTO public.school_admission_application_events
         (application_id, actor_id, actor_type, event_type, message)
       VALUES ($1, $2, 'school', $3, $4)`,
      [application.id, req.userId, status, decisionMessage || null]
    );

    const title = status === 'accepted'
      ? 'Candidature acceptée'
      : status === 'rejected' ? 'Candidature refusée' : 'Informations complémentaires demandées';
    const body = status === 'accepted'
      ? `Félicitations, ${application.full_name}. Votre candidature pour ${application.requested_program} a été acceptée.`
      : status === 'rejected'
        ? `Votre candidature pour ${application.requested_program} n’a pas été retenue.`
        : `L’établissement demande des informations complémentaires : ${decisionMessage}`;
    await insertAdmissionNotification(client, application.applicant_id, application.id, title, body);
    await client.query('COMMIT');

    await sendAdmissionNotification(application.applicant_id, application.id, title, body);
    return res.json({
      success: true,
      data: { id: application.id, status, studentRecordId },
      message: status === 'accepted'
        ? 'Candidature acceptée et fiche élève créée ou rattachée.'
        : status === 'rejected' ? 'Candidature refusée et étudiant notifié.' : 'Demande d’informations envoyée.'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

const respondToSchoolAdmission = asyncHandler(async (req, res) => {
  if (!UUID_PATTERN.test(req.params.applicationId)) {
    return res.status(400).json({ success: false, error: 'Identifiant de candidature invalide.' });
  }
  const message = typeof req.body.message === 'string' ? req.body.message.trim().slice(0, 1200) : '';
  if (!message) return res.status(400).json({ success: false, error: 'Indiquez les informations complémentaires demandées par l’école.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE public.school_admission_applications
       SET applicant_response = $1, status = 'pending', decision_message = NULL,
           decided_by = NULL, decided_at = NULL, updated_at = NOW()
       WHERE id = $2 AND applicant_id = $3 AND status = 'info_requested'
       RETURNING id, school_id`,
      [message, req.params.applicationId, req.userId]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Demande introuvable ou ne nécessitant pas de réponse.' });
    }
    const application = result.rows[0];
    await client.query(
      `INSERT INTO public.school_admission_application_events
         (application_id, actor_id, actor_type, event_type, message)
       VALUES ($1, $2, 'applicant', 'response_received', $3)`,
      [application.id, req.userId, message]
    );
    const schoolResult = await client.query(
      `SELECT s.claimed_by, s.name
       FROM public.schools s WHERE s.id = $1`,
      [application.school_id]
    );
    const school = schoolResult.rows[0];
    const title = 'Réponse reçue pour une candidature';
    const body = `Le candidat a complété sa candidature à ${school.name}.`;
    await insertAdmissionNotification(client, school.claimed_by, application.id, title, body);
    await client.query('COMMIT');

    await sendAdmissionNotification(school.claimed_by, application.id, title, body);
    return res.json({ success: true, message: 'Votre réponse a été transmise à l’établissement.' });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

const getMyAdmissionNotifications = asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT id, application_id, title, body, is_read, created_at
     FROM public.school_admission_notifications
     WHERE recipient_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [req.userId]
  );
  return res.json({ success: true, data: result.rows });
});

const markAdmissionNotificationRead = asyncHandler(async (req, res) => {
  if (!UUID_PATTERN.test(req.params.notificationId)) {
    return res.status(400).json({ success: false, error: 'Identifiant de notification invalide.' });
  }
  const result = await query(
    `UPDATE public.school_admission_notifications
     SET is_read = TRUE
     WHERE id = $1 AND recipient_id = $2
     RETURNING id`,
    [req.params.notificationId, req.userId]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ success: false, error: 'Notification introuvable.' });
  }
  return res.json({ success: true });
});

module.exports = {
  searchSchools,
  proposeSchool,
  reviewSchoolProposal,
  submitSchoolClaim,
  reviewSchoolClaim,
  getSchoolClaimStatus,
  submitSchoolAdmission,
  getMySchoolAdmissions,
  getSchoolAdmissionInbox,
  decideSchoolAdmission,
  respondToSchoolAdmission,
  getMyAdmissionNotifications,
  markAdmissionNotificationRead
};
