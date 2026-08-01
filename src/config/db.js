const { Pool } = require('pg');
const config = require('../../config/config');
const logger = require('../utils/logger');

const pool = new Pool({
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

pool.on('error', (err) => {
  logger.error('Unexpected error on idle client', err);
  process.exit(-1);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
