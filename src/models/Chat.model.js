const mongoose = require('mongoose');
const config = require('../../config/config');

const chatSchema = new mongoose.Schema({
  // Participants de la conversation
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  }],

  // Dernier message pour l'affichage dans la liste
  lastMessage: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message',
    default: null,
  },

  // Métadonnées de la conversation
  name: {
    type: String,
    trim: true,
    maxlength: [100, 'Le nom ne peut pas dépasser 100 caractères'],
  },

  type: {
    type: String,
    enum: ['private', 'group'],
    default: 'private',
  },

  // Pour les groupes
  groupAdmin: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },

  groupAvatar: {
    type: String,
    default: null,
  },

  groupDescription: {
    type: String,
    maxlength: [500, 'La description ne peut pas dépasser 500 caractères'],
    default: '',
  },

  // Préférences de la conversation
  mutedBy: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    until: Date,
  }],

  pinnedBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],

  // Statut et activité
  isActive: {
    type: Boolean,
    default: true,
  },

  lastActivity: {
    type: Date,
    default: Date.now,
    index: true,
  },

  // Métadonnées
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  deletedAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

// Index pour les recherches
chatSchema.index({ participants: 1, lastActivity: -1 });
chatSchema.index({ 'participants.user': 1, lastActivity: -1 });
chatSchema.index({ type: 1, lastActivity: -1 });
chatSchema.index({ createdAt: -1 });

// Virtual pour les messages
chatSchema.virtual('messages', {
  ref: 'Message',
  localField: '_id',
  foreignField: 'chat',
});

// Virtual pour le nombre de messages non lus
chatSchema.virtual('unreadCount', {
  ref: 'Message',
  localField: '_id',
  foreignField: 'chat',
  count: true,
  match: { readBy: { $ne: mongoose.Types.ObjectId(this.participants[0]) } },
});

// Méthode pour vérifier si un utilisateur est participant
chatSchema.methods.isParticipant = function(userId) {
  return this.participants.some(participant => 
    participant._id ? participant._id.toString() === userId.toString() : participant.toString() === userId.toString()
  );
};

// Méthode pour ajouter un participant
chatSchema.methods.addParticipant = async function(userId) {
  if (!this.isParticipant(userId)) {
    this.participants.push(userId);
    await this.save();
  }
  return this;
};

// Méthode pour retirer un participant
chatSchema.methods.removeParticipant = async function(userId) {
  if (this.type === 'private') {
    throw new Error('Cannot remove participant from private chat');
  }

  this.participants = this.participants.filter(participant =>
    participant._id ? participant._id.toString() !== userId.toString() : participant.toString() !== userId.toString()
  );

  // Si c'est l'admin qui part, désigner un nouvel admin
  if (this.groupAdmin && this.groupAdmin.toString() === userId.toString()) {
    if (this.participants.length > 0) {
      this.groupAdmin = this.participants[0];
    } else {
      this.isActive = false;
    }
  }

  await this.save();
  return this;
};

// Méthode pour mettre à jour le dernier message
chatSchema.methods.updateLastMessage = async function(messageId) {
  this.lastMessage = messageId;
  this.lastActivity = Date.now();
  await this.save();
  return this;
};

// Méthode pour obtenir les informations de la conversation
chatSchema.methods.getChatInfo = function(currentUserId) {
  const otherParticipants = this.participants.filter(participant =>
    participant._id ? participant._id.toString() !== currentUserId.toString() : participant.toString() !== currentUserId.toString()
  );

  let chatName = this.name;
  let chatAvatar = this.groupAvatar;

  // Pour les conversations privées, utiliser le nom et l'avatar de l'autre participant
  if (this.type === 'private' && otherParticipants.length > 0) {
    const otherUser = otherParticipants[0];
    if (otherUser.name) {
      chatName = otherUser.name;
    }
    if (otherUser.avatar) {
      chatAvatar = otherUser.avatar;
    }
  }

  return {
    _id: this._id,
    name: chatName,
    avatar: chatAvatar,
    type: this.type,
    participants: this.participants.map(p => ({
      _id: p._id || p,
      name: p.name || null,
      avatar: p.avatar || null,
      status: p.status || null,
    })),
    lastActivity: this.lastActivity,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

// Méthode statique pour trouver ou créer une conversation privée
chatSchema.statics.findOrCreatePrivateChat = async function(userId1, userId2) {
  // Vérifier si une conversation privée existe déjà
  const existingChat = await this.findOne({
    type: 'private',
    participants: { $all: [userId1, userId2], $size: 2 },
    isActive: true,
  }).populate('participants', 'name avatar status');

  if (existingChat) {
    return existingChat;
  }

  // Créer une nouvelle conversation privée
  const newChat = new this({
    participants: [userId1, userId2],
    type: 'private',
    createdBy: userId1,
    lastActivity: Date.now(),
  });

  await newChat.save();
  
  // Populer les participants
  await newChat.populate('participants', 'name avatar status');
  
  return newChat;
};

// Méthode statique pour obtenir les conversations d'un utilisateur
chatSchema.statics.getUserChats = async function(userId, page = 1, limit = 20) {
  const skip = (page - 1) * limit;

  const chats = await this.find({
    participants: userId,
    isActive: true,
  })
    .populate('participants', 'name avatar status')
    .populate({
      path: 'lastMessage',
      select: 'content type sender createdAt',
      populate: {
        path: 'sender',
        select: 'name avatar',
      },
    })
    .sort({ lastActivity: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  // Formater les résultats
  return chats.map(chat => {
    const chatInfo = {
      _id: chat._id,
      type: chat.type,
      lastActivity: chat.lastActivity,
      createdAt: chat.createdAt,
    };

    // Ajouter les informations spécifiques au type de conversation
    if (chat.type === 'private') {
      const otherParticipant = chat.participants.find(p => 
        p._id.toString() !== userId.toString()
      );
      
      chatInfo.name = otherParticipant?.name || 'Utilisateur';
      chatInfo.avatar = otherParticipant?.avatar;
      chatInfo.participantStatus = otherParticipant?.status;
    } else {
      chatInfo.name = chat.name;
      chatInfo.avatar = chat.groupAvatar;
      chatInfo.description = chat.groupDescription;
      chatInfo.admin = chat.groupAdmin;
    }

    // Ajouter le dernier message s'il existe
    if (chat.lastMessage) {
      chatInfo.lastMessage = {
        _id: chat.lastMessage._id,
        content: chat.lastMessage.content,
        type: chat.lastMessage.type,
        sender: chat.lastMessage.sender,
        createdAt: chat.lastMessage.createdAt,
      };
    }

    return chatInfo;
  });
};

// Middleware pour le soft delete
chatSchema.pre('find', function() {
  this.where({ deletedAt: null });
});

chatSchema.pre('findOne', function() {
  this.where({ deletedAt: null });
});

const Chat = mongoose.model('Chat', chatSchema);

module.exports = Chat;