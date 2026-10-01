-- =====================================================================
--  הטיולים שלי: מבנה בסיס הנתונים ב-Supabase
--  מריצים פעם אחת ב-SQL Editor. אפשר להריץ שוב בבטחה.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- profiles: שם ומייל של כל משתמש רשום ----------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  full_name  text not null default '',
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_email_lower on public.profiles (lower(email));

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of email on auth.users
  for each row execute function public.handle_new_user();

-- משתמשים שנרשמו לפני שהטריגר נוצר
insert into public.profiles (id, email, full_name)
select id, email, coalesce(raw_user_meta_data->>'full_name', '') from auth.users
on conflict (id) do nothing;

-- ---------- admins: משתמשים עם גישה מלאה לכל הנתונים ----------
-- אין מדיניות RLS על הטבלה, ולכן אי אפשר לקרוא או לשנות אותה מהדפדפן.
-- מוסיפים מנהל רק מ-SQL Editor (ראו supabase/make-admin.sql).
create table if not exists public.admins (
  user_id  uuid primary key references public.profiles(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;

-- ---------- trips: טיול אחד בכל שורה, כל התכנון ב-jsonb ----------
create table if not exists public.trips (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  state      jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists trips_owner on public.trips (owner_id);

-- ---------- trip_members: שיתוף טיול עם משתמשים אחרים ----------
create table if not exists public.trip_members (
  trip_id  uuid not null references public.trips(id) on delete cascade,
  user_id  uuid not null references public.profiles(id) on delete cascade,
  role     text not null default 'editor' check (role in ('editor', 'viewer')),
  added_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);
create index if not exists trip_members_user on public.trip_members (user_id);

-- ---------- journal_entries: יומן הטיול ----------
create table if not exists public.journal_entries (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references public.trips(id) on delete cascade,
  author_id  uuid default auth.uid() references public.profiles(id) on delete set null,
  entry_date date,
  title      text not null default '',
  body       text not null default '',
  place      text not null default '',
  photos     text[] not null default '{}',   -- נתיבים בתוך ה-bucket trip-photos
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists journal_trip on public.journal_entries (trip_id);

-- ---------- updated_at אוטומטי ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trips_touch on public.trips;
create trigger trips_touch before update on public.trips
  for each row execute function public.touch_updated_at();
drop trigger if exists journal_touch on public.journal_entries;
create trigger journal_touch before update on public.journal_entries
  for each row execute function public.touch_updated_at();

-- ---------- פונקציות הרשאה (security definer כדי למנוע רקורסיה ב-RLS) ----------
create or replace function public.is_trip_owner(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (select 1 from trips where id = t and owner_id = auth.uid());
$$;

create or replace function public.can_view_trip(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or exists (select 1 from trips where id = t and owner_id = auth.uid())
      or exists (select 1 from trip_members where trip_id = t and user_id = auth.uid());
$$;

create or replace function public.can_edit_trip(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or exists (select 1 from trips where id = t and owner_id = auth.uid())
      or exists (select 1 from trip_members where trip_id = t and user_id = auth.uid() and role = 'editor');
$$;

create or replace function public.shares_trip_with(p uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (
    select 1 from trips t
    where (t.owner_id = p or exists (select 1 from trip_members m where m.trip_id = t.id and m.user_id = p))
      and (t.owner_id = auth.uid() or exists (select 1 from trip_members m2 where m2.trip_id = t.id and m2.user_id = auth.uid()))
  );
$$;

-- שיתוף לפי מייל: רק מארגן הטיול יכול לקרוא לפונקציה
create or replace function public.share_trip(p_trip uuid, p_email text, p_role text default 'editor')
returns text language plpgsql security definer set search_path = public as $$
declare target uuid;
begin
  if not is_trip_owner(p_trip) then return 'not_owner'; end if;
  if p_role not in ('editor', 'viewer') then p_role := 'editor'; end if;
  select id into target from profiles where lower(email) = lower(trim(p_email));
  if target is null then return 'not_found'; end if;
  if target = auth.uid() then return 'self'; end if;
  insert into trip_members (trip_id, user_id, role) values (p_trip, target, p_role)
  on conflict (trip_id, user_id) do update set role = excluded.role;
  return 'ok';
end $$;

revoke all on function public.share_trip(uuid, text, text) from public, anon;
grant execute on function public.share_trip(uuid, text, text) to authenticated;
grant execute on function public.can_view_trip(uuid), public.can_edit_trip(uuid),
  public.is_trip_owner(uuid), public.shares_trip_with(uuid), public.is_admin() to authenticated;

-- סקירת משתמשים למנהלים בלבד
create or replace function public.admin_users()
returns table (id uuid, email text, full_name text, created_at timestamptz, last_sign_in_at timestamptz,
               trips_owned bigint, trips_shared bigint, journal_entries bigint, is_admin boolean)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select p.id, p.email, p.full_name, p.created_at, u.last_sign_in_at,
      (select count(*) from trips t where t.owner_id = p.id),
      (select count(*) from trip_members m where m.user_id = p.id),
      (select count(*) from journal_entries j where j.author_id = p.id),
      exists (select 1 from admins a where a.user_id = p.id)
    from profiles p left join auth.users u on u.id = p.id
    order by p.created_at desc;
end $$;
revoke all on function public.admin_users() from public, anon;
grant execute on function public.admin_users() to authenticated;

-- ---------- Row Level Security ----------
alter table public.profiles        enable row level security;
alter table public.trips           enable row level security;
alter table public.trip_members    enable row level security;
alter table public.journal_entries enable row level security;

grant select, insert, update, delete on public.trips, public.trip_members, public.journal_entries to authenticated;
grant select, update on public.profiles to authenticated;

drop policy if exists "profiles read"   on public.profiles;
drop policy if exists "profiles update" on public.profiles;
create policy "profiles read"   on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_trip_with(id));
create policy "profiles update" on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());

drop policy if exists "trips read"   on public.trips;
drop policy if exists "trips insert" on public.trips;
drop policy if exists "trips update" on public.trips;
drop policy if exists "trips delete" on public.trips;
create policy "trips read"   on public.trips for select to authenticated using (public.can_view_trip(id));
create policy "trips insert" on public.trips for insert to authenticated with check (owner_id = auth.uid());
create policy "trips update" on public.trips for update to authenticated
  using (public.can_edit_trip(id)) with check (public.can_edit_trip(id));
create policy "trips delete" on public.trips for delete to authenticated using (public.is_trip_owner(id));

drop policy if exists "members read"   on public.trip_members;
drop policy if exists "members delete" on public.trip_members;
drop policy if exists "members update" on public.trip_members;
create policy "members read"   on public.trip_members for select to authenticated using (public.can_view_trip(trip_id));
-- הוספה נעשית רק דרך share_trip. מחיקה: המארגן, או המשתתף עצמו (עזיבה)
create policy "members delete" on public.trip_members for delete to authenticated
  using (public.is_trip_owner(trip_id) or user_id = auth.uid());
create policy "members update" on public.trip_members for update to authenticated
  using (public.is_trip_owner(trip_id)) with check (public.is_trip_owner(trip_id));

drop policy if exists "journal read"   on public.journal_entries;
drop policy if exists "journal insert" on public.journal_entries;
drop policy if exists "journal update" on public.journal_entries;
drop policy if exists "journal delete" on public.journal_entries;
create policy "journal read"   on public.journal_entries for select to authenticated using (public.can_view_trip(trip_id));
create policy "journal insert" on public.journal_entries for insert to authenticated
  with check (public.can_edit_trip(trip_id) and author_id = auth.uid());
create policy "journal update" on public.journal_entries for update to authenticated
  using (public.can_edit_trip(trip_id)) with check (public.can_edit_trip(trip_id));
create policy "journal delete" on public.journal_entries for delete to authenticated using (public.can_edit_trip(trip_id));

-- ---------- Realtime: עדכונים חיים בין משתתפים ----------
do $$
begin
  begin alter publication supabase_realtime add table public.trips;           exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.journal_entries; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.trip_members;    exception when duplicate_object then null; end;
end $$;

-- ---------- Storage: תמונות היומן, bucket פרטי ----------
-- מבנה הנתיב: <trip_id>/<uuid>.jpg
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('trip-photos', 'trip-photos', false, 10485760, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do nothing;

create or replace function public.photo_trip(object_name text)
returns uuid language plpgsql immutable as $$
begin
  return (storage.foldername(object_name))[1]::uuid;
exception when others then
  return null;
end $$;

drop policy if exists "trip photos read"   on storage.objects;
drop policy if exists "trip photos insert" on storage.objects;
drop policy if exists "trip photos delete" on storage.objects;
create policy "trip photos read" on storage.objects for select to authenticated
  using (bucket_id = 'trip-photos' and public.can_view_trip(public.photo_trip(name)));
create policy "trip photos insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'trip-photos' and public.can_edit_trip(public.photo_trip(name)));
create policy "trip photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'trip-photos' and public.can_edit_trip(public.photo_trip(name)));

-- =====================================================================
--  שיתוף פומבי: צפייה בטיול דרך קישור, בלי הרשמה
-- =====================================================================
alter table public.trips add column if not exists is_public      boolean not null default false;
alter table public.trips add column if not exists public_journal boolean not null default false;
alter table public.trips add column if not exists public_budget  boolean not null default false;

-- רק מארגן הטיול (או מנהל) יכול להפוך טיול לפומבי. משתתף עם הרשאת עריכה לא יכול.
create or replace function public.guard_public_flags()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.is_public is distinct from old.is_public
      or new.public_journal is distinct from old.public_journal
      or new.public_budget is distinct from old.public_budget)
     and auth.uid() is not null and not public.is_trip_owner(new.id) then
    raise exception 'only the trip owner can change public sharing' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trips_guard_public on public.trips;
create trigger trips_guard_public before update on public.trips
  for each row execute function public.guard_public_flags();

-- הנתונים שהדף הציבורי מקבל. בלי התקציב (אם לא אושר), בלי הצ׳קליסט ובלי מיילים.
create or replace function public.get_public_trip(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare t trips%rowtype; st jsonb; owner_name text; entries jsonb := '[]'::jsonb;
begin
  select * into t from trips where id = p_id and is_public;
  if not found then return null; end if;

  st := t.state - 'checks';
  if not t.public_budget then
    st := (st - 'items' - 'rates') || jsonb_build_object('items', coalesce((
      select jsonb_agg(jsonb_build_object('cat', 'attr', 'name', e->>'name', 'day', e->'day'))
      from jsonb_array_elements(t.state->'items') e where e->>'cat' = 'attr'), '[]'::jsonb));
  end if;

  select full_name into owner_name from profiles where id = t.owner_id;

  if t.public_journal then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', j.id, 'date', j.entry_date, 'title', j.title, 'text', j.body, 'place', j.place, 'photos', j.photos)
      order by j.entry_date nulls last, j.created_at), '[]'::jsonb)
    into entries from journal_entries j where j.trip_id = t.id;
  end if;

  return jsonb_build_object(
    'id', t.id, 'state', st, 'owner_name', coalesce(owner_name, ''),
    'has_budget', t.public_budget, 'has_journal', t.public_journal,
    'entries', entries, 'updated_at', t.updated_at);
end $$;
revoke all on function public.get_public_trip(uuid) from public;
grant execute on function public.get_public_trip(uuid) to anon, authenticated;

-- תמונות של טיול פומבי שהיומן שלו פתוח לציבור
create or replace function public.public_photos_allowed(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from trips where id = t and is_public and public_journal);
$$;
grant execute on function public.public_photos_allowed(uuid), public.photo_trip(text) to anon, authenticated;

drop policy if exists "public trip photos read" on storage.objects;
create policy "public trip photos read" on storage.objects for select to anon, authenticated
  using (bucket_id = 'trip-photos' and public.public_photos_allowed(public.photo_trip(name)));
