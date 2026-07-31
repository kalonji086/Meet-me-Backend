#!/usr/bin/env node

/**
 * Script de configuration du backend Meet Me
 * Ce script vérifie les prérequis et configure l'environnement
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

// Vérifier MongoDB
console.log('\n🔍 Vérification de MongoDB...');
try {
  execSync('mongod --version', { stdio: 'pipe' });
  console.log('✅ MongoDB détecté');
} catch (error) {
  console.warn('⚠️  MongoDB n\'est pas installé ou n\'est pas dans le PATH');
  console.warn('Vous pouvez:');
  console.warn('1. Installer MongoDB localement');
  console.warn('2. Utiliser MongoDB Atlas (cloud)');
  console.warn('3. Lancer sans MongoDB (pour le développement avec données mock)');
  
  rl.question('Voulez-vous continuer sans MongoDB? (oui/non): ', (answer) => {
    if (answer.toLowerCase() !== 'oui' && answer.toLowerCase() !== 'o') {
      console.log('❌ Installation annulée');
      rl.close();
      process.exit(1);
    }
    continueSetup();
  });
  
  return;
}

continueSetup();

function continueSetup() {
  console.log('\n📦 Installation des dépendances...');
  
  try {
    execSync('npm install', { stdio: 'inherit', cwd: __dirname + '/..' });
    console.log('✅ Dépendances installées avec succès');
  } catch (error) {
    console.error('❌ Erreur lors de l'installation des dépendances');
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

  // Configuration MongoDB
  console.log('\n🗄️  Configuration MongoDB...');
  
  rl.question('Utilisez-vous MongoDB local ou MongoDB Atlas? (local/atlas): ', (mongoType) => {
    if (mongoType.toLowerCase() === 'atlas') {
      configureMongoDBAtlas();
    } else {
      configureMongoDBLocal();
    }
  });
}

function configureMongoDBLocal() {
  console.log('\n🔧 Configuration MongoDB local...');
  
  // Vérifier si MongoDB est en cours d'exécution
  try {
    execSync('mongo --eval "db.version()"', { stdio: 'pipe' });
    console.log('✅ MongoDB est en cours d'exécution');
  } catch (error) {
    console.warn('⚠️  MongoDB ne semble pas être en cours d'exécution');
    console.warn('Pour démarrer MongoDB:');
    console.warn('  Windows: "net start MongoDB"');
    console.warn('  macOS: "brew services start mongodb-community"');
    console.warn('  Linux: "sudo systemctl start mongod"');
  }

  // Mettre à jour le fichier .env
  updateEnvFile('MONGODB_URI', 'mongodb://localhost:27017/meetme');
  
  console.log('\n✅ Configuration MongoDB local terminée');
  finishSetup();
}

function configureMongoDBAtlas() {
  console.log('\n☁️  Configuration MongoDB Atlas...');
  
  console.log('\n📝 Instructions pour MongoDB Atlas:');
  console.log('1. Allez sur https://www.mongodb.com/cloud/atlas');
  console.log('2. Créez un cluster gratuit');
  console.log('3. Créez un utilisateur de base de données');
  console.log('4. Ajoutez votre IP à la whitelist');
  console.log('5. Obtenez la chaîne de connexion');
  
  rl.question('\nEntrez votre URI MongoDB Atlas: ', (mongoUri) => {
    if (!mongoUri) {
      console.log('❌ URI MongoDB requis');
      configureMongoDBAtlas();
      return;
    }

    updateEnvFile('MONGODB_URI', mongoUri);
    console.log('\n✅ Configuration MongoDB Atlas terminée');
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
  console.log('1. Configurez vos clés API dans le fichier .env:');
  console.log('   - GOOGLE_TRANSLATE_API_KEY ou DEEPL_API_KEY');
  console.log('   - AWS_ACCESS_KEY_ID et AWS_SECRET_ACCESS_KEY (optionnel)');
  console.log('   - FIREBASE_* (pour les notifications push)');
  
  console.log('\n2. Testez l'API:');
  console.log('   - http://localhost:3000/api/health');
  console.log('   - http://localhost:3000/api/docs');
  
  console.log('\n3. Connectez le frontend:');
  console.log('   - Mettez à jour API_BASE_URL dans le frontend');
  console.log('   - Configurez CORS_ORIGIN dans le backend');
  
  console.log('\n📚 Documentation complète:');
  console.log('   - Voir README.md pour plus de détails');
  
  rl.close();
  process.exit(0);
}