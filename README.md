# Meet Me - Backend API

Backend Node.js/Express pour l'application de chat Meet Me avec traduction en temps réel, messages vocaux et notifications push.

## 🚀 Fonctionnalités

### ✅ Implémentées
- **Authentification sécurisée** (JWT, bcrypt)
- **Gestion des utilisateurs** (profils, langues préférées)
- **Messagerie en temps réel** (WebSocket avec Socket.IO)
- **Traduction des messages** (Google Translate API / DeepL)
- **Stockage des fichiers** (AWS S3 ou local)
- **Base de données** (Postgres via Supabase)
- **API REST complète** avec documentation

### 🔄 En Cours
- Notifications push (Firebase Cloud Messaging)
- Appels audio/vidéo
- Analytics et monitoring

## 🏗️ Architecture

```
backend/
├── src/
│   ├── controllers/     # Contrôleurs API
│   ├── routes/         # Routes Express
│   ├── models/         # Tables Postgres (Supabase)
│   ├── middleware/     # Middleware Express
│   ├── services/       # Services métier
│   └── utils/          # Utilitaires
├── config/             # Configuration
├── uploads/           # Fichiers uploadés (local)
└── logs/              # Logs d'application
```

## 📦 Installation

### 1. Prérequis
- Node.js >= 18.0.0
- Supabase (Postgres)
- Clés API (Google Translate, DeepL, AWS, Firebase)

### 2. Installation des dépendances
```bash
cd backend
npm install
```

### 3. Configuration
```bash
# Copier le template d'environnement
cp .env.example .env

# Éditer le fichier .env avec vos configurations
nano .env
```

### 4. Démarrer le serveur
```bash
# Mode développement
npm run dev

# Mode production
npm start
```

## 🔧 Configuration

### Variables d'environnement requises
```env
# Serveur
PORT=3000
NODE_ENV=development
CORS_ORIGIN=http://localhost:8081

# Base de données
DATABASE_URL=postgres://...

# JWT
JWT_SECRET=votre_secret_jwt
JWT_EXPIRE=7d

# APIs de traduction
GOOGLE_TRANSLATE_API_KEY=votre_cle_google
DEEPL_API_KEY=votre_cle_deepl

# AWS S3 (optionnel)
AWS_ACCESS_KEY_ID=votre_access_key
AWS_SECRET_ACCESS_KEY=votre_secret_key
AWS_S3_BUCKET=votre_bucket
```

## 📡 API Endpoints

### Authentification
- `POST /api/auth/register` - Inscription
- `POST /api/auth/login` - Connexion
- `POST /api/auth/refresh` - Rafraîchir token
- `POST /api/auth/logout` - Déconnexion
- `POST /api/auth/forgot-password` - Mot de passe oublié
- `POST /api/auth/reset-password/:token` - Réinitialisation

### Utilisateurs
- `GET /api/users/profile` - Profil utilisateur
- `PUT /api/users/profile` - Mettre à jour le profil
- `GET /api/users/search` - Rechercher des utilisateurs

### Conversations
- `GET /api/chats` - Liste des conversations
- `POST /api/chats` - Créer une conversation
- `GET /api/chats/:id` - Détails d'une conversation
- `PUT /api/chats/:id` - Mettre à jour une conversation
- `DELETE /api/chats/:id` - Supprimer une conversation

### Messages
- `GET /api/messages/:chatId` - Messages d'une conversation
- `POST /api/messages` - Envoyer un message
- `PUT /api/messages/:id` - Éditer un message
- `DELETE /api/messages/:id` - Supprimer un message
- `POST /api/messages/:id/translate` - Traduire un message

### Téléchargement
- `POST /api/upload` - Télécharger un fichier
- `POST /api/upload/audio` - Télécharger un audio
- `POST /api/upload/image` - Télécharger une image
- `DELETE /api/upload/:fileUrl` - Supprimer un fichier

### Traduction
- `POST /api/translate` - Traduire un texte
- `GET /api/translate/languages` - Langues supportées

### Santé
- `GET /api/health` - Vérifier l'état du serveur
- `GET /api/docs` - Documentation API

## 💬 Socket.IO Events

### Événements clients
- `authenticate` - Authentification
- `join_chat` - Rejoindre une conversation
- `leave_chat` - Quitter une conversation
- `send_message` - Envoyer un message
- `mark_as_read` - Marquer comme lu
- `typing` - Indicateur de frappe
- `update_status` - Mettre à jour le statut

### Événements serveur
- `new_message` - Nouveau message
- `message_read` - Message lu
- `message_delivered` - Message délivré
- `user_status_changed` - Changement de statut
- `user_typing` - Utilisateur en train d'écrire
- `push_notification` - Notification push

## 🗄️ Modèles de données

### User
```javascript
{
  name: String,
  email: String,
  password: String,
  avatar: String,
  language: String,
  status: String,
  lastSeen: Date
}
```

### Chat
```javascript
{
  participants: [User],
  type: String, // 'private' ou 'group'
  lastMessage: Message,
  lastActivity: Date
}
```

### Message
```javascript
{
  chat: Chat,
  sender: User,
  type: String, // 'text', 'audio', 'image', 'video', 'file'
  content: String,
  audioUrl: String,
  mediaUrl: String,
  translatedContent: Map,
  readBy: [User],
  reactions: [Reaction]
}
```

## 🔒 Sécurité

- **JWT Authentication** avec tokens d'accès et de rafraîchissement
- **Password hashing** avec bcrypt
- **CORS** configuré
- **Helmet** pour les headers de sécurité
- **Rate limiting** pour prévenir les attaques
- **Input validation** avec Joi
- **Error handling** centralisé

## 📊 Base de données

### Postgres (Supabase) Tables
- `profiles` - Profils Utilisateurs
- `chats` - Conversations
- `chat_participants` - Participants aux conversations
- `messages` - Messages

### Indexes
- Index sur les champs fréquemment recherchés
- Index textuels pour la recherche
- Index composés pour les requêtes complexes

## 🚀 Déploiement

### 1. Préparation
```bash
# Installer les dépendances de production
npm install --production

# Build (si nécessaire)
npm run build
```

### 2. Variables d'environnement
Configurer toutes les variables d'environnement requises pour la production.

### 3. Process Manager (PM2)
```bash
# Installer PM2
npm install -g pm2

# Démarrer l'application
pm2 start src/server.js --name meetme-backend

# Monitoring
pm2 monit
pm2 logs
```

### 4. Reverse Proxy (Nginx)
```nginx
server {
    listen 80;
    server_name api.meetme.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## 🧪 Tests

```bash
# Lancer les tests
npm test

# Tests avec couverture
npm test -- --coverage

# Tests en watch mode
npm test -- --watch
```

## 📈 Monitoring

### Logs
- Winston pour le logging structuré
- Logs en JSON en production
- Rotation automatique des fichiers

### Métriques
- Endpoint `/api/health` pour la santé
- Métriques de performance
- Monitoring des erreurs

## 🔧 Développement

### Code Style
```bash
# Vérifier le style de code
npm run lint

# Corriger automatiquement
npm run lint -- --fix
```

### Structure des commits
- `feat:` Nouvelles fonctionnalités
- `fix:` Corrections de bugs
- `docs:` Documentation
- `style:` Formatage
- `refactor:` Refactorisation
- `test:` Tests
- `chore:` Tâches de maintenance

## 🤝 Contribution

1. Fork le projet
2. Créer une branche (`git checkout -b feature/AmazingFeature`)
3. Commit les changements (`git commit -m 'Add AmazingFeature'`)
4. Push vers la branche (`git push origin feature/AmazingFeature`)
5. Ouvrir une Pull Request

## 📄 Licence

MIT License - voir le fichier LICENSE pour plus de détails.

## 🆘 Support

Pour le support, ouvrez une issue sur le repository ou contactez l'équipe de développement.

## 📞 Contact

Équipe Meet Me - contact@meetme.com

---

**Note:** Ce backend est conçu pour fonctionner avec le frontend React Native/Expo Meet Me. Assurez-vous que les deux projets sont correctement configurés et communiquent entre eux.

# Meet-me-Backend
