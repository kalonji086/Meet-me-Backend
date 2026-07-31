const logger = require('../utils/logger');
const User = require('../models/User.model');
const Chat = require('../models/Chat.model');
const Message = require('../models/Message.model');

class SocketService {
  constructor() {
    this.io = null;
    this.connectedUsers = new Map(); // socketId -> userId
    this.userSockets = new Map(); // userId -> socketId
  }

  initialize(io) {
    this.io = io;

    io.on('connection', (socket) => {
      logger.socket('connection', socket.id);

      // Authentification du socket
      socket.on('authenticate', async (data) => {
        await this.handleAuthentication(socket, data);
      });

      // Rejoindre une conversation
      socket.on('join_chat', (chatId) => {
        this.handleJoinChat(socket, chatId);
      });

      // Quitter une conversation
      socket.on('leave_chat', (chatId) => {
        this.handleLeaveChat(socket, chatId);
      });

      // Envoyer un message
      socket.on('send_message', async (data) => {
        await this.handleSendMessage(socket, data);
      });

      // Marquer un message comme lu
      socket.on('mark_as_read', async (data) => {
        await this.handleMarkAsRead(socket, data);
      });

      // Marquer un message comme délivré
      socket.on('mark_as_delivered', async (data) => {
        await this.handleMarkAsDelivered(socket, data);
      });

      // Réagir à un message
      socket.on('react_to_message', async (data) => {
        await this.handleReaction(socket, data);
      });

      // Éditer un message
      socket.on('edit_message', async (data) => {
        await this.handleEditMessage(socket, data);
      });

      // Supprimer un message
      socket.on('delete_message', async (data) => {
        await this.handleDeleteMessage(socket, data);
      });

      // Mettre à jour le statut utilisateur
      socket.on('update_status', async (data) => {
        await this.handleUpdateStatus(socket, data);
      });

      // Typing indicator
      socket.on('typing', (data) => {
        this.handleTyping(socket, data);
      });

      // Stop typing
      socket.on('stop_typing', (data) => {
        this.handleStopTyping(socket, data);
      });

      // Déconnexion
      socket.on('disconnect', async () => {
        await this.handleDisconnect(socket);
      });

      // Gestion des erreurs
      socket.on('error', (error) => {
        logger.error('Erreur Socket.IO:', error);
      });
    });
  }

  /**
   * Gérer l'authentification du socket
   */
  async handleAuthentication(socket, data) {
    try {
      const { userId, token } = data;

      if (!userId || !token) {
        socket.emit('authentication_error', { error: 'Données d\'authentification manquantes' });
        return;
      }

      // Vérifier l'utilisateur
      const user = await User.findById(userId);
      
      if (!user) {
        socket.emit('authentication_error', { error: 'Utilisateur non trouvé' });
        return;
      }

      // Stocker la connexion
      this.connectedUsers.set(socket.id, userId);
      this.userSockets.set(userId.toString(), socket.id);

      // Mettre à jour le statut de l'utilisateur
      await user.updateStatus('online', socket.id);

      // Rejoindre la room de l'utilisateur
      socket.join(`user:${userId}`);

      // Notifier les autres utilisateurs
      this.notifyUserStatusChange(userId, 'online');

      logger.socket('authenticated', socket.id, { userId: user._id, email: user.email });

      socket.emit('authenticated', {
        success: true,
        user: user.getPublicProfile(),
      });

      // Envoyer la liste des conversations actives
      await this.sendUserChats(socket, userId);

    } catch (error) {
      logger.error('Erreur d\'authentification Socket.IO:', error);
      socket.emit('authentication_error', { error: 'Erreur d\'authentification' });
    }
  }

  /**
   * Gérer la connexion à une conversation
   */
  handleJoinChat(socket, chatId) {
    const userId = this.connectedUsers.get(socket.id);
    
    if (!userId) {
      socket.emit('error', { error: 'Non authentifié' });
      return;
    }

    socket.join(`chat:${chatId}`);
    logger.socket('join_chat', socket.id, { chatId, userId });
  }

  /**
   * Gérer la déconnexion d'une conversation
   */
  handleLeaveChat(socket, chatId) {
    const userId = this.connectedUsers.get(socket.id);
    
    if (!userId) {
      socket.emit('error', { error: 'Non authentifié' });
      return;
    }

    socket.leave(`chat:${chatId}`);
    logger.socket('leave_chat', socket.id, { chatId, userId });
  }

  /**
   * Gérer l'envoi d'un message
   */
  async handleSendMessage(socket, data) {
    try {
      const userId = this.connectedUsers.get(socket.id);
      
      if (!userId) {
        socket.emit('error', { error: 'Non authentifié' });
        return;
      }

      const { chatId, content, type, replyTo, audioDuration, fileName, fileSize } = data;

      // Vérifier la conversation
      const chat = await Chat.findById(chatId);
      
      if (!chat) {
        socket.emit('error', { error: 'Conversation non trouvée' });
        return;
      }

      if (!chat.isParticipant(userId)) {
        socket.emit('error', { error: 'Vous ne faites pas partie de cette conversation' });
        return;
      }

      // Créer le message
      const messageData = {
        chat: chatId,
        sender: userId,
        type: type || 'text',
        content: content || '',
        replyTo: replyTo || null,
      };

      // Ajouter les données spécifiques au type
      if (type === 'audio') {
        messageData.audioDuration = audioDuration;
      } else if (['image', 'video', 'file'].includes(type)) {
        messageData.fileName = fileName;
        messageData.fileSize = fileSize;
      }

      const message = new Message(messageData);
      await message.save();

      // Mettre à jour le dernier message de la conversation
      await chat.updateLastMessage(message._id);

      // Populer les données du message
      await message.populate('sender', 'name avatar');
      await message.populate({
        path: 'replyTo',
        select: 'content type sender createdAt',
        populate: {
          path: 'sender',
          select: 'name avatar',
        },
      });

      // Préparer les données du message pour l'envoi
      const messageDataToSend = message.getMessageInfo();

      // Envoyer le message à tous les participants de la conversation
      this.io.to(`chat:${chatId}`).emit('new_message', {
        chatId,
        message: messageDataToSend,
      });

      // Marquer le message comme délivré pour l'expéditeur
      await message.markAsDelivered(userId);

      // Notifier les autres participants (hors expéditeur)
      const otherParticipants = chat.participants.filter(p => 
        p.toString() !== userId.toString()
      );

      otherParticipants.forEach(participantId => {
        const participantSocketId = this.userSockets.get(participantId.toString());
        
        if (participantSocketId) {
          // Marquer comme délivré pour les utilisateurs en ligne
          message.markAsDelivered(participantId);
          
          // Envoyer une notification push (si configuré)
          this.sendPushNotification(participantId, {
            title: message.sender.name,
            body: type === 'text' ? content : `Nouveau message ${type}`,
            data: { chatId, messageId: message._id },
          });
        }
      });

      logger.socket('message_sent', socket.id, {
        chatId,
        messageId: message._id,
        type: message.type,
      });

      // Confirmer l'envoi à l'expéditeur
      socket.emit('message_sent', {
        success: true,
        message: messageDataToSend,
      });

    } catch (error) {
      logger.error('Erreur lors de l\'envoi du message:', error);
      socket.emit('error', { error: 'Erreur lors de l\'envoi du message' });
    }
  }

  /**
   * Gérer la lecture d'un message
   */
  async handleMarkAsRead(socket, data) {
    try {
      const userId = this.connectedUsers.get(socket.id);
      
      if (!userId) {
        socket.emit('error', { error: 'Non authentifié' });
        return;
      }

      const { messageId } = data;

      const message = await Message.findById(messageId);
      
      if (!message) {
        socket.emit('error', { error: 'Message non trouvé' });
        return;
      }

      // Vérifier que l'utilisateur est dans la conversation
      const chat = await Chat.findById(message.chat);
      
      if (!chat || !chat.isParticipant(userId)) {
        socket.emit('error', { error: 'Accès non autorisé' });
        return;
      }

      // Marquer comme lu
      await message.markAsRead(userId);

      // Notifier l'expéditeur que son message a été lu
      const senderSocketId = this.userSockets.get(message.sender.toString());
      
      if (senderSocketId && senderSocketId !== socket.id) {
        this.io.to(senderSocketId).emit('message_read', {
          messageId: message._id,
          readBy: userId,
          readAt: new Date(),
        });
      }

      socket.emit('marked_as_read', {
        success: true,
        messageId: message._id,
      });

    } catch (error) {
      logger.error('Erreur lors du marquage comme lu:', error);
      socket.emit('error', { error: 'Erreur lors du marquage comme lu' });
    }
  }

  /**
   * Gérer la délivrance d'un message
   */
  async handleMarkAsDelivered(socket, data) {
    try {
      const userId = this.connectedUsers.get(socket.id);
      
      if (!userId) {
        socket.emit('error', { error: 'Non authentifié' });
        return;
      }

      const { messageId } = data;

      const message = await Message.findById(messageId);
      
      if (!message) {
        socket.emit('error', { error: 'Message non trouvé' });
        return;
      }

      // Vérifier que l'utilisateur est dans la conversation
      const chat = await Chat.findById(message.chat);
      
      if (!chat || !chat.isParticipant(userId)) {
        socket.emit('error', { error: 'Accès non autorisé' });
        return;
      }

      // Marquer comme délivré
      await message.markAsDelivered(userId);

      // Notifier l'expéditeur que son message a été délivré
      const senderSocketId = this.userSockets.get(message.sender.toString());
      
      if (senderSocketId && senderSocketId !== socket.id) {
        this.io.to(senderSocketId).emit('message_delivered', {
          messageId: message._id,
          deliveredTo: userId,
        });
      }

      socket.emit('marked_as_delivered', {
        success: true,
        messageId: message._id,
      });

    } catch (error) {
      logger.error('Erreur lors du marquage comme délivré:', error);
      socket.emit('error', { error: 'Erreur lors du marquage comme délivré' });
    }
  }

  /**
   * Gérer les réactions aux messages
   */
  async handleReaction(socket, data) {
    try {
      const userId = this.connectedUsers.get(socket.id);
      
      if (!userId) {
        socket.emit('error', { error: 'Non authentifié' });
        return;
      }

      const { messageId, emoji } = data;

      const message = await Message.findById(messageId);
      
      if (!message) {
        socket.emit('error', { error: 'Message non trouvé' });
        return;
      }

      // Vérifier que l'utilisateur est dans la conversation
      const chat = await Chat.findById(message.chat);
      
      if (!chat || !chat.isParticipant(userId)) {
        socket.emit('error', { error: 'Accès non autorisé' });
        return;
      }

      // Ajouter ou mettre à jour la réaction
      await message.addReaction(userId, emoji);

      // Notifier tous les participants de la conversation
      this.io.to(`chat:${message.chat}`).emit('message_reaction', {
        messageId: message._id,
        reaction: {
          user: userId,
          emoji,
        },
        reactions: message.reactions,
      });

      socket.emit('reaction_added', {
        success: true,
        messageId: message._id,
        emoji,
      });

    } catch (error) {
      logger.error('Erreur lors de l\'ajout de la réaction:', error);
      socket.emit('error', { error: 'Erreur lors de l\'ajout de la réaction' });
    }
  }

  /**
   * Gérer l'édition d'un message
   */
  async handleEditMessage(socket, data) {
    try {
      const userId = this.connectedUsers.get(socket.id);
      
      if (!userId) {
        socket.emit('error', { error: 'Non authentifié' });
        return;
      }

      const { messageId, newContent } = data;

      const message = await Message.findById(messageId);
      
      if (!message) {
        socket.emit('error', { error: 'Message non trouvé' });
        return;
      }

      // Vérifier que l'utilisateur est l'expéditeur
      if (message.sender.toString() !== userId.toString()) {
        socket.emit('error', { error: 'Seul l\'expéditeur peut éditer le message' });
        return;
      }

      // Éditer le message
      await message.edit(newContent);

      // Notifier tous les participants de la conversation
      this.io.to(`chat:${message.chat}`).emit('message_edited', {
        messageId: message._id,
        newContent: message.content,
        editedAt: message.editedAt,
      });

      socket.emit('message_edited', {
        success: true,
        messageId: message._id,
        newContent: message.content,
      });

    } catch (error) {
      logger.error('Erreur lors de l\'édition du message:', error);
      socket.emit('error', { error: 'Erreur lors de l\'édition du message' });
    }
  }

  /**
   * Gérer la suppression d'un message
   */
  async handleDeleteMessage(socket, data) {
    try {
      const userId = this.connectedUsers.get(socket.id);
      
      if (!userId) {
        socket.emit('error', { error: 'Non authentifié' });
        return;
      }

      const { messageId } = data;

      const message = await Message.findById(messageId);
      
      if (!message) {
        socket.emit('error', { error: 'Message non trouvé' });
        return;
      }

      // Vérifier les permissions (expéditeur ou admin)
      const isSender = message.sender.toString() === userId.toString();
      const user = await User.findById(userId);
      const isAdmin = user.role === 'admin';

      if (!isSender && !isAdmin) {
        socket.emit('error', { error: 'Permissions insuffisantes' });
        return;
      }

      // Supprimer le message (soft delete)
      await message.softDelete(userId);

      // Notifier tous les participants de la conversation
      this.io.to(`chat:${message.chat}`).emit('message_deleted', {
        messageId: message._id,
        deletedBy: userId,
        deletedAt: message.deletedAt,
      });

      socket.emit('message_deleted', {
        success: true,
        messageId: message._id,
      });

    } catch (error) {
      logger.error('Erreur lors de la suppression du message:', error);
      socket.emit('error', { error: 'Erreur lors de la suppression du message' });
    }
  }

  /**
   * Gérer la mise à jour du statut utilisateur
   */
  async handleUpdateStatus(socket, data) {
    try {
      const userId = this.connectedUsers.get(socket.id);
      
      if (!userId) {
        socket.emit('error', { error: 'Non authentifié' });
        return;
      }

      const { status } = data;

      const user = await User.findById(userId);
      
      if (!user) {
        socket.emit('error', { error: 'Utilisateur non trouvé' });
        return;
      }

      // Mettre à jour le statut
      await user.updateStatus(status);

      // Notifier les changements de statut
      this.notifyUserStatusChange(userId, status);

      socket.emit('status_updated', {
        success: true,
        status,
        lastSeen: user.lastSeen,
      });

    } catch (error) {
      logger.error('Erreur lors de la mise à jour du statut:', error);
      socket.emit('error', { error: 'Erreur lors de la mise à jour du statut' });
    }
  }

  /**
   * Gérer l'indicateur de frappe
   */
  handleTyping(socket, data) {
    const userId = this.connectedUsers.get(socket.id);
    
    if (!userId) {
      socket.emit('error', { error: 'Non authentifié' });
      return;
    }

    const { chatId } = data;

    // Envoyer à tous les autres participants de la conversation
    socket.to(`chat:${chatId}`).emit('user_typing', {
      chatId,
      userId,
    });
  }

  /**
   * Gérer l'arrêt de la frappe
   */
  handleStopTyping(socket, data) {
    const userId = this.connectedUsers.get(socket.id);
    
    if (!userId) {
      socket.emit('error', { error: 'Non authentifié' });
      return;
    }

    const { chatId } = data;

    // Envoyer à tous les autres participants de la conversation
    socket.to(`chat:${chatId}`).emit('user_stopped_typing', {
      chatId,
      userId,
    });
  }

  /**
   * Gérer la déconnexion
   */
  async handleDisconnect(socket) {
    try {
      const userId = this.connectedUsers.get(socket.id);
      
      if (userId) {
        // Mettre à jour le statut de l'utilisateur
        const user = await User.findById(userId);
        
        if (user) {
          await user.updateStatus('offline');
          this.notifyUserStatusChange(userId, 'offline');
        }

        // Nettoyer les mappings
        this.connectedUsers.delete(socket.id);
        this.userSockets.delete(userId.toString());

        logger.socket('disconnect', socket.id, { userId });
      }
    } catch (error) {
      logger.error('Erreur lors de la déconnexion:', error);
    }
  }

  /**
   * Notifier le changement de statut d'un utilisateur
   */
  notifyUserStatusChange(userId, status) {
    // Envoyer à tous les utilisateurs connectés
    this.io.emit('user_status_changed', {
      userId,
      status,
      lastSeen: new Date(),
    });
  }

  /**
   * Envoyer les conversations d'un utilisateur
   */
  async sendUserChats(socket, userId) {
    try {
      const chats = await Chat.getUserChats(userId);
      
      socket.emit('user_chats', {
        success: true,
        chats,
      });
    } catch (error) {
      logger.error('Erreur lors de l\'envoi des conversations:', error);
    }
  }

  /**
   * Envoyer une notification push
   */
  async sendPushNotification(userId, notification) {
    // Implémentation basique
    // Dans une application réelle, intégrer avec Firebase Cloud Messaging
    const userSocketId = this.userSockets.get(userId.toString());
    
    if (userSocketId) {
      this.io.to(userSocketId).emit('push_notification', notification);
    }
  }

  /**
   * Obtenir les statistiques de connexion
   */
  getConnectionStats() {
    return {
      connectedUsers: this.connectedUsers.size,
      userSockets: this.userSockets.size,
      totalConnections: this.io.engine.clientsCount,
    };
  }

  /**
   * Envoyer un message à un utilisateur spécifique
   */
  sendToUser(userId, event, data) {
    const socketId = this.userSockets.get(userId.toString());
    
    if (socketId) {
      this.io.to(socketId).emit(event, data);
      return true;
    }
    
    return false;
  }

  /**
   * Envoyer un message à tous les utilisateurs d'une conversation
   */
  sendToChat(chatId, event, data) {
    this.io.to(`chat:${chatId}`).emit(event, data);
  }

  /**
   * Diffuser un message à tous les utilisateurs connectés
   */
  broadcast(event, data) {
    this.io.emit(event, data);
  }
}

// Singleton pattern
const socketService = new SocketService();

module.exports = socketService;