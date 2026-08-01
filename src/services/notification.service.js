const { Expo } = require('expo-server-sdk');
const logger = require('../utils/logger');

class NotificationService {
  constructor() {
    this.expo = new Expo();
  }

  /**
   * Envoyer une notification push via Expo
   * @param {string} pushToken - Le token Expo de l'utilisateur
   * @param {object} payload - Le contenu de la notification
   */
  async sendNotification(pushToken, payload) {
    if (!Expo.isExpoPushToken(pushToken)) {
      logger.error(`Token de notification invalide: ${pushToken}`);
      return;
    }

    const messages = [{
      to: pushToken,
      sound: 'default',
      title: payload.title,
      body: payload.body,
      data: payload.data || {},
      priority: 'high',
      channelId: 'default',
    }];

    try {
      const chunks = this.expo.chunkPushNotifications(messages);
      for (let chunk of chunks) {
        try {
          const ticketChunk = await this.expo.sendPushNotificationsAsync(chunk);
          logger.info('Notification envoyée avec succès', ticketChunk);
          // Note: Dans une version plus poussée, on vérifierait les tickets pour gérer les tokens obsolètes
        } catch (error) {
          logger.error('Erreur lors de l\'envoi du chunk de notification:', error);
        }
      }
    } catch (error) {
      logger.error('Erreur lors de la préparation de la notification:', error);
    }
  }

  /**
   * Envoyer une notification de nouveau message
   * @param {string} pushToken - Token du destinataire
   * @param {string} senderName - Nom de l'expéditeur
   * @param {string} messageContent - Contenu du message
   * @param {string} chatId - ID de la conversation
   */
  async sendNewMessageNotification(pushToken, senderName, messageContent, chatId) {
    await this.sendNotification(pushToken, {
      title: senderName,
      body: messageContent,
      data: { chatId, type: 'new_message' }
    });
  }
}

module.exports = new NotificationService();
