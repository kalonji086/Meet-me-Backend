CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Nettoyage et initialisation des types
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'profiles_id_fkey') THEN
    ALTER TABLE public.profiles DROP CONSTRAINT profiles_id_fkey;
  END IF;
END $$;

-- 2. Création des tables si elles n'existent pas
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
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Mise à jour des colonnes une par une (Sécurité et Admin)
DO $$
BEGIN
  -- login_attempts
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='login_attempts') THEN
    ALTER TABLE public.profiles ADD COLUMN login_attempts INTEGER DEFAULT 0;
  END IF;

  -- is_locked
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='is_locked') THEN
    ALTER TABLE public.profiles ADD COLUMN is_locked BOOLEAN DEFAULT FALSE;
  END IF;

  -- last_login_at
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='last_login_at') THEN
    ALTER TABLE public.profiles ADD COLUMN last_login_at TIMESTAMP WITH TIME ZONE;
  END IF;

  -- is_global_admin
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='is_global_admin') THEN
    ALTER TABLE public.profiles ADD COLUMN is_global_admin BOOLEAN DEFAULT FALSE;
  END IF;

  -- privacy_settings
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='privacy_settings') THEN
    ALTER TABLE public.profiles ADD COLUMN privacy_settings JSONB DEFAULT '{"last_seen": "everyone", "profile_photo": "everyone", "status": "everyone", "read_receipts": true}';
  END IF;

  -- push_token
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='push_token') THEN
    ALTER TABLE public.profiles ADD COLUMN push_token TEXT;
  END IF;
END $$;

-- 4. Initialisation des droits Admin
UPDATE public.profiles SET is_global_admin = TRUE WHERE email = 'zuwandaku@gmail.com';
UPDATE public.profiles SET is_global_admin = TRUE WHERE email = 'defaokalonji086@gmail.com';

-- 5. Autres tables
CREATE TABLE IF NOT EXISTS public.chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  description TEXT,
  avatar_url TEXT,
  type TEXT DEFAULT 'private' CHECK (type IN ('private', 'group')),
  last_message TEXT,
  last_message_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by UUID REFERENCES public.profiles(id)
);

CREATE TABLE IF NOT EXISTS public.chat_participants (
  chat_id UUID REFERENCES public.chats(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  is_archived BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id UUID REFERENCES public.chats(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  type TEXT DEFAULT 'text' CHECK (type IN ('text', 'image', 'audio', 'video', 'file')),
  file_url TEXT,
  status TEXT DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  receiver_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  type TEXT DEFAULT 'audio' CHECK (type IN ('audio', 'video')),
  status TEXT DEFAULT 'missed' CHECK (status IN ('missed', 'answered', 'rejected')),
  duration INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.statuses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT,
  type TEXT DEFAULT 'text' CHECK (type IN ('text', 'image')),
  media_url TEXT,
  background_color TEXT DEFAULT '#128C7E',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '24 hours')
);

-- 6. Fonctions et Triggers
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
