const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const sharp = require('sharp');
const logger = require('../utils/logger');
const config = require('../../config/config');

class StorageService {
  constructor() {
    this.supabase = createClient(
      config.database.supabaseUrl,
      config.database.supabaseKey
    );
    this.bucketName = 'meet-me-media';
  }

  /**
   * Amélioration automatique de la qualité de l'image (IA/Sharp)
   */
  async enhanceImage(buffer, mimetype) {
    try {
      logger.info('✨ Amélioration de la qualité de l\'image en cours...');

      let pipeline = sharp(buffer);

      // 1. Redimensionnement intelligent pour garder la netteté
      pipeline = pipeline.resize(800, 800, {
        fit: 'inside',
        withoutEnlargement: true
      });

      // 2. Traitement de la clarté et du contraste
      pipeline = pipeline
        .normalize() // Ajuste automatiquement le contraste et la luminosité
        .sharpen({ // Augmente la netteté pour corriger le flou
          sigma: 1.2,
          m1: 1.0,
          m2: 15
        })
        .modulate({
          brightness: 1.02, // Légère augmentation de luminosité
          saturation: 1.05  // Rend les couleurs un peu plus vives
        });

      // 3. Conversion en format optimisé (WebP pour la qualité/poids)
      // Si c'est un avatar, on force un format propre
      const enhancedBuffer = await pipeline.webp({ quality: 85 }).toBuffer();

      return {
        buffer: enhancedBuffer,
        mimetype: 'image/webp',
        extension: 'webp'
      };
    } catch (error) {
      logger.error('Erreur lors de l\'amélioration de l\'image:', error);
      return { buffer, mimetype, extension: null }; // Retourne l'original en cas d'échec
    }
  }

  /**
   * S'assure que le dossier existe avant l'upload
   */
  async ensureBucketExists() {
    try {
      const { data: buckets } = await this.supabase.storage.listBuckets();
      const exists = buckets && buckets.some(b => b.name === this.bucketName);

      if (!exists) {
        logger.info(`⏳ Création du bucket manquant : ${this.bucketName}`);
        await this.supabase.storage.createBucket(this.bucketName, {
          public: true
        });
      }
    } catch (e) {
      logger.warn('Note: Impossible de vérifier/créer le bucket (souvent dû aux restrictions de la clé API)');
    }
  }

  generateFileName(originalName, userId) {
    const timestamp = Date.now();
    const randomString = crypto.randomBytes(4).toString('hex');
    const extension = originalName.split('.').pop();
    return `${userId}/${timestamp}-${randomString}.${extension}`;
  }

  async uploadFile(file, userId, fileType = 'general') {
    try {
      // S'assurer que le dossier existe
      await this.ensureBucketExists();

      let buffer = file.buffer;
      let mimetype = file.mimetype;
      let originalName = file.originalname || 'file';

      // Si c'est une image, on l'améliore avant l'upload
      if (mimetype.startsWith('image/')) {
        const enhanced = await this.enhanceImage(buffer, mimetype);
        buffer = enhanced.buffer;
        mimetype = enhanced.mimetype;
        if (enhanced.extension) {
          originalName = originalName.split('.')[0] + '.' + enhanced.extension;
        }
      }

      const fileName = this.generateFileName(originalName, userId);
      const filePath = `${fileType}/${fileName}`;

      // Configurer le type de contenu et s'assurer que c'est public
      const { data, error } = await this.supabase.storage
        .from(this.bucketName)
        .upload(filePath, buffer, {
          contentType: mimetype,
          cacheControl: '0',
          upsert: true
        });

      if (error) {
        // Si l'erreur est "Bucket not found", on essaie une dernière fois de le créer
        if (error.message === 'Bucket not found') {
           throw new Error("Le dossier 'meet-me-media' n'existe pas sur Supabase. Veuillez le créer manuellement dans l'onglet 'Storage' de votre tableau de bord Supabase.");
        }
        throw error;
      }

      const { data: { publicUrl } } = this.supabase.storage
        .from(this.bucketName)
        .getPublicUrl(filePath);

      return {
        success: true,
        fileUrl: publicUrl,
        fileName: file.originalname,
        fileSize: file.size,
        mimeType: file.mimetype,
        storageType: 'supabase',
      };
    } catch (error) {
      logger.error('Erreur finale upload Supabase:', error.message);
      throw error;
    }
  }

  async uploadImage(file, userId) {
    return this.uploadFile(file, userId, 'images');
  }

  async uploadAudio(file, userId) {
    return this.uploadFile(file, userId, 'audio');
  }

  async uploadDocument(file, userId) {
    return this.uploadFile(file, userId, 'documents');
  }

  async uploadVideo(file, userId) {
    return this.uploadFile(file, userId, 'videos');
  }

  async deleteFile(fileUrl) {
    try {
      const parts = fileUrl.split(`${this.bucketName}/`);
      if (parts.length > 1) {
        await this.supabase.storage.from(this.bucketName).remove([parts[1]]);
      }
      return { success: true };
    } catch (e) { return { success: false }; }
  }

  getFileCategory(mimeType) {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    return 'document';
  }

  validateFileType() { return true; }
}

const storageService = new StorageService();
module.exports = storageService;
