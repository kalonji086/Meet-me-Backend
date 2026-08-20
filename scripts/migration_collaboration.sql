-- Migration: Collaboration Module

-- 1. Teams / Projects
CREATE TABLE IF NOT EXISTS public.collab_teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Team Members
CREATE TABLE IF NOT EXISTS public.collab_team_members (
  team_id UUID REFERENCES public.collab_teams(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'collaborator' CHECK (role IN ('collaborator', 'manager', 'admin')),
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_read_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (team_id, user_id)
);

-- Ensure column exists (Migration)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='collab_team_members' AND column_name='last_read_at') THEN
    ALTER TABLE public.collab_team_members ADD COLUMN last_read_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
  END IF;
END $$;

-- 3. Tasks
CREATE TABLE IF NOT EXISTS public.collab_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES public.collab_teams(id) ON DELETE CASCADE,
  creator_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  assignee_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  deadline TIMESTAMP WITH TIME ZONE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Ensure columns exist (Migration for existing tables)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='collab_tasks' AND column_name='progress') THEN
    ALTER TABLE public.collab_tasks ADD COLUMN progress INTEGER DEFAULT 0;
  END IF;
END $$;

-- 4. Internal Messaging (Chat)
CREATE TABLE IF NOT EXISTS public.collab_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES public.collab_teams(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Shared Documents
CREATE TABLE IF NOT EXISTS public.collab_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES public.collab_teams(id) ON DELETE CASCADE,
  uploader_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  file_url TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER,
  mime_type TEXT,
  version INTEGER DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_comment TEXT,
  is_archived BOOLEAN DEFAULT FALSE,
  archive_expires_at TIMESTAMP WITH TIME ZONE,
  deleted_for_users UUID[] DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Ensure columns exist (Migration for existing tables)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='collab_documents' AND column_name='is_archived') THEN
    ALTER TABLE public.collab_documents ADD COLUMN is_archived BOOLEAN DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='collab_documents' AND column_name='archive_expires_at') THEN
    ALTER TABLE public.collab_documents ADD COLUMN archive_expires_at TIMESTAMP WITH TIME ZONE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='collab_documents' AND column_name='deleted_for_users') THEN
    ALTER TABLE public.collab_documents ADD COLUMN deleted_for_users UUID[] DEFAULT '{}';
  END IF;
END $$;

-- 6. Collaboration Requests (Applications)
CREATE TABLE IF NOT EXISTS public.collab_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  team_id UUID REFERENCES public.collab_teams(id) ON DELETE CASCADE,
  motivation TEXT,
  objectives TEXT,
  skills TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_comment TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  processed_at TIMESTAMP WITH TIME ZONE,
  processed_by UUID REFERENCES public.profiles(id)
);

-- Ensure columns exist (Migration for existing tables)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='collab_requests' AND column_name='motivation') THEN
    ALTER TABLE public.collab_requests ADD COLUMN motivation TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='collab_requests' AND column_name='objectives') THEN
    ALTER TABLE public.collab_requests ADD COLUMN objectives TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='collab_requests' AND column_name='skills') THEN
    ALTER TABLE public.collab_requests ADD COLUMN skills TEXT;
  END IF;
END $$;

-- 7. Calendar Events (Meetings, Availability)
CREATE TABLE IF NOT EXISTS public.collab_calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES public.collab_teams(id) ON DELETE CASCADE,
  creator_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  start_at TIMESTAMP WITH TIME ZONE NOT NULL,
  end_at TIMESTAMP WITH TIME ZONE NOT NULL,
  type TEXT NOT NULL DEFAULT 'meeting' CHECK (type IN ('meeting', 'availability', 'deadline')),
  status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_collab_calendar_team ON public.collab_calendar_events(team_id);

-- 8. Permissions Config
CREATE TABLE IF NOT EXISTS public.collab_permissions_config (
  role TEXT PRIMARY KEY CHECK (role IN ('collaborator', 'manager', 'admin')),
  can_read BOOLEAN DEFAULT TRUE,
  can_write BOOLEAN DEFAULT FALSE,
  can_delete BOOLEAN DEFAULT FALSE,
  modules TEXT[] DEFAULT '{}' -- ['tasks', 'documents', 'chat', 'members']
);

-- Initial permissions
INSERT INTO public.collab_permissions_config (role, can_read, can_write, can_delete, modules) VALUES
('collaborator', true, true, false, '{"tasks", "chat", "documents"}'),
('manager', true, true, true, '{"tasks", "chat", "documents", "members"}'),
('admin', true, true, true, '{"tasks", "chat", "documents", "members", "requests"}')
ON CONFLICT (role) DO NOTHING;

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_collab_tasks_team ON public.collab_tasks(team_id);
CREATE INDEX IF NOT EXISTS idx_collab_messages_team ON public.collab_messages(team_id);
CREATE INDEX IF NOT EXISTS idx_collab_documents_team ON public.collab_documents(team_id);
