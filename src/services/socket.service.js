const logger = require('../utils/logger');
const { query } = require('../config/db');
const config = require('../../config/config');

class SocketService {
  constructor() {
    this.io = null;
    this.connectedUsers = new Map(); // socketId -> userId
    this.userSockets = new Map(); // userId -> Set of socketIds
    this.pendingCalls = new Map(); // callId -> { callerId, calleeId, timeout }
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

      // Call signaling
      socket.on('call:offer', async (data) => {
        // data: { toUserId, channelName, callType, callId, fromUserName }
        try {
          const callerId = this.connectedUsers.get(socket.id);
          if (!callerId) return socket.emit('error', { error: 'Non authentifié' });

          const { toUserId, channelName, callType, callId } = data;
          if (!toUserId || !channelName) return socket.emit('error', { error: 'Données d\'appel manquantes' });

          const calleeSocketId = this.userSockets.get(toUserId.toString());
          const callIdentifier = callId || `${callerId}_${toUserId}_${Date.now()}`;

          // Check if callee is already in a call
          const isBusy = Array.from(this.pendingCalls.values()).some(c => c.callerId === toUserId || c.calleeId === toUserId);
          if (isBusy) {
            socket.emit('call:busy', { toUserId, callId: callIdentifier });
            return;
          }

          if (!calleeSocketId) {
            // Callee offline
            socket.emit('call:callee_unavailable', { toUserId, callId: callIdentifier });
            return;
          }

          // Forward ring to callee
          this.io.to(calleeSocketId).emit('call:ring', {
            fromUserId: callerId,
            channelName,
            callType,
            callId: callIdentifier,
          });

          // Acknowledge to caller that we are trying to reach the callee
          socket.emit('call:calling', { toUserId, callId: callIdentifier });

          // Store pending call with timeout (30s)
          const timeout = setTimeout(() => {
            // Notify both parties of timeout
            const callerSocket = this.userSockets.get(callerId.toString());
            const calleeSocket = this.userSockets.get(toUserId.toString());

            if (callerSocket) this.io.to(callerSocket).emit('call:timeout', { callId: callIdentifier });
            if (calleeSocket) this.io.to(calleeSocket).emit('call:timeout', { callId: callIdentifier });

            this.pendingCalls.delete(callIdentifier);
            // persist missed call
            this.persistCallRecord({ callerId, calleeId: toUserId, status: 'missed', callType: callType || 'audio', channelName });
          }, 30000);

          this.pendingCalls.set(callIdentifier, { callerId, calleeId: toUserId, timeout, callType, channelName });

          // Acknowledge to caller that we are trying to reach the callee
          socket.emit('call:calling', { toUserId, callId: callIdentifier });
        } catch (err) {
          logger.error('Error handling call:offer', err);
          socket.emit('error', { error: 'Erreur signaling' });
        }
      });

      socket.on('call:ringing', (data) => {
        // Callee signals that their phone is actually ringing
        try {
          const { callId, toUserId } = data; // toUserId is the caller here
          const callerSocketId = this.userSockets.get(toUserId.toString());
          if (callerSocketId) {
            this.io.to(callerSocketId).emit('call:ringing', { callId });
          }
        } catch (err) {
          logger.error('Error handling call:ringing', err);
        }
      });

      socket.on('call:accept', (data) => {
        // data: { callId }
        try {
          const accepterId = this.connectedUsers.get(socket.id);
          const { callId } = data;
          const pending = this.pendingCalls.get(callId);
          if (!pending) return socket.emit('error', { error: 'Appel introuvable ou expiré' });

          // Clear timeout
          clearTimeout(pending.timeout);
          this.pendingCalls.delete(callId);

          // Notify caller
          const callerSocketId = this.userSockets.get(pending.callerId.toString());
          if (callerSocketId) {
            this.io.to(callerSocketId).emit('call:accepted', { callId, by: accepterId });
          }

          // persist connected start
          this.persistCallRecord({ callerId: pending.callerId, calleeId: pending.calleeId, status: 'connected', callType: pending.callType || 'audio', channelName: pending.channelName, startedAt: new Date() });

          // Notify callee also (confirmation)
          socket.emit('call:accepted', { callId, by: accepterId });
        } catch (err) {
          logger.error('Error handling call:accept', err);
        }
      });

      socket.on('call:reject', (data) => {
        try {
          const rejecterId = this.connectedUsers.get(socket.id);
          const { callId } = data;
          const pending = this.pendingCalls.get(callId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingCalls.delete(callId);
            const callerSocketId = this.userSockets.get(pending.callerId.toString());
            if (callerSocketId) {
              this.io.to(callerSocketId).emit('call:rejected', { callId, by: rejecterId });
            }
            // persist rejected
            this.persistCallRecord({ callerId: pending.callerId, calleeId: pending.calleeId, status: 'rejected', callType: pending.callType || 'audio', channelName: pending.channelName });
          }
          // Confirm to rejecter
          socket.emit('call:rejected', { callId, by: rejecterId });
        } catch (err) {
          logger.error('Error handling call:reject', err);
        }
      });

      socket.on('call:hangup', (data) => {
        try {
          const hangerId = this.connectedUsers.get(socket.id);
          const { callId, toUserId } = data;

          // Forward hangup to other side if online
          if (toUserId) {
            const targetSocket = this.userSockets.get(toUserId.toString());
            if (targetSocket) this.io.to(targetSocket).emit('call:hangup', { callId, by: hangerId });
          }

          // Cleanup pending if exists
          const pending = this.pendingCalls.get(callId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingCalls.delete(callId);
            this.persistCallRecord({ callerId: pending.callerId, calleeId: pending.calleeId, status: 'hung_up', callType: pending.callType || 'audio', channelName: pending.channelName });
          }

          socket.emit('call:hangup', { callId, by: hangerId });
        } catch (err) {
          logger.error('Error handling call:hangup', err);
        }
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

      const userIdStr = userId.toString();
      if (!this.userSockets.has(userIdStr)) {
        this.userSockets.set(userIdStr, new Set());
      }
      this.userSockets.get(userIdStr).add(socket.id);

      // Mettre à jour le statut de l'utilisateur
      await query(
        "UPDATE public.profiles SET status = 'online', last_seen = NOW(), status_updated_at = NOW() WHERE id = $1",
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

  async persistCallRecord({ callerId, calleeId, status = 'missed', callType = 'audio', channelName = null, startedAt = null, endedAt = null, durationSeconds = null }) {
    try {
      await query(
        `INSERT INTO public.calls (caller_id, callee_id, status, call_type, channel_name, started_at, ended_at, duration_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [callerId, calleeId, status, callType, channelName, startedAt, endedAt, durationSeconds]
      );
    } catch (err) {
      logger.error('Error persisting call record:', err);
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
    try {
      const userId = this.connectedUsers.get(socket.id);
      if (!userId) return;

      const { messageId, emoji } = data;

      // On supporte principalement le "like" (❤️) pour le moment dans les messages
      // Mais on stocke les IDs des utilisateurs ayant liké
      const result = await query(
        `UPDATE public.messages
         SET likes = CASE
           WHEN $1 = ANY(COALESCE(likes, '{}')) THEN array_remove(likes, $1)
           ELSE array_append(COALESCE(likes, '{}'), $1)
         END
         WHERE id = $2
         RETURNING likes, chat_id`,
        [userId, messageId]
      );

      if (result.rows.length > 0) {
        const { likes, chat_id } = result.rows[0];
        this.io.to(`chat:${chat_id}`).emit('message_reaction', {
          messageId,
          likes,
          reaction: {
            user: userId,
            emoji: emoji || '❤️',
          }
        });
      }
    } catch (error) {
      logger.error('Error handling reaction:', error);
    }
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
        const userIdStr = userId.toString();
        const userSockets = this.userSockets.get(userIdStr);

        if (userSockets) {
          userSockets.delete(socket.id);
          if (userSockets.size === 0) {
            this.userSockets.delete(userIdStr);

            await query(
              "UPDATE public.profiles SET status = 'offline', last_seen = NOW(), status_updated_at = NOW() WHERE id = $1",
              [userId]
            );
            this.notifyUserStatusChange(userId, 'offline');
          }
        }

        this.connectedUsers.delete(socket.id);
        logger.socket('disconnect', socket.id, { userId });
      }
    } catch (error) {
      logger.error('Erreur lors de la déconnexion:', error);
    }
  }

  /**
   * Notifier le changement de statut d'un utilisateur
   */
  async notifyUserStatusChange(userId, status) {
    try {
      // Vérifier les paramètres de confidentialité de l'utilisateur
      const result = await query(
        'SELECT privacy_settings FROM public.profiles WHERE id = $1',
        [userId]
      );

      const settings = result.rows[0]?.privacy_settings || {};

      // Si last_seen est sur "nobody", on ne diffuse pas le changement de statut
      // (Optionnel: on pourrait affiner pour "contacts" uniquement)
      if (settings.last_seen === 'nobody') {
        return;
      }

      this.io.emit('user_status_changed', {
        userId,
        status,
        lastSeen: new Date(),
      });
    } catch (error) {
      logger.error('Erreur notifyUserStatusChange:', error);
    }
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
   * Obtenir les statistiques de connexion (Utilisateurs uniques)
   */
  getConnectionStats() {
    return {
      connectedUsers: this.userSockets ? this.userSockets.size : 0,
      totalSockets: this.connectedUsers ? this.connectedUsers.size : 0,
      totalConnections: this.io ? this.io.engine.clientsCount : 0,
    };
  }

  /**
   * Envoyer un message à un utilisateur spécifique (alias pour emitToUser)
   */
  sendToUser(userId, event, data) {
    return this.emitToUser(userId, event, data);
  }

  /**
   * Émettre un événement à un utilisateur spécifique
   */
  emitToUser(userId, event, data) {
    const socketIds = this.userSockets.get(userId.toString());
    
    if (socketIds && socketIds.size > 0) {
      socketIds.forEach(socketId => {
        this.io.to(socketId).emit(event, data);
      });
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