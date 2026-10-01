const fs = require('fs');
const path = require('path');
const { query } = require('../src/config/db');
const logger = require('../src/utils/logger');

async function runMigration(filePath) {
  try {
    const migrationSQL = fs.readFileSync(filePath, 'utf8');
    console.log(`Running migration: ${path.basename(filePath)}`);

    await query(migrationSQL);
    console.log(`✓ Migration ${path.basename(filePath)} completed successfully`);
  } catch (error) {
    console.error(`✗ Error running migration ${path.basename(filePath)}:`, error.message);
    throw error;
  }
}

async function main() {
  console.log('Starting extended school module migrations...\n');

  try {
    // Exécuter les migrations existantes d'abord (au cas où)
    const migrations = [
      'migration_school.sql',
      'migration_school_details.sql',
      'migration_school_grades.sql'
    ];

    for (const migrationFile of migrations) {
      const filePath = path.join(__dirname, migrationFile);
      if (fs.existsSync(filePath)) {
        await runMigration(filePath);
      } else {
        console.log(`⚠ Migration file ${migrationFile} not found, skipping...`);
      }
    }

    console.log('\n✅ All migrations completed successfully!');
    console.log('\nNew tables created:');
    console.log('  - school_subjects (Matières scolaires)');
    console.log('  - school_evaluations (Évaluations)');
    console.log('  - school_grades (Notes)');
    console.log('  - school_attendance (Présences)');
    console.log('  - school_resources (Ressources pédagogiques)');
    console.log('  - school_payments (Paiements en ligne)');
    console.log('  - school_notifications (Notifications)');

    console.log('\nNew API endpoints available:');
    console.log('  GET    /api/school/subjects');
    console.log('  POST   /api/school/subjects');
    console.log('  GET    /api/school/evaluations');
    console.log('  POST   /api/school/evaluations');
    console.log('  GET    /api/school/evaluations/:id/grades');
    console.log('  POST   /api/school/evaluations/:id/grades');
    console.log('  GET    /api/school/attendance');
    console.log('  POST   /api/school/attendance');
    console.log('  GET    /api/school/attendance/stats');
    console.log('  GET    /api/school/resources');
    console.log('  POST   /api/school/resources');
    console.log('  GET    /api/school/reports');
    console.log('  GET    /api/school/export');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    process.exit(1);
  }
}

// Exécuter si appelé directement
if (require.main === module) {
  main();
}

module.exports = { runMigration };