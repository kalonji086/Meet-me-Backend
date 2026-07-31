const winston = require('winston');
const path = require('path');
const config = require('../../config/config');

// Définition des niveaux de log personnalisés
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Définition des couleurs pour chaque niveau
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'white',
};

// Ajout des couleurs à winston
winston.addColors(colors);

// Format des logs
const format = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(
    (info) => `${info.timestamp} ${info.level}: ${info.message}`,
  ),
);

// Transports (sorties des logs)
const transports = [
  // Console
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    ),
  }),
];

// Ajout du transport fichier si configuré (optionnel sur Render)
if (config.server.nodeEnv === 'production' && config.logging.file) {
  try {
    const logFilePath = path.join(__dirname, '..', '..', config.logging.file);
    const logDir = path.dirname(logFilePath);

    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    transports.push(
      new winston.transports.File({
        filename: logFilePath,
        level: config.logging.level,
        format: winston.format.combine(
          winston.format.uncolorize(),
          winston.format.json()
        ),
        maxsize: 5242880, // 5MB
        maxFiles: 5,
      })
    );
  } catch (error) {
    console.error('Impossible d\'initialiser le logging fichier:', error.message);
  }
}

// Création du logger
const logger = winston.createLogger({
  level: config.logging.level,
  levels,
  format,
  transports,
});

// Exception handlers (plus sûrs)
if (config.server.nodeEnv === 'production') {
  const excPath = path.join(__dirname, '..', '..', 'logs/exceptions.log');
  if (fs.existsSync(path.dirname(excPath))) {
    logger.exceptions.handle(new winston.transports.File({ filename: excPath }));
    logger.rejections.handle(new winston.transports.File({ filename: excPath }));
  }
}

// Stream pour Morgan (middleware de logging HTTP)
logger.stream = {
  write: (message) => logger.http(message.trim()),
};

// Méthodes utilitaires
logger.api = (method, route, status, duration, userId = null) => {
  const userInfo = userId ? `[User: ${userId}]` : '';
  logger.info(`${method} ${route} ${status} ${duration}ms ${userInfo}`);
};

logger.errorWithContext = (error, context = {}) => {
  logger.error({
    message: error.message,
    stack: error.stack,
    context,
    timestamp: new Date().toISOString(),
  });
};

logger.socket = (event, socketId, data = null) => {
  const dataStr = data ? ` - Data: ${JSON.stringify(data).substring(0, 200)}` : '';
  logger.debug(`[Socket: ${socketId}] ${event}${dataStr}`);
};

logger.database = (operation, collection, query = null, duration = null) => {
  const queryStr = query ? ` - Query: ${JSON.stringify(query).substring(0, 200)}` : '';
  const durationStr = duration ? ` - ${duration}ms` : '';
  logger.debug(`[DB: ${collection}] ${operation}${queryStr}${durationStr}`);
};

module.exports = logger;