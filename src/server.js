const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');

const config = require('../config/config');
const { pool } = require('./config/db');
const logger = require('./utils/logger');
const { authenticate } = require('./middleware/auth.middleware');
const { notFound, errorHandler } = require('./middleware/error.middleware');

const authRoutes = require('./routes/auth.routes');
const uploadRoutes = require('./routes/upload.routes');
const userRoutes = require('./routes/user.routes');
const chatRoutes = require('./routes/chat.routes');
const messageRoutes = require('./routes/message.routes');
const statusRoutes = require('./routes/status.routes');
const adminRoutes = require('./routes/admin.routes');

// Controllers pour routes directes
const userController = require('./controllers/user.controller');
const appealController = require('./controllers/appeal.controller');

const socketService = require('./services/socket.service');
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

    this.initializeDatabase();
    this.initializeMiddlewares();
    this.initializeRoutes();
    this.initializeSocketIO();
    this.initializeErrorHandling();
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
        const p = path.join(__dirname, '..', '..', dir);
        if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
      });
    } catch (error) {
      logger.error('❌ DB Error:', error.message);
      setTimeout(() => process.exit(1), 1000);
    }
  }

  initializeMiddlewares() {
    this.app.use(helmet({ contentSecurityPolicy: false }));
    this.app.use(cors({ origin: '*', credentials: true }));
    this.app.use(morgan(this.nodeEnv === 'development' ? 'dev' : 'combined'));
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));
    this.app.use('/uploads', express.static(path.join(__dirname, '..', '..', 'uploads')));
  }

  initializeRoutes() {
    this.app.get('/', (req, res) => res.json({ status: 'online', app: 'Meet Me' }));
    this.app.get('/api/health', (req, res) => res.json({ status: 'healthy', version: '1.0.0' }));

    // Global /api/me to avoid 404
    this.app.get('/api/me', authenticate, userController.getMe);

    // Soumettre une contestation
    this.app.post('/api/users/appeal', authenticate, appealController.submitAppeal);

    this.app.use('/api/auth', authRoutes);
    this.app.use('/api/upload', uploadRoutes);
    this.app.use('/api/users', userRoutes);
    this.app.use('/api/chats', chatRoutes);
    this.app.use('/api/messages', messageRoutes);
    this.app.use('/api/statuses', statusRoutes);
    this.app.use('/api/admin', adminRoutes);

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

  start() {
    this.server.listen(this.port, () => {
      logger.info(`🚀 Server on port ${this.port}`);
    });
  }
}

const server = new Server();
server.start();
module.exports = { app: server.app, server: server.server };
