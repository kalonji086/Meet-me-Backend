CREATE TABLE IF NOT EXISTS public.school_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  school_name TEXT NOT NULL,
  school_email TEXT NOT NULL,
  school_phone TEXT,
  school_address TEXT,
  school_type TEXT, -- ex: Primaire, Secondaire, Universitaire
  description TEXT,
  status TEXT DEFAULT 'en_attente', -- en_attente, approuve, rejete
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index pour accélérer les recherches par utilisateur
CREATE INDEX IF NOT EXISTS idx_school_requests_user_id ON public.school_requests(user_id);
