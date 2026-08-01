const multer = require('multer');
const storageService = require('../services/storage.service');
const logger = require('../utils/logger');
const config = require('../../config/config');
const { asyncHandler } = require('../middleware/error.middleware');

// Configuration Multer pour la mémoire (traitement en mémoire)
const memoryStorage = multer.memoryStorage();

// Filtre de fichiers
const fileFilter = (req, file, cb) => {
  const fileCategory = storageService.getFileCategory(file.mimetype);
  
  if (storageService.validateFileType(file.mimetype, fileCategory)) {
    cb(null, true);
  } else {
    cb(new Error('Type de fichier non supporté'), false);
  }
};

// Configuration Multer
const upload = multer({
  storage: memoryStorage,
  fileFilter,
  limits: {
    fileSize: config.upload.maxFileSize,
  },
});

/**
 * Middleware Multer pour différents types de fichiers
 */
const uploadMiddleware = {
  singleFile: upload.single('file'),
  multipleFiles: upload.array('files', 10), // Maximum 10 fichiers
  audio: upload.single('audio'),
  image: upload.single('image'),
  video: upload.single('video'),
  document: upload.single('document'),
};

/**
 * @desc    Télécharger un fichier générique
 * @route   POST /api/upload
 * @access  Private
 */
const uploadFile = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: 'Aucun fichier fourni',
    });
  }

  const userId = req.userId;
  const file = req.file;

  try {
    const result = await storageService.uploadFile(file, userId);
    
    logger.info(`Fichier téléchargé par l'utilisateur ${userId}: ${file.originalname}`);

    res.json({
      success: true,
      data: result,
      message: 'Fichier téléchargé avec succès',
    });
  } catch (error) {
    logger.error('Erreur lors du téléchargement du fichier:', error);
    
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @desc    Télécharger plusieurs fichiers
 * @route   POST /api/upload/multiple
 * @access  Private
 */
const uploadMultipleFiles = asyncHandler(async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Aucun fichier fourni',
    });
  }

  const userId = req.userId;
  const files = req.files;

  try {
    const uploadPromises = files.map(file => 
      storageService.uploadFile(file, userId)
    );

    const results = await Promise.all(uploadPromises);

    logger.info(`${files.length} fichiers téléchargés par l'utilisateur ${userId}`);

    res.json({
      success: true,
      data: results,
      message: `${files.length} fichiers téléchargés avec succès`,
    });
  } catch (error) {
    logger.error('Erreur lors du téléchargement multiple de fichiers:', error);
    
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @desc    Télécharger un fichier audio
 * @route   POST /api/upload/audio
 * @access  Private
 */
const uploadAudio = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: 'Aucun fichier audio fourni',
    });
  }

  const userId = req.userId;
  const file = req.file;
  const { duration } = req.body; // Durée en secondes

  // Validation de la durée
  if (duration) {
    const durationNum = parseInt(duration);
    
    if (isNaN(durationNum) || durationNum < 1 || durationNum > config.upload.maxAudioDuration) {
      return res.status(400).json({
        success: false,
        error: `Durée audio invalide. Doit être entre 1 et ${config.upload.maxAudioDuration} secondes`,
      });
    }
  }

  try {
    const result = await storageService.uploadAudio(file, userId);
    
    // Ajouter la durée au résultat si fournie
    if (duration) {
      result.audioDuration = parseInt(duration);
    }

    logger.info(`Fichier audio téléchargé par l'utilisateur ${userId}: ${file.originalname}`);

    res.json({
      success: true,
      data: result,
      message: 'Fichier audio téléchargé avec succès',
    });
  } catch (error) {
    logger.error('Erreur lors du téléchargement du fichier audio:', error);
    
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @desc    Télécharger une image
 * @route   POST /api/upload/image
 * @access  Private
 */
const uploadImage = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: 'Aucune image fournie',
    });
  }

  const userId = req.userId;
  const file = req.file;

  try {
    const result = await storageService.uploadImage(file, userId);

    logger.info(`Image téléchargée par l'utilisateur ${userId}: ${file.originalname}`);

    res.json({
      success: true,
      data: result,
      message: 'Image téléchargée avec succès',
    });
  } catch (error) {
    logger.error('Erreur lors du téléchargement de l\'image:', error);
    
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @desc    Télécharger une vidéo
 * @route   POST /api/upload/video
 * @access  Private
 */
const uploadVideo = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: 'Aucune vidéo fournie',
    });
  }

  const userId = req.userId;
  const file = req.file;

  try {
    const result = await storageService.uploadVideo(file, userId);

    logger.info(`Vidéo téléchargée par l'utilisateur ${userId}: ${file.originalname}`);

    res.json({
      success: true,
      data: result,
      message: 'Vidéo téléchargée avec succès',
    });
  } catch (error) {
    logger.error('Erreur lors du téléchargement de la vidéo:', error);
    
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @desc    Télécharger un document
 * @route   POST /api/upload/document
 * @access  Private
 */
const uploadDocument = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: 'Aucun document fourni',
    });
  }

  const userId = req.userId;
  const file = req.file;

  try {
    const result = await storageService.uploadDocument(file, userId);

    logger.info(`Document téléchargé par l'utilisateur ${userId}: ${file.originalname}`);

    res.json({
      success: true,
      data: result,
      message: 'Document téléchargé avec succès',
    });
  } catch (error) {
    logger.error('Erreur lors du téléchargement du document:', error);
    
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @desc    Supprimer un fichier
 * @route   DELETE /api/upload/:fileUrl
 * @access  Private
 */
const deleteFile = asyncHandler(async (req, res) => {
  const { fileUrl } = req.params;
  const userId = req.userId;

  if (!fileUrl) {
    return res.status(400).json({
      success: false,
      error: 'URL du fichier requise',
    });
  }

  try {
    // Vérifier que l'utilisateur a le droit de supprimer ce fichier
    // (Dans une application réelle, vous voudriez vérifier les permissions)
    
    await storageService.deleteFile(fileUrl);

    logger.info(`Fichier supprimé par l'utilisateur ${userId}: ${fileUrl}`);

    res.json({
      success: true,
      message: 'Fichier supprimé avec succès',
    });
  } catch (error) {
    logger.error('Erreur lors de la suppression du fichier:', error);
    
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @desc    Obtenir les informations sur un fichier
 * @route   GET /api/upload/info/:fileUrl
 * @access  Private
 */
const getFileInfo = asyncHandler(async (req, res) => {
  const { fileUrl } = req.params;

  if (!fileUrl) {
    return res.status(400).json({
      success: false,
      error: 'URL du fichier requise',
    });
  }

  try {
    // Extraire les informations du fichier depuis l'URL
    const urlParts = fileUrl.split('/');
    const fileName = urlParts[urlParts.length - 1];
    const fileType = storageService.getFileCategoryFromUrl(fileUrl);

    res.json({
      success: true,
      data: {
        fileName,
        fileUrl,
        fileType,
        storageType: storageService.storageType,
      },
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des informations du fichier:', error);
    
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @desc    Obtenir les statistiques de stockage
 * @route   GET /api/upload/stats
 * @access  Private (Admin seulement dans une application réelle)
 */
const getStorageStats = asyncHandler(async (req, res) => {
  try {
    const stats = await storageService.getStorageStats();

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des statistiques de stockage:', error);
    
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des statistiques',
    });
  }
});

/**
 * @desc    Télécharger un fichier pour un message de chat
 * @route   POST /api/upload/chat/:chatId
 * @access  Private
 */
const uploadChatFile = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: 'Aucun fichier fourni',
    });
  }

  const userId = req.userId;
  const { chatId } = req.params;
  const file = req.file;
  const { messageType } = req.body;

  // Vérifier que l'utilisateur fait partie de la conversation dans Postgres
  const { query } = require('../config/db');
  const participantResult = await query(
    'SELECT 1 FROM public.chat_participants WHERE chat_id = $1 AND user_id = $2',
    [chatId, userId]
  );

  if (participantResult.rows.length === 0) {
    return res.status(403).json({
      success: false,
      error: 'Accès non autorisé à cette conversation',
    });
  }

  try {
    let result;
    const fileCategory = storageService.getFileCategory(file.mimetype);

    // Télécharger selon le type de fichier
    switch (fileCategory) {
      case 'audio':
        result = await storageService.uploadAudio(file, userId);
        break;
      case 'image':
        result = await storageService.uploadImage(file, userId);
        break;
      case 'video':
        result = await storageService.uploadVideo(file, userId);
        break;
      case 'document':
        result = await storageService.uploadDocument(file, userId);
        break;
      default:
        result = await storageService.uploadFile(file, userId);
    }

    logger.info(`Fichier de chat téléchargé: ${file.originalname} pour la conversation ${chatId}`);

    res.json({
      success: true,
      data: {
        ...result,
        chatId,
        messageType: messageType || fileCategory,
      },
      message: 'Fichier téléchargé avec succès pour le chat',
    });
  } catch (error) {
    logger.error('Erreur lors du téléchargement du fichier de chat:', error);
    
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = {
  uploadMiddleware,
  uploadFile,
  uploadMultipleFiles,
  uploadAudio,
  uploadImage,
  uploadVideo,
  uploadDocument,
  deleteFile,
  getFileInfo,
  getStorageStats,
  uploadChatFile,
};