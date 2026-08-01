const express = require('express');
const router = express.Router();
const statusController = require('../controllers/status.controller');
const { authenticate } = require('../middleware/auth.middleware');

const statusReactionController = require('../controllers/status_reaction.controller');

router.use(authenticate);

/**
 * @route   POST /api/statuses
 * @desc    Créer un status
 */
router.post('/', statusController.createStatus);

/**
 * @route   GET /api/statuses
 * @desc    Obtenir les status des contacts
 */
router.get('/', statusController.getStatuses);

/**
 * @route   DELETE /api/statuses/:id
 * @desc    Supprimer un status
 */
router.delete('/:id', statusController.deleteStatus);

/**
 * @route   POST /api/statuses/:statusId/reactions
 * @desc    Ajouter une réaction ou un commentaire
 */
router.post('/:statusId/reactions', statusReactionController.addReaction);

/**
 * @route   GET /api/statuses/:statusId/reactions
 * @desc    Obtenir les réactions pour un status
 */
router.get('/:statusId/reactions', statusReactionController.getReactions);

module.exports = router;
