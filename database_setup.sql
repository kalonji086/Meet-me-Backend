CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Supprimer la contrainte de clé étrangère avec Supabase Auth si elle existe
-- Cela permet au backend personnalisé de gérer ses propres IDs
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'profiles_id_fkey') THEN
    ALTER TABLE public.profiles DROP CONSTRAINT profiles_id_fkey;
  END IF;
END $$;

-- Assurer que les colonnes id ont bien le défaut gen_random_uuid()
DO $$
BEGIN
  -- Profiles
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'profiles' AND table_schema = 'public') THEN
    ALTER TABLE public.profiles ALTER COLUMN id SET DEFAULT gen_random_uuid();
  END IF;

  -- Chats
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'chats' AND table_schema = 'public') THEN
    ALTER TABLE public.chats ALTER COLUMN id SET DEFAULT gen_random_uuid();
  END IF;

  -- Messages
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'messages' AND table_schema = 'public') THEN
    ALTER TABLE public.messages ALTER COLUMN id SET DEFAULT gen_random_uuid();
  END IF;

  -- AJOUT DES COLONNES MANQUANTES SI ELLES EXISTENT DÉJÀ
  -- Profiles: phone_number
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='phone_number') THEN
    ALTER TABLE public.profiles ADD COLUMN phone_number TEXT UNIQUE;
  END IF;

  -- Chat Participants: is_archived
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chat_participants' AND column_name='is_archived') THEN
    ALTER TABLE public.chat_participants ADD COLUMN is_archived BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

-- ==========================================
-- 1. TABLE DES PROFILS
-- ==========================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  username TEXT UNIQUE,
  full_name TEXT,
  avatar_url TEXT,
  status TEXT DEFAULT 'Disponible',
  last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  phone_number TEXT UNIQUE,
  otp_code TEXT,
  otp_expires_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ==========================================
-- 2. TABLE DES CONVERSATIONS (CHATS)
-- ==========================================
CREATE TABLE IF NOT EXISTS public.chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT, -- Nom pour les groupes
  avatar_url TEXT, -- Image de groupe
  type TEXT DEFAULT 'private' CHECK (type IN ('private', 'group')),
  last_message TEXT,
  last_message_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by UUID REFERENCES public.profiles(id)
);

-- ==========================================
-- 3. TABLE DES PARTICIPANTS
-- ==========================================
CREATE TABLE IF NOT EXISTS public.chat_participants (
  chat_id UUID REFERENCES public.chats(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  is_archived BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (chat_id, user_id)
);

-- ==========================================
-- 4. TABLE DES MESSAGES
-- ==========================================
CREATE TABLE IF NOT EXISTS public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id UUID REFERENCES public.chats(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  type TEXT DEFAULT 'text' CHECK (type IN ('text', 'image', 'audio', 'video', 'file')),
  file_url TEXT, -- Si type != 'text'
  status TEXT DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read')),
  translated_content JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ==========================================
-- 5. TABLE DES STATUS (ACTUS)
-- ==========================================
CREATE TABLE IF NOT EXISTS public.statuses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT, -- Texte du status ou légende de la photo
  type TEXT DEFAULT 'text' CHECK (type IN ('text', 'image')),
  media_url TEXT, -- URL de l'image si type = 'image'
  background_color TEXT DEFAULT '#128C7E', -- Pour les status texte
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '24 hours')
);

-- ==========================================
-- 6. TABLE DES RÉACTIONS DE STATUS
-- ==========================================
CREATE TABLE IF NOT EXISTS public.status_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status_id UUID REFERENCES public.statuses(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT, -- Le commentaire, l'emoji ou l'identifiant du sticker
  type TEXT DEFAULT 'emoji' CHECK (type IN ('emoji', 'comment', 'sticker', 'like')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ==========================================
-- 7. FONCTIONS ET TRIGGERS
-- ==========================================

-- Mise à jour automatique de last_message dans la table chats
CREATE OR REPLACE FUNCTION update_last_message_at()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.chats
  SET last_message = NEW.content,
      last_message_at = NEW.created_at
  WHERE id = NEW.chat_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_new_message_update_chat ON public.messages;
CREATE TRIGGER on_new_message_update_chat
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION update_last_message_at();
