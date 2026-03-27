-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Users table (managed by Supabase Auth, this is just a reference)
-- The auth.users table is created automatically by Supabase

-- User profiles
create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  preferred_hours jsonb,
  productivity_peak text check (productivity_peak in ('morning', 'afternoon', 'evening')),
  sleep_time text,
  wake_time text,
  autonomy_mode text not null default 'hybrid' check (autonomy_mode in ('suggest', 'auto', 'hybrid')),
  theme text not null default 'dark' check (theme in ('dark', 'light')),
  voice_response_enabled boolean not null default false,
  language text not null default 'en',
  onboarding_completed boolean not null default false,
  occupation text,
  -- Time management methodology
  persona text check (persona in ('student', 'manager', 'entrepreneur', 'developer', 'other')),
  scheduling_method text check (scheduling_method in ('pomodoro', 'deep_work', 'eisenhower', 'gtd', 'time_blocking', 'ivy_lee')),
  secondary_methods text[],
  challenge text check (challenge in ('procrastination', 'overwhelmed', 'focus', 'scattered', 'goals')),
  day_structure text check (day_structure in ('fixed', 'variable', 'mixed', 'independent')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Events
create table if not exists public.events (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text,
  start_time timestamptz not null,
  end_time timestamptz not null,
  is_all_day boolean not null default false,
  color text default '#1a73e8',
  source text not null default 'zman' check (source in ('zman', 'apple_calendar', 'google_calendar')),
  external_id text,
  created_by text not null default 'user' check (created_by in ('user', 'ai')),
  status text not null default 'confirmed' check (status in ('confirmed', 'proposed')),
  mobility_type text default 'ask_first' check (mobility_type in ('fixed', 'flexible', 'ask_first')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Tasks
create table if not exists public.tasks (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text,
  deadline timestamptz,
  estimated_hours numeric,
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'done')),
  parent_task_id uuid references public.tasks(id),
  created_at timestamptz not null default now()
);

-- Conversations
create table if not exists public.conversations (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  messages jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- AI Memory
create table if not exists public.ai_memory (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  value text not null,
  learned_from text not null default 'behavior' check (learned_from in ('onboarding', 'behavior', 'explicit')),
  created_at timestamptz not null default now(),
  unique (user_id, key)
);

-- Indexes
create index if not exists events_user_id_start_time on public.events (user_id, start_time);
create index if not exists tasks_user_id on public.tasks (user_id);
create index if not exists conversations_user_id on public.conversations (user_id);
create index if not exists ai_memory_user_id on public.ai_memory (user_id);

-- Row Level Security
alter table public.user_profiles enable row level security;
alter table public.events enable row level security;
alter table public.tasks enable row level security;
alter table public.conversations enable row level security;
alter table public.ai_memory enable row level security;

-- RLS Policies
create policy "Users can manage their own profile"
  on public.user_profiles for all using (auth.uid() = user_id);

create policy "Users can manage their own events"
  on public.events for all using (auth.uid() = user_id);

create policy "Users can manage their own tasks"
  on public.tasks for all using (auth.uid() = user_id);

create policy "Users can manage their own conversations"
  on public.conversations for all using (auth.uid() = user_id);

create policy "Users can manage their own ai memory"
  on public.ai_memory for all using (auth.uid() = user_id);

-- Updated_at trigger
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger user_profiles_updated_at before update on public.user_profiles
  for each row execute function update_updated_at();

create trigger events_updated_at before update on public.events
  for each row execute function update_updated_at();

create trigger conversations_updated_at before update on public.conversations
  for each row execute function update_updated_at();
