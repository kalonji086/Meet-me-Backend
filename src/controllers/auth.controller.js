const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query } = require('../config/db');
const mailService = require('../services/mail.service');
const logger = require('../utils/logger');
const config = require('../../config/config');
const { asyncHandler } = require('../middleware/error.middleware');

/**
 * @desc    Vérifier si un email, téléphone ou pseudo existe déjà
 * @route   GET /api/auth/check-availability
 */
const checkAvailability = asyncHandler(async (req, res) => {
  const { email, phone_number, username } = req.query;

  if (!email && !phone_number && !username) {
    return res.status(400).json({ success: false, error: 'Identifiant requis' });
  }

  let sql = 'SELECT id FROM public.profiles WHERE 1=0';
  const params = [];

  if (email) {
    sql += ' OR email = $1';
    params.push(email.toLowerCase());
  }
  if (phone_number) {
    sql += ` OR (phone_number IS NOT NULL AND phone_number = $${params.length + 1})`;
    params.push(phone_number);
  }
  if (username) {
    sql += ` OR (username IS NOT NULL AND LOWER(username) = $${params.length + 1})`;
    params.push(username.toLowerCase());
  }

  const result = await query(sql, params);

  res.json({
    success: true,
    available: result.rows.length === 0
  });
});

/**
 * @desc    Inscription d'un nouvel utilisateur
 * @route   POST /api/auth/register
 * @access  Public
 */
const register = asyncHandler(async (req, res) => {
  const { name, email, password, phone_number, username, device_info } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({
      success: false,
      error: 'Veuillez fournir tous les champs requis',
    });
  }

  const emailLower = email.toLowerCase();
  const usernameLower = username ? username.toLowerCase().trim() : null;

  // Vérifier si le pseudo est déjà pris (si fourni)
  if (usernameLower) {
    const existingUsername = await query('SELECT id FROM public.profiles WHERE LOWER(username) = $1', [usernameLower]);
    if (existingUsername.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Identifiant non disponible. Veuillez en choisir un autre.',
      });
    }
  }

  const existingUser = await query(
    'SELECT id FROM public.profiles WHERE email = $1 OR (phone_number IS NOT NULL AND phone_number = $2)',
    [emailLower, phone_number || null]
  );
  
  if (existingUser.rows.length > 0) {
    return res.status(400).json({
      success: false,
      error: 'Un utilisateur avec cet email ou ce numéro existe déjà',
    });
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);
  const userId = crypto.randomUUID();

  // Si pas de username, on en génère un par défaut
  const finalUsername = usernameLower || (emailLower.split('@')[0] + Math.floor(1000 + Math.random() * 9000));

  const result = await query(
    `INSERT INTO public.profiles (id, full_name, email, password, username, phone_number, last_login_at, device_info)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
     RETURNING id, full_name, email, username, avatar_url, status, phone_number`,
    [
      userId,
      name,
      emailLower,
      hashedPassword,
      finalUsername,
      phone_number || null,
      JSON.stringify(device_info || {})
    ]
  );

  const user = result.rows[0];

  // Informer l'admin qu'un nouvel utilisateur s'est inscrit
  const socketService = require('../services/socket.service');
  socketService.broadcast('admin_new_user', {
    user: {
      id: user.id,
      name: user.full_name,
      email: user.email,
      username: user.username,
      avatar: user.avatar_url,
      phone_number: user.phone_number,
      created_at: new Date()
    }
  });

  const token = jwt.sign({ userId: user.id, email: user.email }, config.jwt.secret, { expiresIn: config.jwt.expire });
  const refreshToken = jwt.sign({ userId: user.id }, config.jwt.refreshSecret, { expiresIn: config.jwt.refreshExpire });

  await mailService.sendWelcomeEmail(user.email, user.full_name);

  res.status(201).json({
    success: true,
    data: {
      token,
      refreshToken,
      user: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        username: user.username,
        avatar: user.avatar_url,
        status: user.status,
        isGlobalAdmin: user.is_global_admin,
        push_token: user.push_token
      },
    }
  });
});

/**
 * @desc    Connexion utilisateur
 * @route   POST /api/auth/login
 * @access  Public
 */
const login = asyncHandler(async (req, res) => {
  const { email, password, isReauth = false, device_info } = req.body;

  if (!password || (!email && !isReauth)) {
    return res.status(400).json({ success: false, error: 'Identifiants requis' });
  }

  const emailLower = email?.toLowerCase();

  // 1. Trouver l'utilisateur
  const result = await query(
    'SELECT * FROM public.profiles WHERE email = $1',
    [emailLower]
  );

  const user = result.rows[0];
  
  if (!user) {
    return res.status(401).json({ success: false, error: 'Email ou mot de passe incorrect' });
  }

  // 2. Vérifier si le compte est bloqué
  if (user.is_locked) {
    return res.status(403).json({
      success: false,
      error: 'Compte bloqué',
      isLocked: true,
      message: 'Vous n\'êtes pas autorisé à vous connecter avec des identifiants incorrects. Veuillez créer un nouveau compte si vous le souhaitez.'
    });
  }

  // 3. Vérifier le mot de passe
  const isPasswordValid = await bcrypt.compare(password, user.password);
  
  if (!isPasswordValid) {
    // Incrémenter les tentatives
    const attempts = (user.login_attempts || 0) + 1;
    const isLockedNow = attempts >= 3;

    await query(
      'UPDATE public.profiles SET login_attempts = $1, is_locked = $2 WHERE id = $3',
      [attempts, isLockedNow, user.id]
    );

    if (isLockedNow) {
      return res.status(403).json({
        success: false,
        error: 'Compte bloqué',
        isLocked: true,
        message: 'Tentatives épuisées. Compte bloqué par sécurité.'
      });
    }

    return res.status(401).json({
      success: false,
      error: 'Mot de passe incorrect',
      attemptsLeft: 3 - attempts
    });
  }

  // 4. Succès: Réinitialiser les tentatives et mettre à jour last_login_at et device_info
  await query(
    "UPDATE public.profiles SET status = 'online', last_seen = NOW(), login_attempts = 0, last_login_at = NOW(), device_info = $1 WHERE id = $2",
    [JSON.stringify(device_info || user.device_info || {}), user.id]
  );

  const socketService = require('../services/socket.service');
  socketService.broadcast('admin_user_login', {
    userId: user.id,
    name: user.full_name,
    email: user.email,
    time: new Date()
  });

  const token = jwt.sign({ userId: user.id, email: user.email }, config.jwt.secret, { expiresIn: config.jwt.expire });
  const refreshToken = jwt.sign({ userId: user.id }, config.jwt.refreshSecret, { expiresIn: config.jwt.refreshExpire });

  res.json({
    success: true,
    data: {
      token,
      refreshToken,
      user: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        username: user.username,
        avatar: user.avatar_url,
        status: 'online',
        isGlobalAdmin: user.is_global_admin,
        push_token: user.push_token
      },
    }
  });
});

/**
 * @desc    Rafraîchir le token
 */
const refreshToken = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ success: false, error: 'Refresh token requis' });

  try {
    const decoded = jwt.verify(refreshToken, config.jwt.refreshSecret);
    const result = await query('SELECT * FROM public.profiles WHERE id = $1', [decoded.userId]);
    const user = result.rows[0];

    if (!user || user.is_locked) return res.status(401).json({ success: false, error: 'Session invalide' });

    const newAccessToken = jwt.sign({ userId: user.id, email: user.email }, config.jwt.secret, { expiresIn: config.jwt.expire });
    res.json({ success: true, data: { token: newAccessToken, user } });
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Session expirée' });
  }
});

const logout = asyncHandler(async (req, res) => {
  const userId = req.userId;
  await query("UPDATE public.profiles SET status = 'offline', last_seen = NOW() WHERE id = $1", [userId]);
  res.json({ success: true, message: 'Déconnexion réussie' });
});

const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const result = await query('SELECT id, email FROM public.profiles WHERE email = $1', [email?.toLowerCase()]);
  const user = result.rows[0];
  if (!user) return res.json({ success: true, message: 'OTP envoyé si compte existant' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  await query('UPDATE public.profiles SET otp_code = $1, otp_expires_at = NOW() + INTERVAL \'15 minutes\' WHERE id = $2', [otp, user.id]);
  await mailService.sendOTPEmail(user.email, otp);
  res.json({ success: true, message: 'OTP envoyé' });
});

const resetPassword = asyncHandler(async (req, res) => {
  const { email, otp, newPassword } = req.body;
  const result = await query('SELECT id FROM public.profiles WHERE email = $1 AND otp_code = $2 AND otp_expires_at > NOW()', [email?.toLowerCase(), otp]);
  const user = result.rows[0];
  if (!user) return res.status(400).json({ success: false, error: 'OTP invalide' });

  const hashedPassword = await bcrypt.hash(newPassword, 10);
  await query('UPDATE public.profiles SET password = $1, otp_code = NULL, otp_expires_at = NULL, is_locked = FALSE, login_attempts = 0 WHERE id = $2', [hashedPassword, user.id]);
  res.json({ success: true, message: 'Mot de passe réinitialisé' });
});

const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const result = await query('SELECT password FROM public.profiles WHERE id = $1', [req.userId]);
  const user = result.rows[0];
  if (!(await bcrypt.compare(currentPassword, user.password))) return res.status(401).json({ success: false, error: 'Ancien mot de passe incorrect' });

  const hashedPassword = await bcrypt.hash(newPassword, 10);
  await query('UPDATE public.profiles SET password = $1 WHERE id = $2', [hashedPassword, req.userId]);
  res.json({ success: true, message: 'Mot de passe mis à jour' });
});

const verifyToken = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { user: req.user } });
});

module.exports = { register, login, refreshToken, logout, forgotPassword, resetPassword, changePassword, verifyToken, checkAvailability };
