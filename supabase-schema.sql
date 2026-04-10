-- Run this in your Supabase SQL editor to create the sessions table

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- User input
  ip_address text,
  product text,
  prospect_type text,
  difficulty text,

  -- Call data
  call_id text unique,
  display_name text,
  recording_url text,
  transcript jsonb,
  duration_sec integer,

  -- AI report (full JSON from OpenAI scoring)
  report jsonb,

  -- Costs
  cost_openai_enrich numeric(10,6) default 0,
  cost_openai_report numeric(10,6) default 0,
  cost_retell numeric(10,6) default 0,

  -- Newsletter subscriber info (filled when they unlock report)
  subscriber_name text,
  subscriber_email text,
  subscribed_at timestamptz
);

-- Index for lookups by call_id
create index if not exists idx_sessions_call_id on sessions(call_id);

-- Index for subscriber queries
create index if not exists idx_sessions_subscriber_email on sessions(subscriber_email)
  where subscriber_email is not null;
