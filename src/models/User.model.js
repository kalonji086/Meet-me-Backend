const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const validator = require('validator');
const config = require('../../config/config');

const userSchema = new mongoose.Schema({
  // Informations de base
  name: {
    type: String,
    required: [true, 'Le nom est requis'],
    trim: true,
    minlength: [2, 'Le nom doit contenir au moins 2 caractères'],
    maxlength: [50, 'Le nom ne peut pas dépasser 50 caractères'],
  },

  email: {
    type: String,
    required: [true, 'L\'email est requis'],
    unique: true,
    lowercase: true,
    trim: true,
    validate: {
      validator: validator.isEmail,
      message: 'Veuillez fournir un email valide',
    },
    index: true,
  },

  password: {
    type: String,
    required: [true, 'Le mot de passe est requis'],
    minlength: [8, 'Le mot de passe doit contenir au moins 8 caractères'],
    select: false, // Ne pas retourner le mot de passe par défaut
  },

  // Profil utilisateur
  avatar: {
    type: String,
    default: null,
  },

  bio: {
    type: String,
    maxlength: [500, 'La bio ne peut pas dépasser 500 caractères'],
    default: '',
  },

  // Préférences
  language: {
    type: String,
    enum: config.constants.supportedLanguages,
    default: config.constants.defaultLanguage,
  },

  autoTranslate: {
    type: Boolean,
    default: true,
  },

  notifications: {
    enabled: {
      type: Boolean,
      default: true,
    },
    sound: {
      type: Boolean,
      default: true,
    },
    vibration: {
      type: Boolean,
      default: true,
    },
  },

  // Statut et activité
  status: {
    type: String,
    enum: Object.values(config.constants.userStatus),
    default: config.constants.userStatus.OFFLINE,
  },

  lastSeen: {
    type: Date,
    default: Date.now,
  },

  socketId: {
    type: String,
    default: null,
  },

  // Sécurité
  passwordResetToken: String,
  passwordResetExpires: Date,
  emailVerificationToken: String,
  emailVerified: {
    type: Boolean,
    default: false,
  },

  // Métadonnées
  role: {
    type: String,
    enum: ['user', 'admin', 'moderator'],
    default: 'user',
  },

  isActive: {
    type: Boolean,
    default: true,
  },

  deletedAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
  toJSON: {
    virtuals: true,
    transform: function(doc, ret) {
      delete ret.password;
      delete ret.passwordResetToken;
      delete ret.passwordResetExpires;
      delete ret.emailVerificationToken;
      delete ret.socketId;
      return ret;
    },
  },
  toObject: {
    virtuals: true,
    transform: function(doc, ret) {
      delete ret.password;
      delete ret.passwordResetToken;
      delete ret.passwordResetExpires;
      delete ret.emailVerificationToken;
      delete ret.socketId;
      return ret;
    },
  },
});

// Index pour les recherches
userSchema.index({ email: 1 });
userSchema.index({ name: 'text', email: 'text' });
userSchema.index({ status: 1, lastSeen: -1 });
userSchema.index({ createdAt: -1 });

// Middleware de pré-sauvegarde pour hacher le mot de passe
userSchema.pre('save', async function(next) {
  // Ne hacher le mot de passe que s'il a été modifié
  if (!this.isModified('password')) return next();

  try {
    // Générer un salt
    const salt = await bcrypt.genSalt(10);
    
    // Hacher le mot de passe avec le salt
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Méthode pour comparer les mots de passe
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Méthode pour générer un token de réinitialisation de mot de passe
userSchema.methods.createPasswordResetToken = function() {
  const resetToken = require('crypto').randomBytes(32).toString('hex');
  
  this.passwordResetToken = require('crypto')
    .createHash('sha256')
    .update(resetToken)
    .digest('hex');
    
  this.passwordResetExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
  
  return resetToken;
};

// Méthode pour vérifier si le token de réinitialisation est valide
userSchema.methods.isPasswordResetTokenValid = function(token) {
  if (!this.passwordResetToken || !this.passwordResetExpires) {
    return false;
  }

  const hashedToken = require('crypto')
    .createHash('sha256')
    .update(token)
    .digest('hex');

  return this.passwordResetToken === hashedToken && 
         Date.now() < this.passwordResetExpires;
};

// Méthode pour mettre à jour le statut
userSchema.methods.updateStatus = function(status, socketId = null) {
  this.status = status;
  this.lastSeen = Date.now();
  
  if (socketId) {
    this.socketId = socketId;
  }
  
  return this.save();
};

// Méthode pour obtenir le profil public
userSchema.methods.getPublicProfile = function() {
  return {
    _id: this._id,
    name: this.name,
    email: this.email,
    avatar: this.avatar,
    bio: this.bio,
    language: this.language,
    status: this.status,
    lastSeen: this.lastSeen,
    createdAt: this.createdAt,
  };
};

// Méthode pour obtenir le profil complet (pour l'utilisateur lui-même)
userSchema.methods.getFullProfile = function() {
  return {
    _id: this._id,
    name: this.name,
    email: this.email,
    avatar: this.avatar,
    bio: this.bio,
    language: this.language,
    autoTranslate: this.autoTranslate,
    notifications: this.notifications,
    status: this.status,
    lastSeen: this.lastSeen,
    emailVerified: this.emailVerified,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

// Virtual pour les conversations (sera peuplé via populate)
userSchema.virtual('conversations', {
  ref: 'Chat',
  localField: '_id',
  foreignField: 'participants',
});

// Méthode statique pour rechercher des utilisateurs
userSchema.statics.searchUsers = async function(searchTerm, excludeUserId, limit = 20) {
  const query = {
    $and: [
      {
        $or: [
          { name: { $regex: searchTerm, $options: 'i' } },
          { email: { $regex: searchTerm, $options: 'i' } },
        ],
      },
      { _id: { $ne: excludeUserId } },
      { isActive: true },
      { deletedAt: null },
    ],
  };

  return this.find(query)
    .select('name email avatar status lastSeen language')
    .limit(limit)
    .sort({ name: 1 });
};

// Méthode statique pour trouver par email
userSchema.statics.findByEmail = function(email) {
  return this.findOne({ email: email.toLowerCase() });
};

// Middleware pour le soft delete
userSchema.pre('find', function() {
  this.where({ deletedAt: null });
});

userSchema.pre('findOne', function() {
  this.where({ deletedAt: null });
});

const User = mongoose.model('User', userSchema);

module.exports = User;