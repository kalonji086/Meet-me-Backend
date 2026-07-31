const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');
const config = require('../../config/config');

class StorageService {
  constructor() {
    this.storageType = 'local';
    this.initializeStorage();
  }

  initializeStorage() {
    logger.info('✅ Stockage local configuré (AWS S3 désactivé)');

    // Créer le dossier racine uploads s'il n'existe pas
    const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
  }

  /**
   * Générer un nom de fichier unique
   */
  generateFileName(originalName, userId) {
    const timestamp = Date.now();
    const randomString = crypto.randomBytes(8).toString('hex');
    const extension = path.extname(originalName);
    const baseName = path.basename(originalName, extension);
    
    const cleanBaseName = baseName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    return `${userId}/${timestamp}-${randomString}-${cleanBaseName}${extension}`;
  }

  /**
   * Télécharger un fichier
   */
  async uploadFile(file, userId, fileType = 'general') {
    try {
      const fileName = this.generateFileName(file.originalname, userId);
      const fileBuffer = file.buffer;
      const mimeType = file.mimetype;
      const fileSize = file.size;

      if (fileSize > config.upload.maxFileSize) {
        throw new Error(`Fichier trop volumineux. Taille maximale: ${config.upload.maxFileSize / (1024 * 1024)}MB`);
      }

      const fileUrl = await this.saveLocally(fileName, fileBuffer, fileType);

      logger.info(`Fichier téléchargé localement: ${fileName} (${fileSize} bytes)`);

      return {
        success: true,
        fileName: file.originalname,
        fileUrl,
        fileSize,
        mimeType,
        storageType: 'local',
      };
    } catch (error) {
      logger.error('Erreur lors du téléchargement du fichier:', error);
      throw error;
    }
  }

  /**
   * Sauvegarder localement
   */
  async saveLocally(fileName, fileBuffer, fileType) {
    const uploadDir = path.join(__dirname, '..', '..', 'uploads', fileType);
    
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const filePath = path.join(uploadDir, fileName);
    
    const dirName = path.dirname(filePath);
    if (!fs.existsSync(dirName)) {
      fs.mkdirSync(dirName, { recursive: true });
    }

    fs.writeFileSync(filePath, fileBuffer);
    return `/uploads/${fileType}/${fileName}`;
  }

  /**
   * Supprimer un fichier
   */
  async deleteFile(fileUrl) {
    try {
      const urlParts = fileUrl.split('/uploads/');
      if (urlParts.length < 2) {
        throw new Error('URL de fichier local invalide');
      }

      const relativePath = urlParts[1];
      const filePath = path.join(__dirname, '..', '..', 'uploads', relativePath);

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      logger.info(`Fichier supprimé: ${fileUrl}`);
      return { success: true };
    } catch (error) {
      logger.error('Erreur lors de la suppression du fichier:', error);
      throw error;
    }
  }

  getFileUrl(fileName, fileType = 'general') {
    return `/uploads/${fileType}/${fileName}`;
  }

  validateFileType(mimeType, fileCategory) {
    const allowedTypes = {
      image: config.upload.allowedImageTypes,
      audio: config.upload.allowedAudioTypes,
      video: config.upload.allowedVideoTypes,
      document: config.upload.allowedDocumentTypes,
      general: [
        ...config.upload.allowedImageTypes,
        ...config.upload.allowedAudioTypes,
        ...config.upload.allowedVideoTypes,
        ...config.upload.allowedDocumentTypes,
      ],
    };

    const allowed = allowedTypes[fileCategory] || allowedTypes.general;
    return allowed.includes(mimeType);
  }

  getFileCategory(mimeType) {
    if (config.upload.allowedImageTypes.includes(mimeType)) return 'image';
    if (config.upload.allowedAudioTypes.includes(mimeType)) return 'audio';
    if (config.upload.allowedVideoTypes.includes(mimeType)) return 'video';
    if (config.upload.allowedDocumentTypes.includes(mimeType)) return 'document';
    return 'general';
  }

  async uploadAudio(file, userId) {
    if (!this.validateFileType(file.mimetype, 'audio')) throw new Error('Type de fichier audio non supporté');
    return this.uploadFile(file, userId, 'audio');
  }

  async uploadImage(file, userId) {
    if (!this.validateFileType(file.mimetype, 'image')) throw new Error('Type de fichier image non supporté');
    return this.uploadFile(file, userId, 'images');
  }

  async getStorageStats() {
    try {
      const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
      if (!fs.existsSync(uploadsDir)) return { storageType: 'local', totalFiles: 0, totalSize: 0 };

      let totalFiles = 0;
      let totalSize = 0;
      const countFiles = (dir) => {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        items.forEach(item => {
          const fullPath = path.join(dir, item.name);
          if (item.isDirectory()) countFiles(fullPath);
          else {
            totalFiles++;
            totalSize += fs.statSync(fullPath).size;
          }
        });
      };
      countFiles(uploadsDir);
      return { storageType: 'local', totalFiles, totalSize, totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2) };
    } catch (error) {
      return { storageType: 'local', error: error.message };
    }
  }
}

const storageService = new StorageService();
module.exports = storageService;
