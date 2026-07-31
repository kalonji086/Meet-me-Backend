const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');
const config = require('../../config/config');

class StorageService {
  constructor() {
    this.storageType = config.aws.accessKeyId ? 's3' : 'local';
    this.initializeStorage();
  }

  initializeStorage() {
    if (this.storageType === 's3') {
      // Configuration AWS S3
      AWS.config.update({
        accessKeyId: config.aws.accessKeyId,
        secretAccessKey: config.aws.secretAccessKey,
        region: config.aws.region,
      });

      this.s3 = new AWS.S3();
      logger.info('✅ Stockage AWS S3 configuré');
    } else {
      logger.info('✅ Stockage local configuré');
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
    
    // Nettoyer le nom de base
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

      // Vérifier la taille du fichier
      if (fileSize > config.upload.maxFileSize) {
        throw new Error(`Fichier trop volumineux. Taille maximale: ${config.upload.maxFileSize / (1024 * 1024)}MB`);
      }

      let fileUrl;

      if (this.storageType === 's3') {
        // Upload vers S3
        fileUrl = await this.uploadToS3(fileName, fileBuffer, mimeType);
      } else {
        // Sauvegarder localement
        fileUrl = await this.saveLocally(fileName, fileBuffer, fileType);
      }

      logger.info(`Fichier téléchargé: ${fileName} (${fileSize} bytes)`);

      return {
        success: true,
        fileName: file.originalname,
        fileUrl,
        fileSize,
        mimeType,
        storageType: this.storageType,
      };
    } catch (error) {
      logger.error('Erreur lors du téléchargement du fichier:', error);
      throw error;
    }
  }

  /**
   * Upload vers AWS S3
   */
  async uploadToS3(fileName, fileBuffer, mimeType) {
    const params = {
      Bucket: config.aws.s3Bucket,
      Key: fileName,
      Body: fileBuffer,
      ContentType: mimeType,
      ACL: 'public-read', // Ou 'private' selon les besoins de sécurité
    };

    const result = await this.s3.upload(params).promise();
    return result.Location;
  }

  /**
   * Sauvegarder localement
   */
  async saveLocally(fileName, fileBuffer, fileType) {
    const uploadDir = path.join(__dirname, '..', '..', 'uploads', fileType);
    
    // Créer le répertoire s'il n'existe pas
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const filePath = path.join(uploadDir, fileName);
    
    // Créer les sous-répertoires si nécessaire
    const dirName = path.dirname(filePath);
    if (!fs.existsSync(dirName)) {
      fs.mkdirSync(dirName, { recursive: true });
    }

    // Écrire le fichier
    fs.writeFileSync(filePath, fileBuffer);

    // Retourner l'URL relative
    return `/uploads/${fileType}/${fileName}`;
  }

  /**
   * Supprimer un fichier
   */
  async deleteFile(fileUrl) {
    try {
      if (this.storageType === 's3') {
        await this.deleteFromS3(fileUrl);
      } else {
        await this.deleteLocalFile(fileUrl);
      }

      logger.info(`Fichier supprimé: ${fileUrl}`);
      return { success: true };
    } catch (error) {
      logger.error('Erreur lors de la suppression du fichier:', error);
      throw error;
    }
  }

  /**
   * Supprimer d'AWS S3
   */
  async deleteFromS3(fileUrl) {
    // Extraire la clé S3 de l'URL
    const urlParts = fileUrl.split('/');
    const key = urlParts.slice(3).join('/'); // Supprimer https://s3.region.amazonaws.com/bucket/

    const params = {
      Bucket: config.aws.s3Bucket,
      Key: key,
    };

    await this.s3.deleteObject(params).promise();
  }

  /**
   * Supprimer localement
   */
  async deleteLocalFile(fileUrl) {
    // Extraire le chemin du fichier de l'URL
    const urlParts = fileUrl.split('/uploads/');
    if (urlParts.length < 2) {
      throw new Error('URL de fichier local invalide');
    }

    const relativePath = urlParts[1];
    const filePath = path.join(__dirname, '..', '..', 'uploads', relativePath);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  /**
   * Obtenir l'URL d'un fichier
   */
  getFileUrl(fileName, fileType = 'general') {
    if (this.storageType === 's3') {
      return `https://${config.aws.s3Bucket}.s3.${config.aws.region}.amazonaws.com/${fileName}`;
    } else {
      return `/uploads/${fileType}/${fileName}`;
    }
  }

  /**
   * Vérifier le type de fichier
   */
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

  /**
   * Obtenir la catégorie d'un fichier
   */
  getFileCategory(mimeType) {
    if (config.upload.allowedImageTypes.includes(mimeType)) {
      return 'image';
    } else if (config.upload.allowedAudioTypes.includes(mimeType)) {
      return 'audio';
    } else if (config.upload.allowedVideoTypes.includes(mimeType)) {
      return 'video';
    } else if (config.upload.allowedDocumentTypes.includes(mimeType)) {
      return 'document';
    } else {
      return 'general';
    }
  }

  /**
   * Télécharger un fichier audio avec validation spécifique
   */
  async uploadAudio(file, userId) {
    // Validation spécifique aux fichiers audio
    if (!this.validateFileType(file.mimetype, 'audio')) {
      throw new Error('Type de fichier audio non supporté');
    }

    // Vérifier la durée si disponible (pour les fichiers audio existants)
    // Note: Pour les enregistrements en temps réel, la durée sera fournie séparément

    return this.uploadFile(file, userId, 'audio');
  }

  /**
   * Télécharger une image avec validation spécifique
   */
  async uploadImage(file, userId) {
    if (!this.validateFileType(file.mimetype, 'image')) {
      throw new Error('Type de fichier image non supporté');
    }

    return this.uploadFile(file, userId, 'images');
  }

  /**
   * Télécharger une vidéo avec validation spécifique
   */
  async uploadVideo(file, userId) {
    if (!this.validateFileType(file.mimetype, 'video')) {
      throw new Error('Type de fichier vidéo non supporté');
    }

    return this.uploadFile(file, userId, 'videos');
  }

  /**
   * Télécharger un document avec validation spécifique
   */
  async uploadDocument(file, userId) {
    if (!this.validateFileType(file.mimetype, 'document')) {
      throw new Error('Type de fichier document non supporté');
    }

    return this.uploadFile(file, userId, 'documents');
  }

  /**
   * Obtenir les statistiques de stockage
   */
  async getStorageStats() {
    if (this.storageType === 's3') {
      return this.getS3Stats();
    } else {
      return this.getLocalStats();
    }
  }

  /**
   * Obtenir les statistiques S3
   */
  async getS3Stats() {
    try {
      const params = {
        Bucket: config.aws.s3Bucket,
      };

      const data = await this.s3.listObjectsV2(params).promise();
      
      return {
        storageType: 's3',
        totalFiles: data.KeyCount,
        bucket: config.aws.s3Bucket,
        region: config.aws.region,
      };
    } catch (error) {
      logger.error('Erreur lors de la récupération des statistiques S3:', error);
      return { storageType: 's3', error: error.message };
    }
  }

  /**
   * Obtenir les statistiques locales
   */
  async getLocalStats() {
    try {
      const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
      
      if (!fs.existsSync(uploadsDir)) {
        return { storageType: 'local', totalFiles: 0, totalSize: 0 };
      }

      let totalFiles = 0;
      let totalSize = 0;

      const countFiles = (dir) => {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        
        items.forEach(item => {
          const fullPath = path.join(dir, item.name);
          
          if (item.isDirectory()) {
            countFiles(fullPath);
          } else {
            totalFiles++;
            const stats = fs.statSync(fullPath);
            totalSize += stats.size;
          }
        });
      };

      countFiles(uploadsDir);

      return {
        storageType: 'local',
        totalFiles,
        totalSize,
        totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      };
    } catch (error) {
      logger.error('Erreur lors de la récupération des statistiques locales:', error);
      return { storageType: 'local', error: error.message };
    }
  }

  /**
   * Nettoyer les fichiers temporaires
   */
  async cleanupTempFiles(maxAgeHours = 24) {
    try {
      if (this.storageType === 'local') {
        return this.cleanupLocalTempFiles(maxAgeHours);
      }
      // Pour S3, vous pourriez implémenter une politique de cycle de vie
      return { success: true, message: 'Cleanup non implémenté pour S3' };
    } catch (error) {
      logger.error('Erreur lors du nettoyage des fichiers temporaires:', error);
      throw error;
    }
  }

  /**
   * Nettoyer les fichiers temporaires locaux
   */
  async cleanupLocalTempFiles(maxAgeHours) {
    const tempDir = path.join(__dirname, '..', '..', 'uploads', 'temp');
    
    if (!fs.existsSync(tempDir)) {
      return { success: true, deleted: 0 };
    }

    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const now = Date.now();
    let deletedCount = 0;

    const cleanupDirectory = (dir) => {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      
      items.forEach(item => {
        const fullPath = path.join(dir, item.name);
        
        if (item.isDirectory()) {
          cleanupDirectory(fullPath);
          
          // Supprimer le répertoire s'il est vide
          try {
            fs.rmdirSync(fullPath);
          } catch (e) {
            // Le répertoire n'est pas vide, c'est normal
          }
        } else {
          const stats = fs.statSync(fullPath);
          const fileAge = now - stats.mtimeMs;
          
          if (fileAge > maxAgeMs) {
            fs.unlinkSync(fullPath);
            deletedCount++;
            logger.debug(`Fichier temporaire supprimé: ${fullPath}`);
          }
        }
      });
    };

    cleanupDirectory(tempDir);

    logger.info(`Nettoyage des fichiers temporaires: ${deletedCount} fichiers supprimés`);
    
    return {
      success: true,
      deleted: deletedCount,
      maxAgeHours,
    };
  }
}

// Singleton pattern
const storageService = new StorageService();

module.exports = storageService;