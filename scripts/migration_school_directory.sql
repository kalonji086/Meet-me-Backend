CREATE TABLE IF NOT EXISTS public.schools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id TEXT UNIQUE,
  name TEXT NOT NULL,
  school_type TEXT,
  country TEXT,
  city TEXT,
  address TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  logo TEXT,
  latitude NUMERIC(10, 8),
  longitude NUMERIC(11, 8),
  source TEXT NOT NULL DEFAULT 'manual',
  is_partner BOOLEAN NOT NULL DEFAULT FALSE,
  claimed BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

ALTER TABLE public.schools ADD COLUMN IF NOT EXISTS school_type TEXT;
ALTER TABLE public.schools ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE public.schools ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW();
ALTER TABLE public.schools ADD COLUMN IF NOT EXISTS claimed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.schools ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE public.school_requests ADD COLUMN IF NOT EXISTS directory_school_id UUID;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'school_requests_directory_school_id_fkey'
      AND conrelid = 'public.school_requests'::regclass
  ) THEN
    ALTER TABLE public.school_requests
      ADD CONSTRAINT school_requests_directory_school_id_fkey
      FOREIGN KEY (directory_school_id) REFERENCES public.schools(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS schools_external_id_unique_idx
  ON public.schools (external_id);

CREATE INDEX IF NOT EXISTS schools_location_idx
  ON public.schools (country, city, name);

CREATE UNIQUE INDEX IF NOT EXISTS school_requests_directory_school_unique_idx
  ON public.school_requests (directory_school_id)
  WHERE directory_school_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.school_directory_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submitted_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  school_type TEXT,
  country TEXT NOT NULL,
  city TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  website TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT school_directory_proposals_status_check
    CHECK (status IN ('pending', 'accepted', 'rejected'))
);

CREATE INDEX IF NOT EXISTS school_directory_proposals_pending_idx
  ON public.school_directory_proposals (created_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS school_directory_proposals_user_idx
  ON public.school_directory_proposals (submitted_by, created_at DESC);

CREATE TABLE IF NOT EXISTS public.school_directory_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  submitted_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL,
  official_email TEXT NOT NULL,
  phone TEXT NOT NULL,
  evidence TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT school_directory_claims_status_check
    CHECK (status IN ('pending', 'accepted', 'rejected'))
);

CREATE UNIQUE INDEX IF NOT EXISTS school_directory_claims_pending_school_idx
  ON public.school_directory_claims (school_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS school_directory_claims_user_idx
  ON public.school_directory_claims (submitted_by, created_at DESC);

ALTER TABLE public.school_students ADD COLUMN IF NOT EXISTS profile_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS school_students_school_profile_unique_idx
  ON public.school_students (school_id, profile_id)
  WHERE profile_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.school_admission_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  applicant_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  student_record_id UUID REFERENCES public.school_students(id) ON DELETE SET NULL,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  current_level TEXT NOT NULL,
  requested_program TEXT NOT NULL,
  motivation TEXT NOT NULL,
  applicant_response TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  decision_message TEXT,
  decided_by UUID,
  decided_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT school_admission_applications_status_check
    CHECK (status IN ('pending', 'info_requested', 'accepted', 'rejected'))
);

CREATE UNIQUE INDEX IF NOT EXISTS school_admission_applications_active_unique_idx
  ON public.school_admission_applications (school_id, applicant_id)
  WHERE status IN ('pending', 'info_requested');

CREATE INDEX IF NOT EXISTS school_admission_applications_school_idx
  ON public.school_admission_applications (school_id, created_at DESC);

CREATE INDEX IF NOT EXISTS school_admission_applications_applicant_idx
  ON public.school_admission_applications (applicant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.school_admission_application_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES public.school_admission_applications(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('applicant', 'school')),
  event_type TEXT NOT NULL,
  message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS school_admission_application_events_history_idx
  ON public.school_admission_application_events (application_id, created_at ASC);

CREATE TABLE IF NOT EXISTS public.school_admission_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES public.school_admission_applications(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS school_admission_notifications_inbox_idx
  ON public.school_admission_notifications (recipient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS school_admission_notifications_unread_idx
  ON public.school_admission_notifications (recipient_id, created_at DESC)
  WHERE is_read = FALSE;
