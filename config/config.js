require('dotenv').config();

const config = {
  // Server Configuration
  server: {
    port: process.env.PORT || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:8081',
  },

  // Database Configuration
  database: {
    postgres: {
      url: process.env.DATABASE_URL,
      host: process.env.DB_HOST || 'aws-1-eu-west-2.pooler.supabase.com',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'postgres',
      user: process.env.DB_USER || 'postgres.jpddrhqpzydjugwhgddr',
      password: process.env.DB_PASSWORD,
    },
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY,
  },

  // JWT Configuration
  jwt: {
    secret: process.env.JWT_SECRET || 'default_jwt_secret_change_in_production',
    expire: process.env.JWT_EXPIRE || '7d',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'default_refresh_secret_change_in_production',
    refreshExpire: process.env.JWT_REFRESH_EXPIRE || '30d',
  },

  // Translation APIs
  translation: {
    googleApiKey: process.env.GOOGLE_TRANSLATE_API_KEY,
    deeplApiKey: process.env.DEEPL_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    provider: process.env.TRANSLATION_PROVIDER || 'openai',
    cacheDuration: 24 * 60 * 60 * 1000, // 24 hours
  },

  // AWS S3 Configuration
  aws: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'eu-west-3',
    s3Bucket: process.env.AWS_S3_BUCKET,
    s3Endpoint: process.env.AWS_S3_ENDPOINT || 'https://s3.eu-west-3.amazonaws.com',
  },

  // Firebase Configuration
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  },

  // Email Configuration
  email: {
    smtpHost: process.env.SMTP_HOST || 'smtp.gmail.com',
    smtpPort: parseInt(process.env.SMTP_PORT) || 587,
    smtpUser: process.env.SMTP_USER,
    smtpPass: process.env.SMTP_PASS,
    emailFrom: process.env.EMAIL_FROM || 'noreply@meetme.com',
    brevoApiKey: process.env.BREVO_API_KEY,
  },

  // Rate Limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000, // 15 minutes
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  },

  // File Upload Configuration
  upload: {
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 50 * 1024 * 1024, // 50MB
    maxAudioDuration: parseInt(process.env.MAX_AUDIO_DURATION) || 300, // 5 minutes
    allowedImageTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    allowedAudioTypes: ['audio/mpeg', 'audio/mp3', 'audio/m4a', 'audio/wav', 'audio/ogg'],
    allowedVideoTypes: ['video/mp4', 'video/quicktime'],
    allowedDocumentTypes: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  },

  // Logging Configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || 'logs/meetme.log',
  },

  // Socket.IO Configuration
  socket: {
    pingTimeout: parseInt(process.env.SOCKET_PING_TIMEOUT) || 5000,
    pingInterval: parseInt(process.env.SOCKET_PING_INTERVAL) || 25000,
    maxHttpBufferSize: parseInt(process.env.SOCKET_MAX_HTTP_BUFFER_SIZE) || 1e6,
  },

  // Agora Configuration (Voice & Video)
  agora: {
    appId: process.env.AGORA_APP_ID,
    appCertificate: process.env.AGORA_APP_CERTIFICATE,
  },

  // Application Constants
  constants: {
    appName: 'Meet Me',
    appVersion: '59.0.0',
    defaultLanguage: 'fr',
    supportedLanguages: ['fr', 'en', 'es', 'de', 'it', 'pt', 'ru', 'zh', 'ja', 'ko', 'ar'],
    messageTypes: {
      TEXT: 'text',
      AUDIO: 'audio',
      IMAGE: 'image',
      VIDEO: 'video',
      FILE: 'file',
    },
    userStatus: {
      ONLINE: 'online',
      OFFLINE: 'offline',
      AWAY: 'away',
      BUSY: 'busy',
    },
  },

  // Keep-alive configuration
  keepAlive: {
    enabled: process.env.KEEP_ALIVE_ENABLED === 'true' || true,
    interval: parseInt(process.env.KEEP_ALIVE_INTERVAL) || 10 * 60 * 1000, // 10 minutes
    endpoints: ['/api/ping', '/api/health', '/'],
  },
};

// Validation des configurations requises
const validateConfig = () => {
  const requiredFields = [
    { field: config.jwt.secret, name: 'JWT_SECRET' },
    { field: config.database.postgres.url || config.database.postgres.password, name: 'DATABASE_URL/DB_PASSWORD' },
  ];

  const missingFields = requiredFields.filter(item => !item.field || item.field.includes('default'));

  if (missingFields.length > 0) {
    console.warn('⚠️  Avertissement: Les configurations suivantes sont manquantes ou par défaut :');
    missingFields.forEach(item => {
      console.warn(`   - ${item.name}`);
    });
  }
};

validateConfig();

module.exports = config;