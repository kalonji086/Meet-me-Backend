const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');
const logger = require('./logger');

/**
 * Exécute les migrations de la base de données
 */
const runMigrations = async () => {
  logger.info('⏳ Vérification des migrations de la base de données...');

  try {
    const sqlPath = path.join(__dirname, '..', '..', 'database_setup.sql');

    if (!fs.existsSync(sqlPath)) {
      logger.warn('⚠️  Fichier database_setup.sql non trouvé. Migration sautée.');
      return;
    }

    const sql = fs.readFileSync(sqlPath, 'utf8');
    await pool.query(sql);

    // Migration Collaboration
    const collabSqlPath = path.join(__dirname, '..', '..', 'scripts', 'migration_collaboration.sql');
    if (fs.existsSync(collabSqlPath)) {
      const collabSql = fs.readFileSync(collabSqlPath, 'utf8');
      await pool.query(collabSql);
      logger.info('✅ Migration Collaboration terminée');
    }

    // Initialisation des tables admin et du compte admin principal
    const adminController = require('../controllers/admin.controller');
    await adminController.ensureAdminTables();

    logger.info('✅ Migrations et initialisation Admin terminées avec succès');
  } catch (error) {
    logger.error('❌ Erreur lors de l\'exécution des migrations:');
    logger.error(error.message);
    // On ne bloque pas forcément le démarrage si c'est juste une erreur de table déjà existante
    // mais avec IF NOT EXISTS cela devrait être fluide.
  }
};

module.exports = { runMigrations };
