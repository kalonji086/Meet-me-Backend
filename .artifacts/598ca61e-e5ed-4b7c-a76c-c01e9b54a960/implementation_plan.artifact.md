# Migration MongoDB vers Supabase (Postgres)

Ce plan détaille les étapes nécessaires pour remplacer complètement MongoDB par Supabase dans le backend de Meet Me, supprimer toutes les traces de MongoDB et mettre en œuvre une automatisation des tables sur Render.

## User Review Required

> [!IMPORTANT]
> - **Changement de paradigme** : Nous passons d'un modèle NoSQL (MongoDB) à un modèle Relationnel (PostgreSQL).
> - **Données existantes** : Si vous avez des données dans MongoDB, elles ne seront pas migrées automatiquement avec ce plan.
> - **Variables d'environnement** : Vous devrez configurer les variables `DATABASE_URL` ou les détails individuels de la DB Postgres dans Render/Supabase.

## Proposed Changes

### 1. Configuration de la Base de Données & Migrations

#### [MODIFY] [database_setup.sql](file:///G:/Meet Me/MeeetMe/MeeetMe/MeeetMe/MeeetMe/backend/database_setup.sql)
- Mise à jour du script pour utiliser `IF NOT EXISTS`.
- Ajout de contraintes manquantes si nécessaire.

#### [NEW] [migration.js](file:///G:/Meet Me/MeeetMe/MeeetMe/MeeetMe/MeeetMe/backend/src/utils/migration.js)
- Utilitaire pour lire `database_setup.sql` et l'exécuter au démarrage.
- Vérification de l'existence des tables avant exécution.

#### [MODIFY] [server.js](file:///G:/Meet Me/MeeetMe/MeeetMe/MeeetMe/MeeetMe/backend/src/server.js)
- Intégration de l'appel à `migration.js` dans `initializeDatabase()`.

---

### 2. Nettoyage de MongoDB

#### [MODIFY] [package.json](file:///G:/Meet Me/MeeetMe/MeeetMe/MeeetMe/MeeetMe/backend/package.json)
- Suppression de `mongoose`.

#### [DELETE] [User.model.js](file:///G:/Meet Me/MeeetMe/MeeetMe/MeeetMe/MeeetMe/backend/src/models/User.model.js)
#### [DELETE] [Chat.model.js](file:///G:/Meet Me/MeeetMe/MeeetMe/MeeetMe/MeeetMe/backend/src/models/Chat.model.js)
#### [DELETE] [Message.model.js](file:///G:/Meet Me/MeeetMe/MeeetMe/MeeetMe/MeeetMe/backend/src/models/Message.model.js)

#### [MODIFY] [.env.example](file:///G:/Meet Me/MeeetMe/MeeetMe/MeeetMe/MeeetMe/backend/.env.example)
- Suppression de `MONGODB_URI`.
- Ajout des variables Supabase/Postgres.

---

### 3. Refactorisation du Code

#### [MODIFY] [socket.service.js](file:///G:/Meet Me/MeeetMe/MeeetMe/MeeetMe/MeeetMe/backend/src/services/socket.service.js)
- Réécriture complète des méthodes utilisant Mongoose pour utiliser des requêtes SQL via `pg`.

#### [MODIFY] [upload.controller.js](file:///G:/Meet Me/MeeetMe/MeeetMe/MeeetMe/MeeetMe/backend/src/controllers/upload.controller.js)
- Remplacement de l'appel à `Chat.model` par une requête Postgres dans `uploadChatFile`.

#### [MODIFY] [auth.middleware.js](file:///G:/Meet Me/MeeetMe/MeeetMe/MeeetMe/MeeetMe/backend/src/middleware/auth.middleware.js)
- Suppression des références aux modèles Mongoose dans les fonctions de vérification de propriété.

---

### 4. Documentation

#### [MODIFY] [README.md](file:///G:/Meet Me/MeeetMe/MeeetMe/MeeetMe/MeeetMe/backend/README.md)
- Mise à jour des prérequis (Postgres au lieu de Mongo).
- Mise à jour de la section Architecture.

#### [MODIFY] [BACKEND_SUMMARY.md](file:///G:/Meet Me/MeeetMe/MeeetMe/MeeetMe/MeeetMe/backend/BACKEND_SUMMARY.md)
- Remplacement de toutes les mentions de MongoDB par Supabase/Postgres.

## Verification Plan

### Automated Tests
- Lancement de `npm start` pour vérifier l'exécution automatique des migrations.
- Test des endpoints d'authentification (`register`, `login`) avec la nouvelle base Postgres.
- Test de l'upload de fichiers et de la liaison avec les conversations.

### Manual Verification
- Vérification sur l'interface Supabase que les tables sont créées lors du démarrage de l'application sur Render.
- Test du chat en temps réel via Socket.io pour s'assurer que les messages sont correctement enregistrés dans Postgres.
