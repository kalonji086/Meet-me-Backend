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

    // On exécute le script SQL
    // Note: Utiliser pool.query avec tout le contenu du fichier
    // Pour Postgres, on peut envoyer plusieurs commandes séparées par des points-virgules
    await pool.query(sql);

    logger.info('✅ Migrations terminées avec succès (Tables créées ou déjà existantes)');
  } catch (error) {
    logger.error('❌ Erreur lors de l\'exécution des migrations:');
    logger.error(error.message);
    // On ne bloque pas forcément le démarrage si c'est juste une erreur de table déjà existante
    // mais avec IF NOT EXISTS cela devrait être fluide.
  }
};

module.exports = { runMigrations };
