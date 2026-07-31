const express = require('express');
const router = express.Router();
const uploadController = require('../controllers/upload.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { asyncHandler } = require('../middleware/error.middleware');

/**
 * @route   POST /api/upload
 * @desc    Télécharger un fichier générique
 * @access  Private
 */
router.post(
  '/',
  authenticate,
  uploadController.uploadMiddleware.singleFile,
  asyncHandler(uploadController.uploadFile)
);

/**
 * @route   POST /api/upload/multiple
 * @desc    Télécharger plusieurs fichiers
 * @access  Private
 */
router.post(
  '/multiple',
  authenticate,
  uploadController.uploadMiddleware.multipleFiles,
  asyncHandler(uploadController.uploadMultipleFiles)
);

/**
 * @route   POST /api/upload/audio
 * @desc    Télécharger un fichier audio
 * @access  Private
 */
router.post(
  '/audio',
  authenticate,
  uploadController.uploadMiddleware.audio,
  asyncHandler(uploadController.uploadAudio)
);

/**
 * @route   POST /api/upload/image
 * @desc    Télécharger une image
 * @access  Private
 */
router.post(
  '/image',
  authenticate,
  uploadController.uploadMiddleware.image,
  asyncHandler(uploadController.uploadImage)
);

/**
 * @route   POST /api/upload/video
 * @desc    Télécharger une vidéo
 * @access  Private
 */
router.post(
  '/video',
  authenticate,
  uploadController.uploadMiddleware.video,
  asyncHandler(uploadController.uploadVideo)
);

/**
 * @route   POST /api/upload/document
 * @desc    Télécharger un document
 * @access  Private
 */
router.post(
  '/document',
  authenticate,
  uploadController.uploadMiddleware.document,
  asyncHandler(uploadController.uploadDocument)
);

/**
 * @route   DELETE /api/upload/:fileUrl
 * @desc    Supprimer un fichier
 * @access  Private
 */
router.delete(
  '/:fileUrl',
  authenticate,
  asyncHandler(uploadController.deleteFile)
);

/**
 * @route   GET /api/upload/info/:fileUrl
 * @desc    Obtenir les informations sur un fichier
 * @access  Private
 */
router.get(
  '/info/:fileUrl',
  authenticate,
  asyncHandler(uploadController.getFileInfo)
);

/**
 * @route   GET /api/upload/stats
 * @desc    Obtenir les statistiques de stockage
 * @access  Private
 */
router.get(
  '/stats',
  authenticate,
  asyncHandler(uploadController.getStorageStats)
);

/**
 * @route   POST /api/upload/chat/:chatId
 * @desc    Télécharger un fichier pour un message de chat
 * @access  Private
 */
router.post(
  '/chat/:chatId',
  authenticate,
  uploadController.uploadMiddleware.singleFile,
  asyncHandler(uploadController.uploadChatFile)
);

module.exports = router;