CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Nettoyage
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'profiles_id_fkey') THEN
    ALTER TABLE public.profiles DROP CONSTRAINT profiles_id_fkey;
  END IF;
END $$;

-- 2. Création des tables
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
  login_attempts INTEGER DEFAULT 0,
  is_locked BOOLEAN DEFAULT FALSE,
  last_login_at TIMESTAMP WITH TIME ZONE,
  is_global_admin BOOLEAN DEFAULT FALSE,
  privacy_settings JSONB DEFAULT '{"last_seen": "everyone", "profile_photo": "everyone", "status": "everyone", "read_receipts": true}',
  push_token TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. GARANTIE ADMIN MASTER (Crucial)
UPDATE public.profiles SET is_global_admin = TRUE WHERE email = 'wecanconcept@gmail.com';
UPDATE public.profiles SET is_global_admin = TRUE WHERE email = 'zuwandaku@gmail.com';
UPDATE public.profiles SET is_global_admin = TRUE WHERE email = 'defaokalonji086@gmail.com';

-- 4. Autres tables
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

-- 5. Triggers
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
