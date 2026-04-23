-- Supabase schema and RLS for role-based chat PWA
-- Run this file in Supabase SQL Editor.

create extension if not exists pgcrypto;

-- =========================================
-- Tables
-- =========================================

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique,
  username text,
  full_name text,
  avatar_url text,
  role text not null default 'user' check (role in ('super_admin', 'admin', 'user')),
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.admins (
  id uuid primary key references public.profiles(id) on delete cascade,
  company_name text,
  unique_slug text unique not null,
  remark text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.subscription_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  amount numeric(10,2) not null default 0,
  duration_days int,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.admin_subscriptions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.admins(id) on delete cascade,
  plan_id uuid not null references public.subscription_plans(id),
  start_date date not null,
  end_date date,
  grace_days int not null default 0,
  status text not null check (status in ('active', 'expired', 'grace')),
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  account_details text,
  instructions text,
  is_active boolean not null default true
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.admins(id) on delete cascade,
  method_id uuid references public.payment_methods(id),
  amount numeric(10,2) not null,
  transaction_id text,
  screenshot_url text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  submitted_at timestamptz not null default timezone('utc', now()),
  reviewed_by uuid references public.profiles(id)
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  admin_id uuid not null references public.admins(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique(user_id, admin_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  content text,
  message_type text not null default 'text' check (message_type in ('text', 'image', 'voice', 'link')),
  media_url text,
  is_read boolean not null default false,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.direct_conversations (
  id uuid primary key default gen_random_uuid(),
  member_a uuid not null references public.profiles(id) on delete cascade,
  member_b uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (member_a <> member_b),
  check (member_a < member_b),
  unique(member_a, member_b)
);

create table if not exists public.direct_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.direct_conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  content text,
  message_type text not null default 'text' check (message_type in ('text', 'image', 'voice', 'link')),
  media_url text,
  is_read boolean not null default false,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.support_conversations (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.admins(id) on delete cascade,
  super_admin_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique(admin_id, super_admin_id)
);

create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.support_conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  content text,
  message_type text not null default 'text' check (message_type in ('text', 'image', 'voice', 'link')),
  media_url text,
  is_read boolean not null default false,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.bulk_messages (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.admins(id) on delete cascade,
  content text,
  media_url text,
  message_type text not null default 'text' check (message_type in ('text', 'image', 'voice', 'link')),
  sent_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.bulk_message_recipients (
  bulk_message_id uuid not null references public.bulk_messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  delivered boolean not null default false,
  primary key (bulk_message_id, user_id)
);

create index if not exists idx_conversations_admin_updated on public.conversations(admin_id, updated_at desc);
create index if not exists idx_conversations_user_updated on public.conversations(user_id, updated_at desc);
create index if not exists idx_messages_conversation_created on public.messages(conversation_id, created_at);
create index if not exists idx_direct_conversations_member_a_updated on public.direct_conversations(member_a, updated_at desc);
create index if not exists idx_direct_conversations_member_b_updated on public.direct_conversations(member_b, updated_at desc);
create index if not exists idx_direct_messages_conversation_created on public.direct_messages(conversation_id, created_at);
create index if not exists idx_support_messages_conversation_created on public.support_messages(conversation_id, created_at);
create index if not exists idx_payments_admin_submitted on public.payments(admin_id, submitted_at desc);
create index if not exists idx_admin_subscriptions_admin_created on public.admin_subscriptions(admin_id, created_at desc);
create index if not exists idx_admins_unique_slug on public.admins(unique_slug);

alter table public.profiles add column if not exists username text;

with prepared as (
  select
    p.id,
    lower(
      regexp_replace(
        coalesce(nullif(split_part(p.email, '@', 1), ''), 'user_' || substr(p.id::text, 1, 8)),
        '[^a-z0-9._-]',
        '',
        'g'
      )
    ) as base_username
  from public.profiles p
  where p.username is null
),
resolved as (
  select
    prepared.id,
    case
      when prepared.base_username is null or prepared.base_username = '' then 'user_' || substr(prepared.id::text, 1, 8)
      when count(*) over (partition by prepared.base_username) = 1 then prepared.base_username
      else prepared.base_username || '_' || substr(prepared.id::text, 1, 6)
    end as final_username
  from prepared
)
update public.profiles p
set username = resolved.final_username
from resolved
where p.id = resolved.id
  and p.username is null;

create unique index if not exists idx_profiles_username_unique on public.profiles(username) where username is not null;

-- =========================================
-- Helper functions and triggers
-- =========================================

create or replace function public.current_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select p.role from public.profiles p where p.id = auth.uid()), 'user');
$$;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_role() = 'super_admin';
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

create or replace function public.touch_conversation_from_message()
returns trigger
language plpgsql
as $$
begin
  update public.conversations
  set updated_at = timezone('utc', now())
  where id = new.conversation_id;
  return new;
end;
$$;

create or replace function public.touch_support_conversation_from_message()
returns trigger
language plpgsql
as $$
begin
  update public.support_conversations
  set updated_at = timezone('utc', now())
  where id = new.conversation_id;
  return new;
end;
$$;

create or replace function public.touch_direct_conversation_from_message()
returns trigger
language plpgsql
as $$
begin
  update public.direct_conversations
  set updated_at = timezone('utc', now())
  where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists trg_touch_conversations_updated_at on public.conversations;
create trigger trg_touch_conversations_updated_at
before update on public.conversations
for each row
execute function public.touch_updated_at();

drop trigger if exists trg_touch_support_conversations_updated_at on public.support_conversations;
create trigger trg_touch_support_conversations_updated_at
before update on public.support_conversations
for each row
execute function public.touch_updated_at();

drop trigger if exists trg_touch_conversation_from_message on public.messages;
create trigger trg_touch_conversation_from_message
after insert on public.messages
for each row
execute function public.touch_conversation_from_message();

drop trigger if exists trg_touch_direct_conversations_updated_at on public.direct_conversations;
create trigger trg_touch_direct_conversations_updated_at
before update on public.direct_conversations
for each row
execute function public.touch_updated_at();

drop trigger if exists trg_touch_direct_conversation_from_message on public.direct_messages;
create trigger trg_touch_direct_conversation_from_message
after insert on public.direct_messages
for each row
execute function public.touch_direct_conversation_from_message();

drop trigger if exists trg_touch_support_conversation_from_message on public.support_messages;
create trigger trg_touch_support_conversation_from_message
after insert on public.support_messages
for each row
execute function public.touch_support_conversation_from_message();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
begin
  v_username := lower(
    regexp_replace(
      coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1)),
      '[^a-z0-9._-]',
      '',
      'g'
    )
  );

  if v_username is null or v_username = '' then
    v_username := 'user_' || substr(new.id::text, 1, 8);
  end if;

  if exists(select 1 from public.profiles p where p.username = v_username and p.id <> new.id) then
    v_username := v_username || '_' || substr(new.id::text, 1, 6);
  end if;

  insert into public.profiles (id, email, username, full_name, avatar_url, role)
  values (
    new.id,
    new.email,
    v_username,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data ->> 'avatar_url',
    'user'
  )
  on conflict (id) do update
  set email = excluded.email,
      username = coalesce(public.profiles.username, excluded.username);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();

create or replace function public.register_self_as_admin(
  p_company_name text,
  p_unique_slug text,
  p_remark text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_slug text := lower(trim(p_unique_slug));
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if v_slug is null or v_slug = '' then
    raise exception 'Unique slug is required';
  end if;

  if v_slug !~ '^[a-z0-9-]+$' then
    raise exception 'Slug must contain only lowercase letters, numbers, and hyphens';
  end if;

  if exists(select 1 from public.admins a where a.unique_slug = v_slug and a.id <> v_uid) then
    raise exception 'Slug already in use';
  end if;

  update public.profiles
  set role = 'admin'
  where id = v_uid
    and role <> 'super_admin';

  insert into public.admins (id, company_name, unique_slug, remark, created_by)
  values (v_uid, p_company_name, v_slug, p_remark, v_uid)
  on conflict (id) do update
  set company_name = excluded.company_name,
      unique_slug = excluded.unique_slug,
      remark = excluded.remark;

  return v_uid;
end;
$$;

create or replace function public.get_or_create_user_conversation(p_admin_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_conversation_id uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.conversations (user_id, admin_id)
  values (v_uid, p_admin_id)
  on conflict (user_id, admin_id) do update
  set updated_at = timezone('utc', now())
  returning id into v_conversation_id;

  return v_conversation_id;
end;
$$;

create or replace function public.get_or_create_direct_conversation(p_target_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_a uuid;
  v_b uuid;
  v_conversation_id uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if p_target_user_id is null then
    raise exception 'Target user is required';
  end if;

  if p_target_user_id = v_uid then
    raise exception 'Cannot create conversation with yourself';
  end if;

  if not exists(select 1 from public.profiles p where p.id = p_target_user_id) then
    raise exception 'Target user not found';
  end if;

  v_a := least(v_uid, p_target_user_id);
  v_b := greatest(v_uid, p_target_user_id);

  insert into public.direct_conversations (member_a, member_b)
  values (v_a, v_b)
  on conflict (member_a, member_b) do update
  set updated_at = timezone('utc', now())
  returning id into v_conversation_id;

  return v_conversation_id;
end;
$$;

create or replace function public.get_or_create_support_conversation(p_super_admin_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_target_super_admin uuid;
  v_conversation_id uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if public.current_role() <> 'admin' then
    raise exception 'Only admins can open support conversations';
  end if;

  if p_super_admin_id is not null then
    v_target_super_admin := p_super_admin_id;
  else
    select p.id into v_target_super_admin
    from public.profiles p
    where p.role = 'super_admin'
    order by p.created_at
    limit 1;
  end if;

  if v_target_super_admin is null then
    raise exception 'No super admin found';
  end if;

  insert into public.support_conversations (admin_id, super_admin_id)
  values (v_uid, v_target_super_admin)
  on conflict (admin_id, super_admin_id) do update
  set updated_at = timezone('utc', now())
  returning id into v_conversation_id;

  return v_conversation_id;
end;
$$;

create or replace function public.admin_daily_message_counts(p_days int default 7)
returns table (
  admin_id uuid,
  admin_name text,
  day date,
  message_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'Only super admins can access this report';
  end if;

  return query
  select
    c.admin_id,
    coalesce(p.full_name, p.email) as admin_name,
    (m.created_at at time zone 'utc')::date as day,
    count(*)::bigint as message_count
  from public.messages m
  join public.conversations c on c.id = m.conversation_id
  join public.profiles p on p.id = c.admin_id
  where m.created_at >= timezone('utc', now()) - make_interval(days => greatest(p_days, 1))
  group by c.admin_id, admin_name, day
  order by day asc, admin_name asc;
end;
$$;

-- =========================================
-- Storage buckets
-- =========================================

insert into storage.buckets (id, name, public)
values
  ('avatars', 'avatars', true),
  ('chat-media', 'chat-media', true)
on conflict (id) do nothing;

-- =========================================
-- Row Level Security
-- =========================================

alter table public.profiles enable row level security;
alter table public.admins enable row level security;
alter table public.subscription_plans enable row level security;
alter table public.admin_subscriptions enable row level security;
alter table public.payment_methods enable row level security;
alter table public.payments enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.direct_conversations enable row level security;
alter table public.direct_messages enable row level security;
alter table public.support_conversations enable row level security;
alter table public.support_messages enable row level security;
alter table public.bulk_messages enable row level security;
alter table public.bulk_message_recipients enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
for select
using (auth.role() = 'authenticated');

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
for insert
with check (id = auth.uid() or public.is_super_admin());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
for update
using (id = auth.uid() or public.is_super_admin())
with check (id = auth.uid() or public.is_super_admin());

drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles
for delete
using (public.is_super_admin());

drop policy if exists admins_select on public.admins;
create policy admins_select on public.admins
for select
using (auth.role() = 'authenticated');

drop policy if exists admins_insert on public.admins;
create policy admins_insert on public.admins
for insert
with check (
  public.is_super_admin()
  or (id = auth.uid() and public.current_role() = 'admin')
);

drop policy if exists admins_update on public.admins;
create policy admins_update on public.admins
for update
using (
  public.is_super_admin()
  or (id = auth.uid() and public.current_role() = 'admin')
)
with check (
  public.is_super_admin()
  or (id = auth.uid() and public.current_role() = 'admin')
);

drop policy if exists admins_delete on public.admins;
create policy admins_delete on public.admins
for delete
using (public.is_super_admin());

drop policy if exists subscription_plans_select on public.subscription_plans;
create policy subscription_plans_select on public.subscription_plans
for select
using (auth.role() = 'authenticated');

drop policy if exists subscription_plans_modify on public.subscription_plans;
create policy subscription_plans_modify on public.subscription_plans
for all
using (public.is_super_admin())
with check (public.is_super_admin());

drop policy if exists admin_subscriptions_select on public.admin_subscriptions;
create policy admin_subscriptions_select on public.admin_subscriptions
for select
using (public.is_super_admin() or admin_id = auth.uid());

drop policy if exists admin_subscriptions_modify on public.admin_subscriptions;
create policy admin_subscriptions_modify on public.admin_subscriptions
for all
using (public.is_super_admin())
with check (public.is_super_admin());

drop policy if exists payment_methods_select on public.payment_methods;
create policy payment_methods_select on public.payment_methods
for select
using (auth.role() = 'authenticated');

drop policy if exists payment_methods_modify on public.payment_methods;
create policy payment_methods_modify on public.payment_methods
for all
using (public.is_super_admin())
with check (public.is_super_admin());

drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments
for select
using (public.is_super_admin() or admin_id = auth.uid());

drop policy if exists payments_insert on public.payments;
create policy payments_insert on public.payments
for insert
with check (
  public.is_super_admin()
  or (
    admin_id = auth.uid()
    and public.current_role() = 'admin'
    and status = 'pending'
  )
);

drop policy if exists payments_update on public.payments;
create policy payments_update on public.payments
for update
using (public.is_super_admin())
with check (public.is_super_admin());

drop policy if exists payments_delete on public.payments;
create policy payments_delete on public.payments
for delete
using (public.is_super_admin());

drop policy if exists conversations_select on public.conversations;
create policy conversations_select on public.conversations
for select
using (
  public.is_super_admin()
  or user_id = auth.uid()
  or admin_id = auth.uid()
);

drop policy if exists conversations_insert on public.conversations;
create policy conversations_insert on public.conversations
for insert
with check (
  public.is_super_admin()
  or (user_id = auth.uid() and public.current_role() = 'user')
  or (admin_id = auth.uid() and public.current_role() = 'admin')
);

drop policy if exists conversations_update on public.conversations;
create policy conversations_update on public.conversations
for update
using (
  public.is_super_admin()
  or user_id = auth.uid()
  or admin_id = auth.uid()
)
with check (
  public.is_super_admin()
  or user_id = auth.uid()
  or admin_id = auth.uid()
);

drop policy if exists conversations_delete on public.conversations;
create policy conversations_delete on public.conversations
for delete
using (public.is_super_admin());

drop policy if exists direct_conversations_select on public.direct_conversations;
create policy direct_conversations_select on public.direct_conversations
for select
using (
  public.is_super_admin()
  or member_a = auth.uid()
  or member_b = auth.uid()
);

drop policy if exists direct_conversations_insert on public.direct_conversations;
create policy direct_conversations_insert on public.direct_conversations
for insert
with check (
  public.is_super_admin()
  or (
    (member_a = auth.uid() or member_b = auth.uid())
    and member_a < member_b
  )
);

drop policy if exists direct_conversations_update on public.direct_conversations;
create policy direct_conversations_update on public.direct_conversations
for update
using (
  public.is_super_admin()
  or member_a = auth.uid()
  or member_b = auth.uid()
)
with check (
  public.is_super_admin()
  or member_a = auth.uid()
  or member_b = auth.uid()
);

drop policy if exists direct_conversations_delete on public.direct_conversations;
create policy direct_conversations_delete on public.direct_conversations
for delete
using (
  public.is_super_admin()
  or member_a = auth.uid()
  or member_b = auth.uid()
);

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages
for select
using (
  public.is_super_admin()
  or exists (
    select 1
    from public.conversations c
    where c.id = messages.conversation_id
      and (c.user_id = auth.uid() or c.admin_id = auth.uid())
  )
);

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
for insert
with check (
  sender_id = auth.uid()
  and (
    public.is_super_admin()
    or exists (
      select 1
      from public.conversations c
      where c.id = messages.conversation_id
        and (c.user_id = auth.uid() or c.admin_id = auth.uid())
    )
  )
);

drop policy if exists messages_update on public.messages;
create policy messages_update on public.messages
for update
using (
  public.is_super_admin()
  or exists (
    select 1
    from public.conversations c
    where c.id = messages.conversation_id
      and (c.user_id = auth.uid() or c.admin_id = auth.uid())
  )
)
with check (
  public.is_super_admin()
  or exists (
    select 1
    from public.conversations c
    where c.id = messages.conversation_id
      and (c.user_id = auth.uid() or c.admin_id = auth.uid())
  )
);

drop policy if exists direct_messages_select on public.direct_messages;
create policy direct_messages_select on public.direct_messages
for select
using (
  public.is_super_admin()
  or exists (
    select 1
    from public.direct_conversations dc
    where dc.id = direct_messages.conversation_id
      and (dc.member_a = auth.uid() or dc.member_b = auth.uid())
  )
);

drop policy if exists direct_messages_insert on public.direct_messages;
create policy direct_messages_insert on public.direct_messages
for insert
with check (
  sender_id = auth.uid()
  and (
    public.is_super_admin()
    or exists (
      select 1
      from public.direct_conversations dc
      where dc.id = direct_messages.conversation_id
        and (dc.member_a = auth.uid() or dc.member_b = auth.uid())
    )
  )
);

drop policy if exists direct_messages_update on public.direct_messages;
create policy direct_messages_update on public.direct_messages
for update
using (
  public.is_super_admin()
  or exists (
    select 1
    from public.direct_conversations dc
    where dc.id = direct_messages.conversation_id
      and (dc.member_a = auth.uid() or dc.member_b = auth.uid())
  )
)
with check (
  public.is_super_admin()
  or exists (
    select 1
    from public.direct_conversations dc
    where dc.id = direct_messages.conversation_id
      and (dc.member_a = auth.uid() or dc.member_b = auth.uid())
  )
);

drop policy if exists support_conversations_select on public.support_conversations;
create policy support_conversations_select on public.support_conversations
for select
using (
  public.is_super_admin()
  or admin_id = auth.uid()
  or super_admin_id = auth.uid()
);

drop policy if exists support_conversations_insert on public.support_conversations;
create policy support_conversations_insert on public.support_conversations
for insert
with check (
  public.is_super_admin()
  or (admin_id = auth.uid() and public.current_role() = 'admin')
);

drop policy if exists support_conversations_update on public.support_conversations;
create policy support_conversations_update on public.support_conversations
for update
using (
  public.is_super_admin()
  or admin_id = auth.uid()
  or super_admin_id = auth.uid()
)
with check (
  public.is_super_admin()
  or admin_id = auth.uid()
  or super_admin_id = auth.uid()
);

drop policy if exists support_conversations_delete on public.support_conversations;
create policy support_conversations_delete on public.support_conversations
for delete
using (public.is_super_admin());

drop policy if exists support_messages_select on public.support_messages;
create policy support_messages_select on public.support_messages
for select
using (
  public.is_super_admin()
  or exists (
    select 1
    from public.support_conversations sc
    where sc.id = support_messages.conversation_id
      and (sc.admin_id = auth.uid() or sc.super_admin_id = auth.uid())
  )
);

drop policy if exists support_messages_insert on public.support_messages;
create policy support_messages_insert on public.support_messages
for insert
with check (
  sender_id = auth.uid()
  and (
    public.is_super_admin()
    or exists (
      select 1
      from public.support_conversations sc
      where sc.id = support_messages.conversation_id
        and (sc.admin_id = auth.uid() or sc.super_admin_id = auth.uid())
    )
  )
);

drop policy if exists support_messages_update on public.support_messages;
create policy support_messages_update on public.support_messages
for update
using (
  public.is_super_admin()
  or exists (
    select 1
    from public.support_conversations sc
    where sc.id = support_messages.conversation_id
      and (sc.admin_id = auth.uid() or sc.super_admin_id = auth.uid())
  )
)
with check (
  public.is_super_admin()
  or exists (
    select 1
    from public.support_conversations sc
    where sc.id = support_messages.conversation_id
      and (sc.admin_id = auth.uid() or sc.super_admin_id = auth.uid())
  )
);

drop policy if exists bulk_messages_select on public.bulk_messages;
create policy bulk_messages_select on public.bulk_messages
for select
using (public.is_super_admin() or admin_id = auth.uid());

drop policy if exists bulk_messages_insert on public.bulk_messages;
create policy bulk_messages_insert on public.bulk_messages
for insert
with check (
  public.is_super_admin()
  or (admin_id = auth.uid() and public.current_role() = 'admin')
);

drop policy if exists bulk_messages_update on public.bulk_messages;
create policy bulk_messages_update on public.bulk_messages
for update
using (public.is_super_admin() or admin_id = auth.uid())
with check (public.is_super_admin() or admin_id = auth.uid());

drop policy if exists bulk_messages_delete on public.bulk_messages;
create policy bulk_messages_delete on public.bulk_messages
for delete
using (public.is_super_admin() or admin_id = auth.uid());

drop policy if exists bulk_message_recipients_select on public.bulk_message_recipients;
create policy bulk_message_recipients_select on public.bulk_message_recipients
for select
using (
  public.is_super_admin()
  or exists (
    select 1
    from public.bulk_messages bm
    where bm.id = bulk_message_recipients.bulk_message_id
      and bm.admin_id = auth.uid()
  )
  or user_id = auth.uid()
);

drop policy if exists bulk_message_recipients_insert on public.bulk_message_recipients;
create policy bulk_message_recipients_insert on public.bulk_message_recipients
for insert
with check (
  public.is_super_admin()
  or exists (
    select 1
    from public.bulk_messages bm
    where bm.id = bulk_message_recipients.bulk_message_id
      and bm.admin_id = auth.uid()
  )
);

drop policy if exists bulk_message_recipients_update on public.bulk_message_recipients;
create policy bulk_message_recipients_update on public.bulk_message_recipients
for update
using (
  public.is_super_admin()
  or exists (
    select 1
    from public.bulk_messages bm
    where bm.id = bulk_message_recipients.bulk_message_id
      and bm.admin_id = auth.uid()
  )
)
with check (
  public.is_super_admin()
  or exists (
    select 1
    from public.bulk_messages bm
    where bm.id = bulk_message_recipients.bulk_message_id
      and bm.admin_id = auth.uid()
  )
);

drop policy if exists bulk_message_recipients_delete on public.bulk_message_recipients;
create policy bulk_message_recipients_delete on public.bulk_message_recipients
for delete
using (
  public.is_super_admin()
  or exists (
    select 1
    from public.bulk_messages bm
    where bm.id = bulk_message_recipients.bulk_message_id
      and bm.admin_id = auth.uid()
  )
);

-- Storage object policies
-- RLS on storage.objects is managed by Supabase and is already enabled.
-- Do not run ALTER TABLE here, because some projects may return:
-- "must be owner of table objects".

drop policy if exists avatars_public_read on storage.objects;
create policy avatars_public_read on storage.objects
for select
using (bucket_id = 'avatars');

drop policy if exists avatars_owner_write on storage.objects;
create policy avatars_owner_write on storage.objects
for insert
with check (
  bucket_id = 'avatars'
  and auth.role() = 'authenticated'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists avatars_owner_update on storage.objects;
create policy avatars_owner_update on storage.objects
for update
using (
  bucket_id = 'avatars'
  and auth.role() = 'authenticated'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'avatars'
  and auth.role() = 'authenticated'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists avatars_owner_delete on storage.objects;
create policy avatars_owner_delete on storage.objects
for delete
using (
  bucket_id = 'avatars'
  and auth.role() = 'authenticated'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists chat_media_public_read on storage.objects;
create policy chat_media_public_read on storage.objects
for select
using (bucket_id = 'chat-media');

drop policy if exists chat_media_authenticated_write on storage.objects;
create policy chat_media_authenticated_write on storage.objects
for insert
with check (bucket_id = 'chat-media' and auth.role() = 'authenticated');

drop policy if exists chat_media_owner_update on storage.objects;
create policy chat_media_owner_update on storage.objects
for update
using (
  bucket_id = 'chat-media'
  and auth.role() = 'authenticated'
  and owner = auth.uid()
)
with check (
  bucket_id = 'chat-media'
  and auth.role() = 'authenticated'
  and owner = auth.uid()
);

drop policy if exists chat_media_owner_delete on storage.objects;
create policy chat_media_owner_delete on storage.objects
for delete
using (
  bucket_id = 'chat-media'
  and auth.role() = 'authenticated'
  and owner = auth.uid()
);

-- =========================================
-- Web Push Subscriptions
-- =========================================

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text,
  auth text,
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_push_subscriptions_user_id on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists push_subscriptions_select on public.push_subscriptions;
create policy push_subscriptions_select on public.push_subscriptions
for select
using (user_id = auth.uid() or public.is_super_admin());

drop policy if exists push_subscriptions_insert on public.push_subscriptions;
create policy push_subscriptions_insert on public.push_subscriptions
for insert
with check (user_id = auth.uid());

drop policy if exists push_subscriptions_update on public.push_subscriptions;
create policy push_subscriptions_update on public.push_subscriptions
for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists push_subscriptions_delete on public.push_subscriptions;
create policy push_subscriptions_delete on public.push_subscriptions
for delete
using (user_id = auth.uid() or public.is_super_admin());
