#!/usr/bin/env node

/**
 * Script de vérification de configuration pour production
 * Vérifie que toutes les variables d'environnement nécessaires sont configurées
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

console.log('🔍 Vérification de la configuration de production...\n');

const config = {
  // Configuration critique (bloquante)
  critical: [
    { name: 'AGORA_APP_ID', description: 'App ID Agora (obligatoire pour les appels)' },
    { name: 'AGORA_APP_CERTIFICATE', description: 'App Certificate Agora (obligatoire pour les tokens)' },
    { name: 'JWT_SECRET', description: 'Secret JWT (sécurité)' },
    { name: 'DATABASE_URL', description: 'URL de connexion PostgreSQL' },
  ],
  
  // Configuration importante (recommandée)
  important: [
    { name: 'AWS_ACCESS_KEY_ID', description: 'AWS Access Key (stockage fichiers)' },
    { name: 'AWS_SECRET_ACCESS_KEY', description: 'AWS Secret Key (stockage fichiers)' },
    { name: 'AWS_S3_BUCKET', description: 'Bucket S3 (stockage fichiers)' },
    { name: 'SMTP_USER', description: 'Email SMTP (notifications)' },
    { name: 'SMTP_PASS', description: 'Mot de passe SMTP (notifications)' },
  ],
  
  // Configuration optionnelle
  optional: [
    { name: 'GOOGLE_TRANSLATE_API_KEY', description: 'Google Translate API (traduction)' },
    { name: 'FIREBASE_PROJECT_ID', description: 'Firebase (push notifications)' },
    { name: 'BREVO_API_KEY', description: 'Brevo/Sendinblue (emails transactionnels)' },
  ]
};

let hasCriticalErrors = false;
const errors = [];
const warnings = [];

// Vérifier les configurations critiques
console.log('📋 CONFIGURATIONS CRITIQUES:');
config.critical.forEach(item => {
  const value = process.env[item.name];
  if (!value || value.includes('votre_') || value.includes('default_')) {
    errors.push(`❌ ${item.name}: ${item.description}`);
    hasCriticalErrors = true;
  } else {
    console.log(`   ✅ ${item.name}: Configuré`);
  }
});

// Vérifier les configurations importantes
console.log('\n📋 CONFIGURATIONS IMPORTANTES:');
config.important.forEach(item => {
  const value = process.env[item.name];
  if (!value || value.includes('votre_')) {
    warnings.push(`⚠️  ${item.name}: ${item.description}`);
    console.log(`   ⚠️  ${item.name}: Non configuré (recommandé)`);
  } else {
    console.log(`   ✅ ${item.name}: Configuré`);
  }
});

// Vérifier les configurations optionnelles
console.log('\n📋 CONFIGURATIONS OPTIONNELLES:');
config.optional.forEach(item => {
  const value = process.env[item.name];
  if (!value || value.includes('votre_')) {
    console.log(`   ℹ️  ${item.name}: Non configuré (optionnel)`);
  } else {
    console.log(`   ✅ ${item.name}: Configuré`);
  }
});

// Vérifier la configuration Agora spécifiquement
console.log('\n🎯 VÉRIFICATION AGORA:');
const agoraAppId = process.env.AGORA_APP_ID;
const agoraCert = process.env.AGORA_APP_CERTIFICATE;

if (agoraAppId && !agoraAppId.includes('votre_')) {
  console.log('   ✅ App ID Agora: Valide');
  
  // Vérifier le format de l'App ID Agora
  if (agoraAppId.length < 10) {
    warnings.push('⚠️  AGORA_APP_ID: Format suspect (trop court)');
  }
} else {
  errors.push('❌ AGORA_APP_ID: Non configuré ou invalide');
}

if (agoraCert && !agoraCert.includes('votre_')) {
  console.log('   ✅ App Certificate Agora: Valide');
  
  // Vérifier le format du certificate
  if (agoraCert.length < 20) {
    warnings.push('⚠️  AGORA_APP_CERTIFICATE: Format suspect (trop court)');
  }
} else {
  errors.push('❌ AGORA_APP_CERTIFICATE: Non configuré ou invalide');
}

// Vérifier la sécurité JWT
console.log('\n🔐 VÉRIFICATION SÉCURITÉ:');
const jwtSecret = process.env.JWT_SECRET;
if (jwtSecret && !jwtSecret.includes('default_') && !jwtSecret.includes('votre_')) {
  if (jwtSecret.length < 32) {
    warnings.push('⚠️  JWT_SECRET: Trop court (minimum 32 caractères recommandé)');
  }
  console.log('   ✅ JWT Secret: Configuré et sécurisé');
} else {
  errors.push('❌ JWT_SECRET: Non configuré ou utilise une valeur par défaut');
}

// Vérifier la configuration de la base de données
console.log('\n🗄️  VÉRIFICATION BASE DE DONNÉES:');
const dbUrl = process.env.DATABASE_URL;
if (dbUrl && !dbUrl.includes('votre_')) {
  console.log('   ✅ Database URL: Configuré');
} else {
  // Vérifier la configuration alternative
  const dbHost = process.env.DB_HOST;
  const dbPassword = process.env.DB_PASSWORD;
  
  if (dbHost && dbPassword && !dbPassword.includes('votre_')) {
    console.log('   ✅ Configuration DB alternative: Valide');
  } else {
    errors.push('❌ Configuration base de données: Non configurée');
  }
}

// Résumé
console.log('\n' + '='.repeat(50));
console.log('📊 RÉSUMÉ DE LA VÉRIFICATION');
console.log('='.repeat(50));

if (errors.length > 0) {
  console.log('\n❌ ERREURS CRITIQUES:');
  errors.forEach(error => console.log(`  ${error}`));
}

if (warnings.length > 0) {
  console.log('\n⚠️  AVERTISSEMENTS:');
  warnings.forEach(warning => console.log(`  ${warning}`));
}

if (hasCriticalErrors) {
  console.log('\n🚨 CONFIGURATION INCOMPLÈTE!');
  console.log('\nActions requises:');
  console.log('1. Copier .env.example vers .env');
  console.log('2. Remplir les valeurs manquantes');
  console.log('3. Obtenir vos credentials Agora sur console.agora.io');
  console.log('4. Configurer votre base de données');
  console.log('5. Générer des secrets JWT sécurisés');
  console.log('\nCommande pour générer un secret JWT:');
  console.log('node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  process.exit(1);
} else if (warnings.length > 0) {
  console.log('\n⚠️  CONFIGURATION PARTIELLE');
  console.log('\nRecommandations:');
  console.log('1. Configurer AWS S3 pour le stockage des fichiers');
  console.log('2. Configurer SMTP pour les emails');
  console.log('3. Configurer Firebase pour les push notifications');
  console.log('\nL\'application peut fonctionner, mais certaines fonctionnalités seront limitées.');
  process.exit(0);
} else {
  console.log('\n✅ CONFIGURATION COMPLÈTE ET VALIDE!');
  console.log('\n✅ Prêt pour le déploiement en production!');
  console.log('\nProchaines étapes:');
  console.log('1. Tester les appels audio/vidéo');
  console.log('2. Tester le stockage de fichiers');
  console.log('3. Tester les emails de notification');
  console.log('4. Déployer sur votre serveur');
  process.exit(0);
}