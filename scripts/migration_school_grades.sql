-- Migration pour les notes et évaluations scolaires
CREATE TABLE IF NOT EXISTS public.school_subjects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES public.school_requests(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  teacher_name TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.school_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES public.school_requests(id) ON DELETE CASCADE,
  class_id UUID REFERENCES public.school_classes(id) ON DELETE CASCADE,
  subject_id UUID REFERENCES public.school_subjects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  type TEXT NOT NULL, -- interrogation, devoir, examen, projet
  max_score NUMERIC DEFAULT 20,
  evaluation_date DATE NOT NULL,
  description TEXT,
  is_published BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.school_grades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id UUID NOT NULL REFERENCES public.school_evaluations(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.school_students(id) ON DELETE CASCADE,
  score NUMERIC NOT NULL,
  comment TEXT,
  is_approved BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(evaluation_id, student_id)
);

-- Migration pour les absences
CREATE TABLE IF NOT EXISTS public.school_attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES public.school_requests(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.school_students(id) ON DELETE CASCADE,
  class_id UUID REFERENCES public.school_classes(id) ON DELETE SET NULL,
  date DATE NOT NULL,
  status TEXT NOT NULL, -- present, absent, excused, late
  reason TEXT,
  verified_by TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(student_id, date)
);

-- Migration pour les ressources pédagogiques
CREATE TABLE IF NOT EXISTS public.school_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES public.school_requests(id) ON DELETE CASCADE,
  class_id UUID REFERENCES public.school_classes(id) ON DELETE CASCADE,
  subject_id UUID REFERENCES public.school_subjects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  file_url TEXT NOT NULL,
  file_type TEXT, -- pdf, doc, video, image
  file_size TEXT,
  is_public BOOLEAN DEFAULT FALSE,
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Migration pour les paiements en ligne
CREATE TABLE IF NOT EXISTS public.school_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES public.school_requests(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.school_students(id) ON DELETE CASCADE,
  fee_id UUID REFERENCES public.school_fees(id) ON DELETE SET NULL,
  amount NUMERIC NOT NULL,
  payment_method TEXT NOT NULL, -- mobile_money, bank_transfer, cash, credit_card
  transaction_id TEXT UNIQUE,
  status TEXT DEFAULT 'pending', -- pending, completed, failed, refunded
  payment_date TIMESTAMP WITH TIME ZONE,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Migration pour les notifications école-parents
CREATE TABLE IF NOT EXISTS public.school_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES public.school_requests(id) ON DELETE CASCADE,
  sender_id UUID, -- NULL pour notifications système
  receiver_type TEXT NOT NULL, -- parent, student, teacher, all
  receiver_id UUID, -- NULL si receiver_type = 'all'
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL, -- grade, attendance, fee, general, alert
  related_id UUID, -- ID de l'entité liée (grade_id, attendance_id, etc.)
  is_read BOOLEAN DEFAULT FALSE,
  send_via TEXT DEFAULT 'in_app', -- in_app, email, sms, push
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index pour optimiser les performances
CREATE INDEX IF NOT EXISTS idx_school_grades_student_id ON public.school_grades(student_id);
CREATE INDEX IF NOT EXISTS idx_school_grades_evaluation_id ON public.school_grades(evaluation_id);
CREATE INDEX IF NOT EXISTS idx_school_attendance_student_id ON public.school_attendance(student_id);
CREATE INDEX IF NOT EXISTS idx_school_attendance_date ON public.school_attendance(date);
CREATE INDEX IF NOT EXISTS idx_school_resources_class_id ON public.school_resources(class_id);
CREATE INDEX IF NOT EXISTS idx_school_payments_student_id ON public.school_payments(student_id);
CREATE INDEX IF NOT EXISTS idx_school_notifications_receiver ON public.school_notifications(receiver_type, receiver_id);

-- Migrations pour ajouter les colonnes manquantes si les tables existaient déjà
DO $$
BEGIN
  -- Pour la table school_fees (ajouter les colonnes pour les paiements en ligne)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'school_fees') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_fees' AND column_name = 'payment_method') THEN
      ALTER TABLE public.school_fees ADD COLUMN payment_method TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_fees' AND column_name = 'transaction_id') THEN
      ALTER TABLE public.school_fees ADD COLUMN transaction_id TEXT UNIQUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_fees' AND column_name = 'payment_status') THEN
      ALTER TABLE public.school_fees ADD COLUMN payment_status TEXT DEFAULT 'pending';
    END IF;
  END IF;

  -- Pour la table school_requests (ajouter des colonnes pour les informations complémentaires)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'school_requests') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_requests' AND column_name = 'parent_portal_enabled') THEN
      ALTER TABLE public.school_requests ADD COLUMN parent_portal_enabled BOOLEAN DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_requests' AND column_name = 'online_payments_enabled') THEN
      ALTER TABLE public.school_requests ADD COLUMN online_payments_enabled BOOLEAN DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_requests' AND column_name = 'academic_year') THEN
      ALTER TABLE public.school_requests ADD COLUMN academic_year TEXT DEFAULT '2024-2025';
    END IF;
  END IF;
END $$;