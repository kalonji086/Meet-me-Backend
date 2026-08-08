#!/usr/bin/env node
/**
 * Script de keep-alive pour Render.com
 * Ping le serveur toutes les 10 minutes pour éviter l'endormissement
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// URL du backend
const BACKEND_URL = process.env.BACKEND_URL || 'https://meet-me-backend-sg5c.onrender.com';
const PING_INTERVAL = 10 * 60 * 1000; // 10 minutes
const LOG_FILE = path.join(__dirname, '..', 'logs', 'keep-alive.log');

// Créer le dossier logs si nécessaire
if (!fs.existsSync(path.dirname(LOG_FILE))) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
}

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(logMessage);
  
  // Écrire dans le fichier log
  fs.appendFileSync(LOG_FILE, logMessage, 'utf8');
}

async function pingServer() {
  try {
    const startTime = Date.now();
    const response = await axios.get(`${BACKEND_URL}/api/ping`, {
      timeout: 30000
    });
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    log(`✅ Ping réussi: ${response.status} - ${duration}ms - ${JSON.stringify(response.data)}`);
    return true;
  } catch (error) {
    log(`❌ Échec du ping: ${error.message}`);
    
    // Essayer aussi la racine
    try {
      const response = await axios.get(`${BACKEND_URL}/`, {
        timeout: 30000
      });
      log(`✅ Racine accessible: ${response.status}`);
      return true;
    } catch (rootError) {
      log(`❌ Racine inaccessible: ${rootError.message}`);
      return false;
    }
  }
}

// Fonction principale
async function main() {
  log('🚀 Démarrage du script keep-alive');
  log(`📡 URL cible: ${BACKEND_URL}`);
  log(`⏱️ Intervalle: ${PING_INTERVAL / 60000} minutes`);
  
  // Premier ping immédiat
  await pingServer();
  
  // Puis toutes les 10 minutes
  setInterval(async () => {
    await pingServer();
  }, PING_INTERVAL);
  
  // Gérer la fermeture propre
  process.on('SIGINT', () => {
    log('🛑 Arrêt du script keep-alive');
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    log('🛑 Arrêt du script keep-alive (SIGTERM)');
    process.exit(0);
  });
}

// Démarrer
if (require.main === module) {
  main().catch(error => {
    log(`💥 Erreur fatale: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
}

module.exports = { pingServer };