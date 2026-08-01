const logger = require('../utils/logger');
const { query } = require('../config/db');
const config = require('../../config/config');

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

      // Vérifier l'utilisateur dans Postgres
      const result = await query(
        'SELECT id, full_name, email, avatar_url, status FROM public.profiles WHERE id = $1',
        [userId]
      );

      const user = result.rows[0];
      
      if (!user) {
        socket.emit('authentication_error', { error: 'Utilisateur non trouvé' });
        return;
      }

      // Stocker la connexion
      this.connectedUsers.set(socket.id, userId);
      this.userSockets.set(userId.toString(), socket.id);

      // Mettre à jour le statut de l'utilisateur
      await query(
        "UPDATE public.profiles SET status = 'online', last_seen = NOW() WHERE id = $1",
        [userId]
      );

      // Rejoindre la room de l'utilisateur
      socket.join(`user:${userId}`);

      // Notifier les autres utilisateurs
      this.notifyUserStatusChange(userId, 'online');

      logger.socket('authenticated', socket.id, { userId: user.id, email: user.email });

      socket.emit('authenticated', {
        success: true,
        user: {
          id: user.id,
          name: user.full_name,
          email: user.email,
          avatar: user.avatar_url,
          status: 'online',
          lastSeen: new Date()
        },
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

      const { chatId, content, type, fileUrl } = data;

      // Vérifier la conversation et la participation
      const participantResult = await query(
        'SELECT 1 FROM public.chat_participants WHERE chat_id = $1 AND user_id = $2',
        [chatId, userId]
      );
      
      if (participantResult.rows.length === 0) {
        socket.emit('error', { error: 'Conversation non trouvée ou accès refusé' });
        return;
      }

      // Créer le message dans Postgres
      const messageResult = await query(
        `INSERT INTO public.messages (chat_id, sender_id, content, type, file_url)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [chatId, userId, content || '', type || 'text', fileUrl || null]
      );

      const message = messageResult.rows[0];

      // Récupérer les infos de l'expéditeur
      const senderResult = await query(
        'SELECT id, full_name, avatar_url FROM public.profiles WHERE id = $1',
        [userId]
      );
      const sender = senderResult.rows[0];

      const messageDataToSend = {
        id: message.id,
        chatId: message.chat_id,
        content: message.content,
        type: message.type,
        fileUrl: message.file_url,
        status: message.status,
        createdAt: message.created_at,
        sender: {
          id: sender.id,
          name: sender.full_name,
          avatar: sender.avatar_url
        }
      };

      // Envoyer le message à tous les participants de la conversation
      this.io.to(`chat:${chatId}`).emit('new_message', {
        chatId,
        message: messageDataToSend,
      });

      // Notifier les autres participants pour les notifications push
      const participantsResult = await query(
        'SELECT user_id FROM public.chat_participants WHERE chat_id = $1 AND user_id != $2',
        [chatId, userId]
      );

      participantsResult.rows.forEach(row => {
        const participantId = row.user_id;
        const participantSocketId = this.userSockets.get(participantId.toString());
        
        if (participantSocketId) {
          // Envoyer une notification push (si configuré)
          this.sendPushNotification(participantId, {
            title: sender.full_name,
            body: type === 'text' ? content : `Nouveau message ${type}`,
            data: { chatId, messageId: message.id },
          });
        }
      });

      logger.socket('message_sent', socket.id, {
        chatId,
        messageId: message.id,
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

      // Mettre à jour le statut du message
      const result = await query(
        "UPDATE public.messages SET status = 'read' WHERE id = $1 RETURNING sender_id, chat_id",
        [messageId]
      );

      const message = result.rows[0];
      
      if (!message) {
        socket.emit('error', { error: 'Message non trouvé' });
        return;
      }

      // Notifier l'expéditeur que son message a été lu
      const senderSocketId = this.userSockets.get(message.sender_id.toString());
      
      if (senderSocketId && senderSocketId !== socket.id) {
        this.io.to(senderSocketId).emit('message_read', {
          messageId,
          readBy: userId,
          readAt: new Date(),
        });
      }

      socket.emit('marked_as_read', {
        success: true,
        messageId,
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

      const result = await query(
        "UPDATE public.messages SET status = 'delivered' WHERE id = $1 AND status = 'sent' RETURNING sender_id",
        [messageId]
      );
      
      const message = result.rows[0];
      
      if (message) {
        // Notifier l'expéditeur que son message a été délivré
        const senderSocketId = this.userSockets.get(message.sender_id.toString());

        if (senderSocketId && senderSocketId !== socket.id) {
          this.io.to(senderSocketId).emit('message_delivered', {
            messageId,
            deliveredTo: userId,
          });
        }
      }

      socket.emit('marked_as_delivered', {
        success: true,
        messageId,
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
    // Note: La table des réactions n'existe pas encore dans database_setup.sql
    // On peut soit l'ignorer soit la stocker dans une colonne JSONB si on veut
    // Pour l'instant, on émet juste l'événement
    const userId = this.connectedUsers.get(socket.id);
    const { messageId, emoji } = data;

    this.io.emit('message_reaction', {
      messageId,
      reaction: {
        user: userId,
        emoji,
      }
    });
  }

  /**
   * Gérer l'édition d'un message
   */
  async handleEditMessage(socket, data) {
    try {
      const userId = this.connectedUsers.get(socket.id);
      const { messageId, newContent } = data;

      const result = await query(
        'UPDATE public.messages SET content = $1 WHERE id = $2 AND sender_id = $3 RETURNING chat_id',
        [newContent, messageId, userId]
      );

      if (result.rows.length > 0) {
        const chatId = result.rows[0].chat_id;
        this.io.to(`chat:${chatId}`).emit('message_edited', {
          messageId,
          newContent,
          editedAt: new Date(),
        });
      }
    } catch (error) {
      logger.error('Erreur lors de l\'édition du message:', error);
    }
  }

  /**
   * Gérer la suppression d'un message
   */
  async handleDeleteMessage(socket, data) {
    try {
      const userId = this.connectedUsers.get(socket.id);
      const { messageId } = data;

      const result = await query(
        'DELETE FROM public.messages WHERE id = $1 AND sender_id = $2 RETURNING chat_id',
        [messageId, userId]
      );

      if (result.rows.length > 0) {
        const chatId = result.rows[0].chat_id;
        this.io.to(`chat:${chatId}`).emit('message_deleted', {
          messageId,
          deletedBy: userId,
          deletedAt: new Date(),
        });
      }
    } catch (error) {
      logger.error('Erreur lors de la suppression du message:', error);
    }
  }

  /**
   * Gérer la mise à jour du statut utilisateur
   */
  async handleUpdateStatus(socket, data) {
    try {
      const userId = this.connectedUsers.get(socket.id);
      if (!userId) return;

      const { status } = data;
      await query(
        "UPDATE public.profiles SET status = $1, last_seen = NOW() WHERE id = $2",
        [status, userId]
      );

      this.notifyUserStatusChange(userId, status);
    } catch (error) {
      logger.error('Erreur lors de la mise à jour du statut:', error);
    }
  }

  /**
   * Gérer l'indicateur de frappe
   */
  handleTyping(socket, data) {
    const userId = this.connectedUsers.get(socket.id);
    const { chatId } = data;
    socket.to(`chat:${chatId}`).emit('user_typing', { chatId, userId });
  }

  /**
   * Gérer l'arrêt de la frappe
   */
  handleStopTyping(socket, data) {
    const userId = this.connectedUsers.get(socket.id);
    const { chatId } = data;
    socket.to(`chat:${chatId}`).emit('user_stopped_typing', { chatId, userId });
  }

  /**
   * Gérer la déconnexion
   */
  async handleDisconnect(socket) {
    try {
      const userId = this.connectedUsers.get(socket.id);
      
      if (userId) {
        await query(
          "UPDATE public.profiles SET status = 'offline', last_seen = NOW() WHERE id = $1",
          [userId]
        );
        this.notifyUserStatusChange(userId, 'offline');

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
      const result = await query(
        `SELECT c.* FROM public.chats c
         JOIN public.chat_participants cp ON c.id = cp.chat_id
         WHERE cp.user_id = $1
         ORDER BY c.last_message_at DESC`,
        [userId]
      );
      
      socket.emit('user_chats', {
        success: true,
        chats: result.rows,
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