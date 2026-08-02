const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');

// Configuration
const config = require('../config/config');
const { pool } = require('./config/db');
const logger = require('./utils/logger');

// Middlewares
const { authenticate } = require('./middleware/auth.middleware');
const { notFound, errorHandler } = require('./middleware/error.middleware');

// Routes
const authRoutes = require('./routes/auth.routes');
const uploadRoutes = require('./routes/upload.routes');
const userRoutes = require('./routes/user.routes');
const chatRoutes = require('./routes/chat.routes');
const messageRoutes = require('./routes/message.routes');
const statusRoutes = require('./routes/status.routes');

// Services
const socketService = require('./services/socket.service');
const { runMigrations } = require('./utils/migration');

class Server {
  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = socketIo(this.server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: true,
      },
      pingTimeout: config.socket.pingTimeout,
      pingInterval: config.socket.pingInterval,
      maxHttpBufferSize: config.socket.maxHttpBufferSize,
    });

    this.port = config.server.port;
    this.nodeEnv = config.server.nodeEnv;

    // Use Postgres Pool from db config
    this.pool = pool;

    this.initializeDatabase();
    this.initializeMiddlewares();
    this.initializeRoutes();
    this.initializeSocketIO();
    this.initializeErrorHandling();
  }

  // Initialisation de la base de données
  async initializeDatabase() {
    try {
      // Vérification des variables critiques
      if (!config.database.postgres.url && !config.database.postgres.password) {
        throw new Error('DATABASE_URL ou DB_PASSWORD manquant dans les variables d\'environnement');
      }

      // Test Postgres connection (Supabase)
      logger.info('⏳ Tentative de connexion à Supabase (Postgres)...');
      const client = await this.pool.connect();
      try {
        await client.query('SELECT NOW()');
        logger.info('✅ Base de données Supabase (Postgres) connectée avec succès');

        // Exécuter les migrations (création automatique des tables)
        await runMigrations();
      } finally {
        client.release();
      }

      // Créer les dossiers d'uploads s'ils n'existent pas
      const uploadDirs = ['uploads', 'uploads/audio', 'uploads/images', 'uploads/videos', 'uploads/documents'];
      uploadDirs.forEach(dir => {
        try {
          const dirPath = path.join(__dirname, '..', '..', dir);
          if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
            logger.info(`📁 Dossier créé: ${dir}`);
          }
        } catch (err) {
          logger.warn(`Impossible de créer le dossier ${dir}: ${err.message}`);
        }
      });

    } catch (error) {
      logger.error('❌ Erreur fatale lors de l\'initialisation de la base de données:');
      logger.error(error.message);
      if (error.stack) logger.debug(error.stack);

      // En production sur Render, on veut voir l'erreur avant de quitter
      setTimeout(() => process.exit(1), 1000);
    }
  }

  // Initialisation des middlewares
  initializeMiddlewares() {
    // Sécurité
    this.app.use(helmet());
    this.app.use(cors({
      origin: '*',
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
    this.app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

    // Request logging
    this.app.use((req, res, next) => {
      logger.debug(`${req.method} ${req.url}`);
      next();
    });
  }

  // Initialisation des routes
  initializeRoutes() {
    // Route racine (pour éviter les 404 sur les health checks par défaut)
    this.app.get('/', (req, res) => {
      res.json({
        message: 'Bienvenue sur l\'API Meet Me',
        status: 'online',
        docs: '/api/docs'
      });
    });

    // TEST ROUTE FOR 404 DEBUG
    this.app.get('/api/users/profile/get-current', authenticate, (req, res) => {
      const userController = require('./controllers/user.controller');
      return userController.getMe(req, res);
    });

    // Routes publiques
    this.app.use('/api/auth', authRoutes);
    this.app.use('/api/upload', uploadRoutes);

    // Routes protégées
    this.app.use('/api/users', userRoutes);
    this.app.use('/api/chats', chatRoutes);
    this.app.use('/api/messages', messageRoutes);
    this.app.use('/api/statuses', statusRoutes);

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
