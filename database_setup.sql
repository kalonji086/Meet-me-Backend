CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Nettoyage initial
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'profiles_id_fkey') THEN
    ALTER TABLE public.profiles DROP CONSTRAINT profiles_id_fkey;
  END IF;
END $$;

-- 2. Création des tables de base
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL
);

-- 3. Migration progressive Profiles
DO $$
BEGIN
  -- username
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='username') THEN
    ALTER TABLE public.profiles ADD COLUMN username TEXT UNIQUE;
  END IF;

  -- full_name
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='full_name') THEN
    ALTER TABLE public.profiles ADD COLUMN full_name TEXT;
  END IF;

  -- avatar_url
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='avatar_url') THEN
    ALTER TABLE public.profiles ADD COLUMN avatar_url TEXT;
  END IF;

  -- status
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='status') THEN
    ALTER TABLE public.profiles ADD COLUMN status TEXT DEFAULT 'Disponible';
  END IF;

  -- last_seen
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='last_seen') THEN
    ALTER TABLE public.profiles ADD COLUMN last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW();
  END IF;

  -- phone_number
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='phone_number') THEN
    ALTER TABLE public.profiles ADD COLUMN phone_number TEXT UNIQUE;
  END IF;

  -- login_attempts
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='login_attempts') THEN
    ALTER TABLE public.profiles ADD COLUMN login_attempts INTEGER DEFAULT 0;
  END IF;

  -- is_locked
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='is_locked') THEN
    ALTER TABLE public.profiles ADD COLUMN is_locked BOOLEAN DEFAULT FALSE;
  END IF;

  -- is_global_admin
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='is_global_admin') THEN
    ALTER TABLE public.profiles ADD COLUMN is_global_admin BOOLEAN DEFAULT FALSE;
  END IF;

  -- created_at
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='created_at') THEN
    ALTER TABLE public.profiles ADD COLUMN created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
  END IF;

  -- last_login_at
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='last_login_at') THEN
    ALTER TABLE public.profiles ADD COLUMN last_login_at TIMESTAMP WITH TIME ZONE;
  END IF;

  -- push_token
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='push_token') THEN
    ALTER TABLE public.profiles ADD COLUMN push_token TEXT;
  END IF;

  -- additional profile columns (v19.0.3)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='is_verified') THEN
    ALTER TABLE public.profiles ADD COLUMN is_verified BOOLEAN DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='accepted_legal_version') THEN
    ALTER TABLE public.profiles ADD COLUMN accepted_legal_version TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='app_version') THEN
    ALTER TABLE public.profiles ADD COLUMN app_version TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='last_update_at') THEN
    ALTER TABLE public.profiles ADD COLUMN last_update_at TIMESTAMP WITH TIME ZONE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='status_updated_at') THEN
    ALTER TABLE public.profiles ADD COLUMN status_updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='device_info') THEN
    ALTER TABLE public.profiles ADD COLUMN device_info JSONB DEFAULT '{}'::jsonb;
  END IF;

  -- legal versions
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='accepted_tos_version') THEN
    ALTER TABLE public.profiles ADD COLUMN accepted_tos_version TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='accepted_privacy_version') THEN
    ALTER TABLE public.profiles ADD COLUMN accepted_privacy_version TEXT;
  END IF;

  -- AI Translation Settings
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='preferred_language') THEN
    ALTER TABLE public.profiles ADD COLUMN preferred_language TEXT DEFAULT 'fr';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='auto_translate') THEN
    ALTER TABLE public.profiles ADD COLUMN auto_translate BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

-- 4. Droits Administrateurs
UPDATE public.profiles SET is_global_admin = FALSE;
UPDATE public.profiles SET is_global_admin = TRUE WHERE email = 'wecanconcept@gmail.com';

-- 5. Autres tables avec CASCADE
CREATE TABLE IF NOT EXISTS public.chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  description TEXT,
  avatar_url TEXT,
  type TEXT DEFAULT 'private' CHECK (type IN ('private', 'group')),
  is_banned BOOLEAN DEFAULT FALSE,
  last_message TEXT,
  last_message_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public.chat_participants (
  chat_id UUID REFERENCES public.chats(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  is_archived BOOLEAN DEFAULT FALSE,
  is_favorite BOOLEAN DEFAULT FALSE,
  is_priority BOOLEAN DEFAULT FALSE,
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
  translated_content TEXT,
  source_language TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Fix colonnes manquantes (Critique pour erreurs logs)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='messages' AND column_name='translated_content') THEN
    ALTER TABLE public.messages ADD COLUMN translated_content TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='messages' AND column_name='source_language') THEN
    ALTER TABLE public.messages ADD COLUMN source_language TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='messages' AND column_name='deleted_for_users') THEN
    ALTER TABLE public.messages ADD COLUMN deleted_for_users UUID[] DEFAULT '{}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='messages' AND column_name='likes') THEN
    ALTER TABLE public.messages ADD COLUMN likes UUID[] DEFAULT '{}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='messages' AND column_name='metadata') THEN
    ALTER TABLE public.messages ADD COLUMN metadata JSONB DEFAULT '{}'::jsonb;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.appeals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  contact_email TEXT,
  type TEXT DEFAULT 'appeal' CHECK (type IN ('appeal', 'helpdesk', 'deletion')),
  category TEXT DEFAULT 'other',
  reason TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'resolved')),
  admin_reply TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  resolved_at TIMESTAMP WITH TIME ZONE
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='appeals' AND column_name='type') THEN
    ALTER TABLE public.appeals ADD COLUMN type TEXT DEFAULT 'appeal';
    ALTER TABLE public.appeals ADD COLUMN category TEXT DEFAULT 'other';
    ALTER TABLE public.appeals ADD COLUMN contact_email TEXT;
  END IF;
END $$;

-- 6. Triggers
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

-- 7. Tables additionnelles
CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  callee_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'missed' CHECK (status IN ('offered','connected','rejected','missed','hung_up')),
  call_type TEXT DEFAULT 'audio' CHECK (call_type IN ('audio','video')),
  channel_name TEXT,
  started_at TIMESTAMP WITH TIME ZONE,
  ended_at TIMESTAMP WITH TIME ZONE,
  duration_seconds INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Migration des colonnes calls si nécessaire
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='calls' AND column_name='callee_id') THEN
    ALTER TABLE public.calls ADD COLUMN callee_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.blocked_users (
  blocker_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  blocked_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS public.contacts (
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (user_id, contact_id)
);

-- reported_content (v19.0.3)
CREATE TABLE IF NOT EXISTS public.reported_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_type TEXT NOT NULL CHECK (report_type IN ('message', 'user', 'group')),
  target_id UUID,
  target_name TEXT,
  reporter_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  reporter_name TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'resolved', 'dismissed')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  resolved_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS public.verification_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  document_url TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Table pour les campagnes et diffusions
CREATE TABLE IF NOT EXISTS public.notification_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT 'all' CHECK (target IN ('all', 'specific')),
  target_value TEXT,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  sent_count INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'processing', 'sent', 'failed')),
  scheduled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Table pour les médias (Images, Audio, Documents)
CREATE TABLE IF NOT EXISTS public.media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  message_id UUID REFERENCES public.messages(id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  file_name TEXT,
  file_size INTEGER,
  mime_type TEXT,
  type TEXT CHECK (type IN ('image', 'audio', 'video', 'file')),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Migration pour les campagnes (scheduled_at, metadata)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='notification_campaigns') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notification_campaigns' AND column_name='scheduled_at') THEN
      ALTER TABLE public.notification_campaigns ADD COLUMN scheduled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notification_campaigns' AND column_name='metadata') THEN
      ALTER TABLE public.notification_campaigns ADD COLUMN metadata JSONB DEFAULT '{}'::jsonb;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notification_campaigns' AND column_name='updated_at') THEN
      ALTER TABLE public.notification_campaigns ADD COLUMN updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    END IF;

    -- Fix status constraint
    ALTER TABLE public.notification_campaigns DROP CONSTRAINT IF EXISTS notification_campaigns_status_check;
    ALTER TABLE public.notification_campaigns ADD CONSTRAINT notification_campaigns_status_check CHECK (status IN ('scheduled', 'processing', 'sent', 'failed'));
  END IF;
END $$;

-- 8. CORRECTIF CRITIQUE POUR SUPPRESSION DE COMPTE (Migrations des contraintes existantes)
DO $$
BEGIN
  -- Fix chats.created_by constraint
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'chats_created_by_fkey') THEN
    ALTER TABLE public.chats DROP CONSTRAINT chats_created_by_fkey;
  END IF;
  ALTER TABLE public.chats ADD CONSTRAINT chats_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

  -- Fix messages.sender_id constraint
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'messages_sender_id_fkey') THEN
    ALTER TABLE public.messages DROP CONSTRAINT messages_sender_id_fkey;
  END IF;
  ALTER TABLE public.messages ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

  -- Fix chat_participants.user_id constraint
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'chat_participants_user_id_fkey') THEN
    ALTER TABLE public.chat_participants DROP CONSTRAINT chat_participants_user_id_fkey;
  END IF;
  ALTER TABLE public.chat_participants ADD CONSTRAINT chat_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

  -- Add is_favorite and is_priority to chat_participants
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chat_participants' AND column_name='is_favorite') THEN
    ALTER TABLE public.chat_participants ADD COLUMN is_favorite BOOLEAN DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chat_participants' AND column_name='is_priority') THEN
    ALTER TABLE public.chat_participants ADD COLUMN is_priority BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

-- 9. Activer le Realtime Supabase pour les messages et discussions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
    AND schemaname = 'public'
    AND tablename = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
    AND schemaname = 'public'
    AND tablename = 'chats'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chats;
  END IF;
END $$;

-- Market Module Tables
CREATE TABLE IF NOT EXISTS public.market_businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE UNIQUE,
  category TEXT NOT NULL,
  business_name TEXT NOT NULL,
  short_description TEXT,
  full_description TEXT,
  logo_url TEXT,
  banner_url TEXT,
  contact_info TEXT,
  address_city TEXT,
  address_commune TEXT,
  address_province TEXT,
  address_quarter TEXT,
  address_postal_code TEXT,
  id_card_url TEXT,
  national_id_number TEXT,
  rccm_number TEXT,
  employee_count INTEGER,
  capital_amount DECIMAL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'blocked')),
  verified_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Market Posts (Exploits / Annonces)
CREATE TABLE IF NOT EXISTS public.market_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES public.market_businesses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  images TEXT[] DEFAULT '{}',
  type TEXT DEFAULT 'announcement' CHECK (type IN ('exploit', 'announcement')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Market Requests (Devis / Demandes de service)
CREATE TABLE IF NOT EXISTS public.market_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES public.market_businesses(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('devis', 'service')),
  details JSONB NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'completed')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Market Orders (Boutique specific)
CREATE TABLE IF NOT EXISTS public.market_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES public.market_businesses(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  items JSONB NOT NULL,
  total_amount DECIMAL NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'cancelled')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Market Inventory (Boutique specific)
CREATE TABLE IF NOT EXISTS public.market_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES public.market_businesses(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  transaction_type TEXT CHECK (transaction_type IN ('in', 'out')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Market Reviews (Comments)
CREATE TABLE IF NOT EXISTS public.market_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES public.market_businesses(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Market Post Likes
CREATE TABLE IF NOT EXISTS public.market_post_likes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES public.market_posts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(post_id, user_id)
);

-- Market Post Comments
CREATE TABLE IF NOT EXISTS public.market_post_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES public.market_posts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Market Business Subscriptions (Followers)
CREATE TABLE IF NOT EXISTS public.market_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES public.market_businesses(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(business_id, user_id)
);

-- Market Documents (Portfolio)
CREATE TABLE IF NOT EXISTS public.market_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES public.market_businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_size TEXT,
  mime_type TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Market Quotes (Devis)
CREATE TABLE IF NOT EXISTS public.market_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES public.market_businesses(id) ON DELETE CASCADE,
  request_id UUID REFERENCES public.market_requests(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  amount DECIMAL,
  file_url TEXT,
  items JSONB DEFAULT '[]'::jsonb,
  status TEXT DEFAULT 'sent' CHECK (status IN ('draft', 'sent', 'accepted', 'rejected')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Admin Delegations (Atributions)
CREATE TABLE IF NOT EXISTS public.admin_delegations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE UNIQUE,
  modules TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Admin Pending Actions (Approval System)
CREATE TABLE IF NOT EXISTS public.admin_pending_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  target_id TEXT,
  target_name TEXT,
  details JSONB DEFAULT '{}'::jsonb,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  processed_at TIMESTAMP WITH TIME ZONE,
  processed_by UUID REFERENCES public.profiles(id)
);

ALTER TABLE public.messages REPLICA IDENTITY FULL;
