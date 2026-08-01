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
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ==========================================
-- 5. FONCTIONS ET TRIGGERS
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
