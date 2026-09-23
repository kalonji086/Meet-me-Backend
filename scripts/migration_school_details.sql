CREATE TABLE IF NOT EXISTS public.school_account_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES public.school_requests(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL, -- prefet, directeur, enseignant, professeur
  phone TEXT,
  status TEXT DEFAULT 'en_attente', -- en_attente, approuve, rejete
  generated_code TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.school_classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES public.school_requests(id) ON DELETE CASCADE,
  staff_id UUID REFERENCES public.school_account_requests(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  level TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.school_students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES public.school_requests(id) ON DELETE CASCADE,
  class_id UUID REFERENCES public.school_classes(id) ON DELETE SET NULL,
  full_name TEXT NOT NULL,
  gender TEXT,
  birth_date TEXT,
  access_code TEXT UNIQUE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.school_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES public.school_requests(id) ON DELETE CASCADE,
  class_id UUID REFERENCES public.school_classes(id) ON DELETE CASCADE,
  day_of_week TEXT NOT NULL, -- Lundi, Mardi, etc.
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  subject TEXT NOT NULL,
  teacher_name TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.school_fees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES public.school_requests(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.school_students(id) ON DELETE CASCADE,
  amount_due NUMERIC DEFAULT 0,
  amount_paid NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'non_paye', -- paye, partiel, non_paye
  due_date TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Migrations pour ajouter les colonnes manquantes si la table existait déjà
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'school_classes') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_classes' AND column_name = 'staff_id') THEN
      ALTER TABLE public.school_classes ADD COLUMN staff_id UUID REFERENCES public.school_account_requests(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_classes' AND column_name = 'is_active') THEN
      ALTER TABLE public.school_classes ADD COLUMN is_active BOOLEAN DEFAULT TRUE;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'school_students') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_students' AND column_name = 'full_name') THEN
      ALTER TABLE public.school_students ADD COLUMN full_name TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_students' AND column_name = 'gender') THEN
      ALTER TABLE public.school_students ADD COLUMN gender TEXT DEFAULT 'M';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_students' AND column_name = 'birth_date') THEN
      ALTER TABLE public.school_students ADD COLUMN birth_date TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_students' AND column_name = 'access_code') THEN
      ALTER TABLE public.school_students ADD COLUMN access_code TEXT UNIQUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_students' AND column_name = 'class_id') THEN
      ALTER TABLE public.school_students ADD COLUMN class_id UUID REFERENCES public.school_classes(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_students' AND column_name = 'is_active') THEN
      ALTER TABLE public.school_students ADD COLUMN is_active BOOLEAN DEFAULT TRUE;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_students' AND column_name = 'name') THEN
      UPDATE public.school_students SET full_name = name WHERE full_name IS NULL AND name IS NOT NULL;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'school_account_requests') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_account_requests' AND column_name = 'generated_code') THEN
      ALTER TABLE public.school_account_requests ADD COLUMN generated_code TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_account_requests' AND column_name = 'status') THEN
      ALTER TABLE public.school_account_requests ADD COLUMN status TEXT DEFAULT 'en_attente';
    END IF;
  END IF;
END $$;
