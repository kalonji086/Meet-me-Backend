#!/usr/bin/env node

/**
 * Script de configuration du backend Meet Me
 * Ce script vérifie les prérequis et configure l'environnement pour Supabase (Postgres)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log('🔧 Configuration du Backend Meet Me\n');

// Vérifier Node.js
try {
  const nodeVersion = execSync('node --version').toString().trim();
  const nodeMajor = parseInt(nodeVersion.replace('v', '').split('.')[0]);
  
  if (nodeMajor < 18) {
    console.error('❌ Node.js 18 ou supérieur est requis');
    console.error(`Version actuelle: ${nodeVersion}`);
    process.exit(1);
  }
  
  console.log(`✅ Node.js ${nodeVersion} détecté`);
} catch (error) {
  console.error('❌ Node.js n\'est pas installé');
  console.error('Veuillez installer Node.js 18+ depuis https://nodejs.org/');
  process.exit(1);
}

// Vérifier npm
try {
  const npmVersion = execSync('npm --version').toString().trim();
  console.log(`✅ npm ${npmVersion} détecté`);
} catch (error) {
  console.error('❌ npm n\'est pas installé');
  process.exit(1);
}

// Note: On ne vérifie plus MongoDB mais on prépare Supabase
continueSetup();

function continueSetup() {
  console.log('\n📦 Installation des dépendances...');
  
  try {
    execSync('npm install', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
    console.log('✅ Dépendances installées avec succès');
  } catch (error) {
    console.error('❌ Erreur lors de l\'installation des dépendances');
    process.exit(1);
  }

  // Vérifier le fichier .env
  const envPath = path.join(__dirname, '..', '.env');
  const envExamplePath = path.join(__dirname, '..', '.env.example');

  if (!fs.existsSync(envPath)) {
    console.log('\n📋 Création du fichier .env...');
    
    if (fs.existsSync(envExamplePath)) {
      try {
        const envExample = fs.readFileSync(envExamplePath, 'utf8');
        fs.writeFileSync(envPath, envExample);
        console.log('✅ Fichier .env créé à partir du template');
      } catch (error) {
        console.error('❌ Impossible de créer le fichier .env:', error.message);
      }
    } else {
      console.error('❌ Fichier .env.example non trouvé');
    }
  } else {
    console.log('✅ Fichier .env déjà existant');
  }

  // Créer les dossiers nécessaires
  console.log('\n📁 Création des dossiers...');
  
  const directories = [
    'uploads',
    'uploads/audio',
    'uploads/images',
    'uploads/videos',
    'uploads/documents',
    'logs',
  ];

  directories.forEach(dir => {
    const dirPath = path.join(__dirname, '..', dir);
    if (!fs.existsSync(dirPath)) {
      try {
        fs.mkdirSync(dirPath, { recursive: true });
        console.log(`✅ Dossier créé: ${dir}`);
      } catch (error) {
        console.error(`❌ Impossible de créer le dossier ${dir}:`, error.message);
      }
    } else {
      console.log(`✅ Dossier existant: ${dir}`);
    }
  });

  // Configuration Supabase
  console.log('\n🗄️  Configuration Supabase (Postgres)...');
  
  rl.question('Entrez votre DATABASE_URL Supabase: ', (dbUrl) => {
    if (dbUrl) {
      updateEnvFile('DATABASE_URL', dbUrl);

      // Essayer d'extraire les infos pour les autres variables
      try {
        const url = new URL(dbUrl);
        updateEnvFile('DB_HOST', url.hostname);
        updateEnvFile('DB_PORT', url.port || '5432');
        updateEnvFile('DB_USER', url.username);
        updateEnvFile('DB_PASSWORD', url.password);
        updateEnvFile('DB_NAME', url.pathname.substring(1));
      } catch (e) {
        console.warn('⚠️  Impossible d\'extraire tous les détails de l\'URL, veuillez les remplir manuellement dans .env');
      }
    }

    finishSetup();
  });
}

function updateEnvFile(key, value) {
  const envPath = path.join(__dirname, '..', '.env');
  
  if (!fs.existsSync(envPath)) {
    console.error('❌ Fichier .env non trouvé');
    return;
  }

  try {
    let envContent = fs.readFileSync(envPath, 'utf8');
    
    // Vérifier si la clé existe déjà
    const keyRegex = new RegExp(`^${key}=.*$`, 'm');
    
    if (keyRegex.test(envContent)) {
      // Mettre à jour la valeur existante
      envContent = envContent.replace(keyRegex, `${key}=${value}`);
    } else {
      // Ajouter la nouvelle clé
      envContent += `\n${key}=${value}`;
    }
    
    fs.writeFileSync(envPath, envContent);
    console.log(`✅ ${key} configuré dans .env`);
  } catch (error) {
    console.error(`❌ Impossible de mettre à jour ${key} dans .env:`, error.message);
  }
}

function finishSetup() {
  console.log('\n🎉 Configuration terminée !');
  console.log('\n🚀 Pour démarrer le backend:');
  console.log('  cd backend');
  console.log('  npm run dev');
  
  console.log('\n🔧 Prochaines étapes:');
  console.log('1. Configurez vos clés API dans le fichier .env si ce n\'est pas fait:');
  console.log('   - GOOGLE_TRANSLATE_API_KEY ou DEEPL_API_KEY');
  console.log('   - BREVO_API_KEY (pour les emails)');
  
  console.log('\n2. Testez l\'API:');
  console.log('   - http://localhost:3000/api/health');
  console.log('   - http://localhost:3000/api/docs');

  console.log('\n📚 Documentation complète:');
  console.log('   - Voir README.md pour plus de détails');
  
  rl.close();
  process.exit(0);
}
