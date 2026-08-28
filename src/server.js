const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const config = require('../config/config');
const { pool } = require('./config/db');
const logger = require('./utils/logger');
const { authenticate, authenticateAllowLocked } = require('./middleware/auth.middleware');
const { notFound, errorHandler } = require('./middleware/error.middleware');

const authRoutes = require('./routes/auth.routes');
const uploadRoutes = require('./routes/upload.routes');
const userRoutes = require('./routes/user.routes');
const chatRoutes = require('./routes/chat.routes');
const messageRoutes = require('./routes/message.routes');
const statusRoutes = require('./routes/status.routes');
const adminRoutes = require('./routes/admin.routes');
const callRoutes = require('./routes/call.routes');
const marketRoutes = require('./routes/market.routes');
const collabRoutes = require('./routes/collab.routes');

// Controllers pour routes directes
const userController = require('./controllers/user.controller');
const appealController = require('./controllers/appeal.controller');

const socketService = require('./services/socket.service');
const automationService = require('./services/automation.service');
const { runMigrations } = require('./utils/migration');

class Server {
  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = socketIo(this.server, {
      cors: { origin: '*', methods: ['GET', 'POST'], credentials: true },
      pingTimeout: config.socket.pingTimeout,
      pingInterval: config.socket.pingInterval,
    });

    this.port = config.server.port;
    this.nodeEnv = config.server.nodeEnv;
    this.pool = pool;

    this.startServer();
  }

  async startServer() {
    await this.initializeDatabase();
    this.initializeMiddlewares();
    this.initializeRoutes();
    this.initializeSocketIO();
    this.initializeErrorHandling();
    this.initializeAutomation();

    this.server.listen(this.port, () => {
      logger.info(`🚀 Server on port ${this.port}`);
    });
  }

  async initializeDatabase() {
    try {
      const client = await this.pool.connect();
      try {
        await client.query('SELECT NOW()');
        logger.info('✅ Database connected');
        await runMigrations();
      } finally {
        client.release();
      }
      ['uploads', 'uploads/audio', 'uploads/images'].forEach(dir => {
        const p = path.join(__dirname, '..', dir);
        if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
      });
    } catch (error) {
      logger.error('❌ DB Error:', error.message);
      setTimeout(() => process.exit(1), 1000);
    }
  }

  initializeAutomation() {
    automationService.initialize();
  }

  initializeMiddlewares() {
    this.app.set('trust proxy', 1);
    this.app.use(helmet({ contentSecurityPolicy: false }));
    this.app.use(cors({ origin: '*', credentials: true }));

    // Protection contre les hackers et le spam (Rate Limiting)
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // Limite chaque IP à 100 requêtes par fenêtre
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        error: 'Trop de requêtes',
        message: 'Accès temporairement suspendu pour des raisons de sécurité. Veuillez réessayer plus tard.'
      }
    });
    this.app.use('/api/', limiter);

    this.app.use(morgan(this.nodeEnv === 'development' ? 'dev' : 'combined'));
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));
    this.app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
  }

  initializeRoutes() {
    this.app.get('/', (req, res) => res.json({ status: 'online', app: 'Meet Me', version: '52.0.0' }));
    this.app.get('/api/health', (req, res) => res.json({ status: 'healthy', version: '52.0.0' }));
    
    // Route de ping pour garder le serveur actif sur Render
    this.app.get('/api/ping', (req, res) => {
      res.json({ 
        status: 'pong', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      });
    });

    // Gérer le favicon pour éviter les erreurs 404 dans les logs
    this.app.get('/favicon.ico', (req, res) => res.status(204).end());

    // Route publique pour vérification de mise à jour App Mobile
    const adminController = require('./controllers/admin.controller');
    this.app.get('/api/check-update', adminController.checkUpdate);
    this.app.get('/api/legal', adminController.getLegalDocs);

    // Global /api/me to avoid 404
    this.app.get('/api/me', authenticate, userController.getMe);

    // Soumettre une contestation (Autorisé même si banni)
    this.app.post('/api/users/appeal', authenticateAllowLocked, appealController.submitAppeal);

    // Helpdesk (Public ou Connecté)
    this.app.post('/api/support/helpdesk', (req, res, next) => {
      if (req.headers.authorization) return authenticateAllowLocked(req, res, next);
      next();
    }, appealController.submitHelpdesk);

    // Formulaire de suppression de compte (Public pour Google)
    this.app.post('/api/users/request-deletion', appealController.requestDeletion);
    this.app.get('/delete-account', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'admin-dashboard', 'delete-account.html'));
    });
    this.app.get('/privacy', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'admin-dashboard', 'privacy.html'));
    });
    this.app.get('/support/helpdesk', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'admin-dashboard', 'support.html'));
    });
    this.app.get('/collab-apply', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'admin-dashboard', 'collab-apply.html'));
    });

    this.app.use('/api/auth', authRoutes);
    this.app.use('/api/upload', uploadRoutes);
    this.app.use('/api/users', userRoutes);
    this.app.use('/api/chats', chatRoutes);
    this.app.use('/api/messages', messageRoutes);
    this.app.use('/api/statuses', statusRoutes);
    this.app.use('/api/admin', adminRoutes);
    this.app.use('/api/calls', callRoutes);
    this.app.use('/api/market', marketRoutes);
    this.app.use('/api/collab', collabRoutes);

    // Servir le Dashboard Admin
    const adminPath = path.join(__dirname, '..', 'admin-dashboard');
    this.app.use('/admin-portal', express.static(adminPath));
    this.app.get('/admin-portal*', (req, res) => {
      res.sendFile(path.join(adminPath, 'index.html'));
    });
  }

  initializeSocketIO() {
    socketService.initialize(this.io);
    logger.info('✅ Socket.IO connected');
  }

  initializeErrorHandling() {
    this.app.use(notFound);
    this.app.use(errorHandler);
  }
}

const server = new Server();
module.exports = { app: server.app, server: server.server };
