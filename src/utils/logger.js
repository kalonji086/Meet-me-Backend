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

// Ajout du transport fichier en production
if (config.server.nodeEnv === 'production') {
  transports.push(
    new winston.transports.File({
      filename: path.join(__dirname, '..', '..', config.logging.file),
      level: config.logging.level,
      format: winston.format.combine(
        winston.format.uncolorize(),
        winston.format.json()
      ),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    })
  );
}

// Création du logger
const logger = winston.createLogger({
  level: config.logging.level,
  levels,
  format,
  transports,
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(__dirname, '..', '..', 'logs/exceptions.log'),
    }),
  ],
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join(__dirname, '..', '..', 'logs/rejections.log'),
    }),
  ],
});

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