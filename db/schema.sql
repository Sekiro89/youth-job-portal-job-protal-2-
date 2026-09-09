-- Canada Careers — schema (idempotent; applied by scripts/migrate.js)
CREATE EXTENSION IF NOT EXISTS citext;
-- Money is stored in integer cents (CAD). Timestamps are timestamptz (UTC).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('employer','consultant','seeker','admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE job_status AS ENUM ('draft','pending_payment','active','expired','cancelled','inactive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE subscription_status AS ENUM ('pending','active','past_due','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('paid','failed','refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE application_status AS ENUM ('submitted','viewed','shortlisted','rejected','hired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE contact_status AS ENUM ('new','in_progress','resolved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------- users
CREATE TABLE IF NOT EXISTS users (
  id              bigserial PRIMARY KEY,
  email           citext UNIQUE NOT NULL,
  password_hash   text NOT NULL,
  role            user_role NOT NULL,
  name            text NOT NULL,
  phone           text,
  email_verified  boolean NOT NULL DEFAULT false,
  reset_token     text,
  reset_expires   timestamptz,
  is_active       boolean NOT NULL DEFAULT true,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One row per company. An EMPLOYER user owns exactly one; a CONSULTANT user owns many.
CREATE TABLE IF NOT EXISTS employer_profiles (
  id              bigserial PRIMARY KEY,
  owner_user_id   bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_name    text NOT NULL,
  slug            text UNIQUE NOT NULL,
  website         text,
  industry        text,
  company_size    text,
  city            text,
  province        text,          -- 2-letter code, see lib/constants.js PROVINCES
  country         text NOT NULL DEFAULT 'Canada',
  description     text,
  logo_path       text,
  contact_name    text,
  contact_email   text,
  contact_phone   text,
  archived        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS employer_profiles_owner_idx ON employer_profiles(owner_user_id);

-- ---------------------------------------------------------------- jobs
-- PUBLIC VISIBILITY RULE (single source of truth, lib/jobs.js PUBLIC_WHERE):
--   status = 'active' AND expires_at > now()
-- Everything else (draft/pending_payment/expired/cancelled/inactive) is ARCHIVED = never shown publicly.
CREATE TABLE IF NOT EXISTS jobs (
  id                  bigserial PRIMARY KEY,
  employer_profile_id bigint NOT NULL REFERENCES employer_profiles(id) ON DELETE CASCADE,
  created_by          bigint NOT NULL REFERENCES users(id),
  title               text NOT NULL,
  slug                text UNIQUE NOT NULL,
  description         text NOT NULL,           -- plain text with blank-line paragraphs; render with h.paragraphs()
  requirements        text,
  benefits            text,
  category            text NOT NULL,           -- key from lib/constants.js CATEGORIES
  noc_code            text,
  job_type            text NOT NULL,           -- key from JOB_TYPES
  work_arrangement    text NOT NULL DEFAULT 'on_site', -- on_site | remote | hybrid
  experience_level    text,                    -- key from EXPERIENCE_LEVELS
  education           text,
  city                text NOT NULL,
  province            text NOT NULL,
  postal_code         text,
  salary_min          integer,                 -- whole CAD (not cents)
  salary_max          integer,
  salary_period       text NOT NULL DEFAULT 'year',  -- hour | year
  vacancies           integer NOT NULL DEFAULT 1,
  languages           text[] NOT NULL DEFAULT '{English}',
  skills              text[] NOT NULL DEFAULT '{}',
  audiences           text[] NOT NULL DEFAULT '{}',  -- keys from AUDIENCES (professionals,new_immigrants,indigenous,refugees,youth)
  apply_email         text,
  apply_url           text,
  status              job_status NOT NULL DEFAULT 'draft',
  published_at        timestamptz,
  expires_at          timestamptz,             -- = subscription current_period_end while paid
  cancelled_at        timestamptz,
  archived_at         timestamptz,             -- set when status leaves 'active'
  views               integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_public_idx ON jobs(status, expires_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS jobs_profile_idx ON jobs(employer_profile_id);
CREATE INDEX IF NOT EXISTS jobs_category_idx ON jobs(category);
CREATE INDEX IF NOT EXISTS jobs_province_idx ON jobs(province);
CREATE INDEX IF NOT EXISTS jobs_search_idx ON jobs USING gin (to_tsvector('english', title || ' ' || description || ' ' || coalesce(requirements,'')));

-- ---------------------------------------------------------------- billing
-- One subscription per job posting. $9.99 + GST per month, renews until cancelled.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                       bigserial PRIMARY KEY,
  job_id                   bigint UNIQUE NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  employer_profile_id      bigint NOT NULL REFERENCES employer_profiles(id) ON DELETE CASCADE,
  payer_user_id            bigint NOT NULL REFERENCES users(id),
  provider                 text NOT NULL DEFAULT 'sandbox',   -- 'stripe' | 'sandbox'
  provider_customer_id     text,
  provider_subscription_id text,
  provider_checkout_id     text,
  status                   subscription_status NOT NULL DEFAULT 'pending',
  price_cents              integer NOT NULL DEFAULT 999,
  tax_rate                 numeric(5,4) NOT NULL DEFAULT 0.0500,
  tax_cents                integer NOT NULL DEFAULT 50,
  total_cents              integer NOT NULL DEFAULT 1049,
  currency                 text NOT NULL DEFAULT 'CAD',
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  cancel_at_period_end     boolean NOT NULL DEFAULT false,
  cancelled_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_renew_idx ON subscriptions(status, current_period_end);

CREATE TABLE IF NOT EXISTS payments (
  id                   bigserial PRIMARY KEY,
  subscription_id      bigint NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  job_id               bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  payer_user_id        bigint NOT NULL REFERENCES users(id),
  provider             text NOT NULL,
  provider_payment_id  text,
  receipt_number       text UNIQUE,            -- CC-YYYYMM-000001
  amount_cents         integer NOT NULL,
  tax_cents            integer NOT NULL,
  total_cents          integer NOT NULL,
  currency             text NOT NULL DEFAULT 'CAD',
  status               payment_status NOT NULL DEFAULT 'paid',
  period_start         timestamptz NOT NULL,
  period_end           timestamptz NOT NULL,
  paid_at              timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE IF NOT EXISTS receipt_seq;

-- ---------------------------------------------------------------- job seekers
CREATE TABLE IF NOT EXISTS seeker_profiles (
  user_id             bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  headline            text,
  summary             text,
  city                text,
  province            text,
  categories          text[] NOT NULL DEFAULT '{}',
  job_types           text[] NOT NULL DEFAULT '{}',
  work_arrangements   text[] NOT NULL DEFAULT '{}',
  provinces           text[] NOT NULL DEFAULT '{}',   -- where they will work
  keywords            text[] NOT NULL DEFAULT '{}',
  skills              text[] NOT NULL DEFAULT '{}',
  audiences           text[] NOT NULL DEFAULT '{}',
  resume_path         text,                            -- relative to data/uploads
  resume_name         text,
  resume_uploaded_at  timestamptz,
  notify_email        boolean NOT NULL DEFAULT true,
  notify_frequency    text NOT NULL DEFAULT 'instant',  -- instant | daily
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS applications (
  id              bigserial PRIMARY KEY,
  job_id          bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seeker_user_id  bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resume_path     text NOT NULL,
  resume_name     text NOT NULL,
  cover_letter    text,
  status          application_status NOT NULL DEFAULT 'submitted',
  employer_notes  text,
  viewed_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, seeker_user_id)
);
CREATE INDEX IF NOT EXISTS applications_job_idx ON applications(job_id);
CREATE INDEX IF NOT EXISTS applications_seeker_idx ON applications(seeker_user_id);

CREATE TABLE IF NOT EXISTS saved_jobs (
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id     bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, job_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL,          -- new_job_match | application_update | billing | system
  title       text NOT NULL,
  body        text,
  link        text,
  job_id      bigint REFERENCES jobs(id) ON DELETE CASCADE,
  read_at     timestamptz,
  emailed_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, read_at);

-- ---------------------------------------------------------------- contact / support (Veda's inbox)
CREATE TABLE IF NOT EXISTS contact_messages (
  id           bigserial PRIMARY KEY,
  name         text NOT NULL,
  email        text NOT NULL,
  phone        text,
  category     text NOT NULL DEFAULT 'technical',  -- technical | billing | posting | account | general
  subject      text NOT NULL,
  message      text NOT NULL,
  user_id      bigint REFERENCES users(id) ON DELETE SET NULL,
  status       contact_status NOT NULL DEFAULT 'new',
  assigned_to  text NOT NULL DEFAULT 'Veda',
  admin_notes  text,
  resolved_at  timestamptz,
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Every outbound email is recorded here; lib/mail.js sends via SMTP when configured, else status='logged'.
CREATE TABLE IF NOT EXISTS mail_outbox (
  id          bigserial PRIMARY KEY,
  to_email    text NOT NULL,
  subject     text NOT NULL,
  html        text,
  text        text,
  status      text NOT NULL DEFAULT 'queued',   -- queued | sent | failed | logged
  error       text,
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          bigserial PRIMARY KEY,
  user_id     bigint REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity      text,
  entity_id   bigint,
  meta        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value text NOT NULL
);
INSERT INTO settings(key, value) VALUES
  ('posting_price_cents', '999'),
  ('gst_rate', '0.05'),
  ('support_email', 'veda@example.com')
ON CONFLICT (key) DO NOTHING;

-- express-session store (connect-pg-simple)
CREATE TABLE IF NOT EXISTS "session" (
  sid    varchar NOT NULL COLLATE "default" PRIMARY KEY,
  sess   json NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session"(expire);

-- ---------------------------------------------------------------- imported postings (Job Bank etc.) — additive, 2026-09-09
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source text;            -- NULL = posted on Canada Careers; 'jobbank' = imported from jobbank.gc.ca
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_id text;         -- Job Bank posting id
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_url text;        -- canonical URL of the original posting (link back / apply there)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_employer text;   -- employer name as printed at the source
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_synced_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_source_uid ON jobs(source, source_id) WHERE source IS NOT NULL;
ALTER TABLE employer_profiles ADD COLUMN IF NOT EXISTS source text;  -- 'jobbank' for auto-created employer profiles

-- ---------------------------------------------------------------- client feedback 2026-09-09 (Vishal call) — additive
ALTER TABLE employer_profiles ADD COLUMN IF NOT EXISTS operating_name text;     -- trade / "doing business as" name shown to seekers
ALTER TABLE employer_profiles ADD COLUMN IF NOT EXISTS street_address text;
ALTER TABLE employer_profiles ADD COLUMN IF NOT EXISTS postal_code text;

-- One posting may have several work locations (same region). jobs.city/province stay = the PRIMARY location (first row).
CREATE TABLE IF NOT EXISTS job_locations (
  id             bigserial PRIMARY KEY,
  job_id         bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  street_address text,             -- REQUIRED for postings created on Canada Careers (validated in the form); may be NULL for imported reference postings
  unit           text,
  city           text NOT NULL,
  province       text NOT NULL,
  postal_code    text,             -- REQUIRED for native postings; format A1A 1A1
  sort_order     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_locations_job_idx ON job_locations(job_id, sort_order);
CREATE INDEX IF NOT EXISTS job_locations_city_idx ON job_locations(lower(city), province);

-- Backfill: every existing job gets one location row from its city/province (idempotent).
INSERT INTO job_locations(job_id, city, province, sort_order)
SELECT j.id, j.city, j.province, 0 FROM jobs j WHERE NOT EXISTS (SELECT 1 FROM job_locations l WHERE l.job_id = j.id);

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS education_other text;   -- free text when education = 'other'
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS experience_other text;  -- free text when experience_level = 'other'
-- jobs.salary_period now allows: hour | day | week | biweekly | month | year (see lib/constants.js SALARY_PERIODS)

ALTER TABLE applications ADD COLUMN IF NOT EXISTS cover_letter_path text;  -- uploaded cover sheet (pdf/doc/docx), relative to UPLOAD_DIR
ALTER TABLE applications ADD COLUMN IF NOT EXISTS cover_letter_name text;

-- Role-based pricing (cents, before GST). env EMPLOYER_PRICE_CENTS / CONSULTANT_PRICE_CENTS override these.
INSERT INTO settings(key, value) VALUES ('employer_price_cents', '1499'), ('consultant_price_cents', '999') ON CONFLICT (key) DO NOTHING;
UPDATE settings SET value='1499' WHERE key='posting_price_cents' AND value='999';  -- legacy key = employer price
