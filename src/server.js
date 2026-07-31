const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const { Pool } = require('pg');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');

// Configuration
const config = require('../config/config');
const logger = require('./utils/logger');

// Middlewares
const { authenticate } = require('./middleware/auth.middleware');
const { notFound, errorHandler } = require('./middleware/error.middleware');

// Routes
const authRoutes = require('./routes/auth.routes');
const uploadRoutes = require('./routes/upload.routes');

// Services
const socketService = require('./services/socket.service');

class Server {
  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = socketIo(this.server, {
      cors: {
        origin: config.server.corsOrigin,
        methods: ['GET', 'POST'],
        credentials: true,
      },
      pingTimeout: config.socket.pingTimeout,
      pingInterval: config.socket.pingInterval,
      maxHttpBufferSize: config.socket.maxHttpBufferSize,
    });

    this.port = config.server.port;
    this.nodeEnv = config.server.nodeEnv;

    // Postgres Pool for Supabase
    this.pool = new Pool({
      connectionString: config.database.postgres.url,
      host: config.database.postgres.host,
      port: config.database.postgres.port,
      database: config.database.postgres.database,
      user: config.database.postgres.user,
      password: config.database.postgres.password,
      ssl: {
        rejectUnauthorized: false
      }
    });

    this.initializeDatabase();
    this.initializeMiddlewares();
    this.initializeRoutes();
    this.initializeSocketIO();
    this.initializeErrorHandling();
  }

  // Initialisation de la base de données
  async initializeDatabase() {
    try {
      // Test Postgres connection (Supabase)
      await this.pool.query('SELECT NOW()');
      logger.info('✅ Base de données Supabase (Postgres) connectée avec succès');

      // Créer les dossiers d'uploads s'ils n'existent pas
      const uploadDirs = ['uploads', 'uploads/audio', 'uploads/images', 'uploads/videos', 'uploads/documents'];
      uploadDirs.forEach(dir => {
        const dirPath = path.join(__dirname, '..', '..', dir);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
          logger.info(`📁 Dossier créé: ${dir}`);
        }
      });

    } catch (error) {
      logger.error('❌ Erreur de connexion à la base de données:', error);
      process.exit(1);
    }
  }

  // Initialisation des middlewares
  initializeMiddlewares() {
    // Sécurité
    this.app.use(helmet());
    this.app.use(cors({
      origin: config.server.corsOrigin,
      credentials: true,
    }));

    // Logging
    if (this.nodeEnv === 'development') {
      this.app.use(morgan('dev'));
    } else {
      // S'assurer que le dossier logs existe
      const logDir = path.join(__dirname, '..', '..', 'logs');
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      this.app.use(morgan('combined', {
        stream: fs.createWriteStream(
          path.join(__dirname, '..', '..', config.logging.file),
          { flags: 'a' }
        ),
      }));
    }

    // Body parsing
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));

    // Static files
    this.app.use('/uploads', express.static(path.join(__dirname, '..', '..', 'uploads')));

    // Request logging
    this.app.use((req, res, next) => {
      logger.debug(`${req.method} ${req.url}`);
      next();
    });
  }

  // Initialisation des routes
  initializeRoutes() {
    // Routes publiques
    this.app.use('/api/auth', authRoutes);
    this.app.use('/api/upload', uploadRoutes);

    // Routes protégées - Placeholder pour les routes manquantes
    // this.app.use('/api/users', authenticate, userRoutes);
    // this.app.use('/api/chats', authenticate, chatRoutes);
    // this.app.use('/api/messages', authenticate, messageRoutes);
    // this.app.use('/api/translate', authenticate, translationRoutes);

    // Route de santé
    this.app.get('/api/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: this.nodeEnv,
        version: config.constants.appVersion,
      });
    });

    // Documentation API
    this.app.get('/api/docs', (req, res) => {
      res.json({
        name: config.constants.appName,
        version: config.constants.appVersion,
        endpoints: {
          auth: {
            login: 'POST /api/auth/login',
            register: 'POST /api/auth/register',
          },
          upload: {
            uploadFile: 'POST /api/upload',
          },
        },
      });
    });
  }

  // Initialisation de Socket.IO
  initializeSocketIO() {
    socketService.initialize(this.io);
    logger.info('✅ Socket.IO initialisé');
  }

  // Initialisation de la gestion des erreurs
  initializeErrorHandling() {
    this.app.use(notFound);
    this.app.use(errorHandler);
  }

  // Démarrage du serveur
  start() {
    this.server.listen(this.port, () => {
      logger.info(`🚀 Serveur Meet Me démarré sur le port ${this.port}`);
      logger.info(`🌍 Environnement: ${this.nodeEnv}`);
      logger.info(`📡 CORS Origin: ${config.server.corsOrigin}`);
      logger.info(`🔗 Health Check: http://localhost:${this.port}/api/health`);
    });

    // Gestion des arrêts gracieux
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
  }

  // Arrêt gracieux du serveur
  async shutdown() {
    logger.info('🛑 Arrêt gracieux du serveur...');

    try {
      // Fermer Socket.IO
      this.io.close();
      logger.info('✅ Socket.IO fermé');

      // Fermer le serveur HTTP
      this.server.close();
      logger.info('✅ Serveur HTTP fermé');

      logger.info('👋 Serveur arrêté avec succès');
      process.exit(0);
    } catch (error) {
      logger.error('❌ Erreur lors de l\'arrêt gracieux:', error);
      process.exit(1);
    }
  }
}

// Création et démarrage du serveur
const server = new Server();
server.start();

// Export pour les tests
module.exports = { app: server.app, server: server.server };
