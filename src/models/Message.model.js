const mongoose = require('mongoose');
const config = require('../../config/config');

const messageSchema = new mongoose.Schema({
  // Références
  chat: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chat',
    required: true,
    index: true,
  },

  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },

  // Contenu du message
  type: {
    type: String,
    enum: Object.values(config.constants.messageTypes),
    default: config.constants.messageTypes.TEXT,
    required: true,
  },

  content: {
    type: String,
    required: function() {
      return this.type === config.constants.messageTypes.TEXT;
    },
    maxlength: [5000, 'Le message ne peut pas dépasser 5000 caractères'],
  },

  // Pour les messages audio
  audioUrl: {
    type: String,
    required: function() {
      return this.type === config.constants.messageTypes.AUDIO;
    },
  },

  audioDuration: {
    type: Number, // en secondes
    min: [1, 'La durée audio doit être d\'au moins 1 seconde'],
    max: [config.upload.maxAudioDuration, `La durée audio ne peut pas dépasser ${config.upload.maxAudioDuration} secondes`],
  },

  // Pour les messages multimédias
  mediaUrl: {
    type: String,
    required: function() {
      return [
        config.constants.messageTypes.IMAGE,
        config.constants.messageTypes.VIDEO,
        config.constants.messageTypes.FILE,
      ].includes(this.type);
    },
  },

  mediaType: {
    type: String,
  },

  fileName: {
    type: String,
    maxlength: [255, 'Le nom du fichier ne peut pas dépasser 255 caractères'],
  },

  fileSize: {
    type: Number, // en bytes
  },

  // Traduction
  translatedContent: {
    type: Map,
    of: String,
    default: new Map(),
  },

  // Métadonnées de lecture
  readBy: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    readAt: {
      type: Date,
      default: Date.now,
    },
  }],

  deliveredTo: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],

  // Réactions
  reactions: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    emoji: {
      type: String,
      required: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  }],

  // Réponse à un autre message
  replyTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message',
  },

  // Métadonnées
  isEdited: {
    type: Boolean,
    default: false,
  },

  editedAt: {
    type: Date,
  },

  isDeleted: {
    type: Boolean,
    default: false,
  },

  deletedAt: {
    type: Date,
  },

  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

// Index pour les recherches
messageSchema.index({ chat: 1, createdAt: -1 });
messageSchema.index({ sender: 1, createdAt: -1 });
messageSchema.index({ createdAt: -1 });
messageSchema.index({ 'readBy.user': 1 });
messageSchema.index({ type: 1 });

// Virtual pour le message de réponse
messageSchema.virtual('replyMessage', {
  ref: 'Message',
  localField: 'replyTo',
  foreignField: '_id',
  justOne: true,
});

// Méthode pour marquer le message comme lu
messageSchema.methods.markAsRead = async function(userId) {
  const alreadyRead = this.readBy.some(read => 
    read.user.toString() === userId.toString()
  );

  if (!alreadyRead) {
    this.readBy.push({
      user: userId,
      readAt: Date.now(),
    });
    await this.save();
  }

  return this;
};

// Méthode pour marquer le message comme délivré
messageSchema.methods.markAsDelivered = async function(userId) {
  const alreadyDelivered = this.deliveredTo.some(delivered => 
    delivered.toString() === userId.toString()
  );

  if (!alreadyDelivered) {
    this.deliveredTo.push(userId);
    await this.save();
  }

  return this;
};

// Méthode pour ajouter une réaction
messageSchema.methods.addReaction = async function(userId, emoji) {
  // Supprimer toute réaction existante de cet utilisateur
  this.reactions = this.reactions.filter(reaction => 
    reaction.user.toString() !== userId.toString()
  );

  // Ajouter la nouvelle réaction
  this.reactions.push({
    user: userId,
    emoji: emoji,
    createdAt: Date.now(),
  });

  await this.save();
  return this;
};

// Méthode pour supprimer une réaction
messageSchema.methods.removeReaction = async function(userId) {
  this.reactions = this.reactions.filter(reaction => 
    reaction.user.toString() !== userId.toString()
  );

  await this.save();
  return this;
};

// Méthode pour ajouter une traduction
messageSchema.methods.addTranslation = async function(language, translatedText) {
  this.translatedContent.set(language, translatedText);
  await this.save();
  return this;
};

// Méthode pour obtenir la traduction dans une langue spécifique
messageSchema.methods.getTranslation = function(language) {
  return this.translatedContent.get(language);
};

// Méthode pour éditer le message
messageSchema.methods.edit = async function(newContent) {
  if (this.type !== config.constants.messageTypes.TEXT) {
    throw new Error('Seuls les messages texte peuvent être édités');
  }

  this.content = newContent;
  this.isEdited = true;
  this.editedAt = Date.now();
  await this.save();
  return this;
};

// Méthode pour supprimer le message (soft delete)
messageSchema.methods.softDelete = async function(userId) {
  this.isDeleted = true;
  this.deletedAt = Date.now();
  this.deletedBy = userId;
  
  // Effacer le contenu sensible
  this.content = 'Message supprimé';
  this.audioUrl = null;
  this.mediaUrl = null;
  this.translatedContent.clear();
  
  await this.save();
  return this;
};

// Méthode pour obtenir les informations du message
messageSchema.methods.getMessageInfo = function(currentUserId = null) {
  const messageInfo = {
    _id: this._id,
    chat: this.chat,
    sender: this.sender,
    type: this.type,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
    isEdited: this.isEdited,
    editedAt: this.editedAt,
    isDeleted: this.isDeleted,
    replyTo: this.replyTo,
  };

  // Ajouter le contenu selon le type
  switch (this.type) {
    case config.constants.messageTypes.TEXT:
      messageInfo.content = this.content;
      break;
    case config.constants.messageTypes.AUDIO:
      messageInfo.audioUrl = this.audioUrl;
      messageInfo.audioDuration = this.audioDuration;
      break;
    case config.constants.messageTypes.IMAGE:
    case config.constants.messageTypes.VIDEO:
    case config.constants.messageTypes.FILE:
      messageInfo.mediaUrl = this.mediaUrl;
      messageInfo.mediaType = this.mediaType;
      messageInfo.fileName = this.fileName;
      messageInfo.fileSize = this.fileSize;
      break;
  }

  // Ajouter les métadonnées de lecture
  if (currentUserId) {
    const isRead = this.readBy.some(read => 
      read.user.toString() === currentUserId.toString()
    );
    const isDelivered = this.deliveredTo.some(delivered => 
      delivered.toString() === currentUserId.toString()
    );

    messageInfo.isRead = isRead;
    messageInfo.isDelivered = isDelivered;
  }

  // Ajouter les réactions
  messageInfo.reactions = this.reactions.map(reaction => ({
    user: reaction.user,
    emoji: reaction.emoji,
    createdAt: reaction.createdAt,
  }));

  // Ajouter les traductions
  if (this.translatedContent.size > 0) {
    messageInfo.translations = Object.fromEntries(this.translatedContent);
  }

  return messageInfo;
};

// Méthode statique pour obtenir les messages d'une conversation
messageSchema.statics.getChatMessages = async function(chatId, page = 1, limit = 50, beforeDate = null) {
  const skip = (page - 1) * limit;
  
  const query = { chat: chatId, isDeleted: false };
  
  if (beforeDate) {
    query.createdAt = { $lt: beforeDate };
  }

  const messages = await this.find(query)
    .populate('sender', 'name avatar')
    .populate({
      path: 'replyTo',
      select: 'content type sender createdAt',
      populate: {
        path: 'sender',
        select: 'name avatar',
      },
    })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  // Inverser l'ordre pour avoir les plus anciens en premier
  return messages.reverse().map(msg => ({
    _id: msg._id,
    sender: msg.sender,
    type: msg.type,
    content: msg.content,
    audioUrl: msg.audioUrl,
    audioDuration: msg.audioDuration,
    mediaUrl: msg.mediaUrl,
    mediaType: msg.mediaType,
    fileName: msg.fileName,
    fileSize: msg.fileSize,
    translatedContent: msg.translatedContent ? Object.fromEntries(msg.translatedContent) : {},
    replyTo: msg.replyTo,
    isEdited: msg.isEdited,
    editedAt: msg.editedAt,
    reactions: msg.reactions,
    createdAt: msg.createdAt,
    updatedAt: msg.updatedAt,
  }));
};

// Middleware pour peupler automatiquement l'expéditeur
messageSchema.pre('save', function(next) {
  if (this.isNew && !this.sender) {
    next(new Error('L\'expéditeur est requis'));
  }
  next();
});

const Message = mongoose.model('Message', messageSchema);

module.exports = Message;