-- Base de données de l'app coloc (Supabase / PostgreSQL).
-- À coller en entier dans Supabase → SQL Editor → Run. Peut être relancé sans risque.
--
-- Les tables sont fermées au public : la page passe uniquement par les fonctions ci-dessous,
-- qui vérifient toutes le code de la coloc avant de lire ou modifier quoi que ce soit.

-- ---------- Tables ----------

create table if not exists people (
  id bigint generated always as identity primary key,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists shopping (
  id bigint generated always as identity primary key,
  name text not null,
  qty text,
  added_by bigint references people(id) on delete set null,
  bought_by bigint references people(id) on delete set null,
  bought_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists tasks (
  id bigint generated always as identity primary key,
  title text not null,
  assignee_id bigint references people(id) on delete set null,
  recurrence text not null default 'none'
    check (recurrence in ('none', 'daily', 'weekly', 'biweekly', 'monthly')),
  rotate boolean not null default true,
  due_date date,
  done boolean not null default false,
  last_done_by bigint references people(id) on delete set null,
  last_done_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists settings (
  key text primary key,
  value text
);

-- Une seule ligne : l'empreinte (sha256) du code de la coloc.
create table if not exists coloc_config (
  id int primary key default 1 check (id = 1),
  code_hash text not null
);

alter table people enable row level security;
alter table shopping enable row level security;
alter table tasks enable row level security;
alter table settings enable row level security;
alter table coloc_config enable row level security;
revoke all on people, shopping, tasks, settings, coloc_config from anon, authenticated;

-- ---------- Outils internes ----------

create or replace function _check(p_code text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_code is null or not exists (
    select 1 from coloc_config where code_hash = encode(sha256(convert_to(p_code, 'UTF8')), 'hex')
  ) then
    raise exception 'CODE_INVALIDE';
  end if;
end $$;

create or replace function _text(p text, max_len int, label text) returns text
language plpgsql immutable as $$
declare
  t text := btrim(coalesce(p, ''));
begin
  if t = '' then raise exception '% est requis', label; end if;
  if char_length(t) > max_len then raise exception '% est trop long (max %)', label, max_len; end if;
  return t;
end $$;

create or replace function _today() returns date
language sql stable as $$ select (now() at time zone 'Europe/Zurich')::date $$;

-- Prochain coloc actif après p_current (ordre d'arrivée), en boucle.
create or replace function _next_assignee(p_current bigint) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select id from people where active and id > coalesce(p_current, 0) order by id limit 1),
    (select id from people where active order by id limit 1)
  )
$$;

-- Choisir ou changer le code de la coloc (uniquement depuis le SQL Editor).
create or replace function _set_code(p_new_code text) returns void
language sql security definer set search_path = public as $$
  insert into coloc_config (id, code_hash)
  values (1, encode(sha256(convert_to(p_new_code, 'UTF8')), 'hex'))
  on conflict (id) do update set code_hash = excluded.code_hash
$$;

revoke execute on function _check(text), _text(text, int, text), _today(), _next_assignee(bigint), _set_code(text)
  from public, anon, authenticated;

-- ---------- Fonctions appelées par la page ----------

create or replace function check_code(p_code text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform _check(p_code);
  return true;
end $$;

create or replace function get_state(p_code text) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform _check(p_code);
  return json_build_object(
    'people',   coalesce((select json_agg(p order by p.id) from people p), '[]'),
    'shopping', coalesce((select json_agg(s order by s.created_at desc, s.id desc) from shopping s), '[]'),
    'tasks',    coalesce((select json_agg(t order by t.id) from tasks t), '[]'),
    'settings', coalesce((select json_object_agg(key, value) from settings), '{}')
  );
end $$;

-- Colocs

create or replace function add_person(p_code text, p_name text) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  new_id bigint;
begin
  perform _check(p_code);
  insert into people (name) values (_text(p_name, 40, 'Le nom')) returning id into new_id;
  return new_id;
end $$;

create or replace function rename_person(p_code text, p_id bigint, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _check(p_code);
  update people set name = _text(p_name, 40, 'Le nom') where id = p_id;
end $$;

create or replace function set_person_active(p_code text, p_id bigint, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  was_active boolean;
begin
  perform _check(p_code);
  select active into was_active from people where id = p_id;
  if not found then raise exception 'Coloc introuvable'; end if;
  update people set active = p_active where id = p_id;
  if was_active and not p_active then
    -- Le coloc part : ses tâches récurrentes passent au suivant, les autres deviennent non assignées.
    update tasks
       set assignee_id = case when recurrence <> 'none' and rotate then _next_assignee(p_id) else null end
     where assignee_id = p_id and not done;
  end if;
end $$;

create or replace function delete_person(p_code text, p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _check(p_code);
  if exists (select 1 from people where id = p_id and active) then
    raise exception 'Marque d''abord ce coloc comme parti';
  end if;
  delete from people where id = p_id;
end $$;

-- Courses

create or replace function add_item(p_code text, p_name text, p_qty text, p_added_by bigint) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  new_id bigint;
  q text := nullif(btrim(coalesce(p_qty, '')), '');
begin
  perform _check(p_code);
  if char_length(q) > 30 then raise exception 'La quantité est trop longue (max 30)'; end if;
  insert into shopping (name, qty, added_by)
  values (_text(p_name, 100, 'L''article'), q, p_added_by)
  returning id into new_id;
  return new_id;
end $$;

create or replace function set_item_bought(p_code text, p_id bigint, p_bought boolean, p_by bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _check(p_code);
  if p_bought then
    update shopping set bought_by = p_by, bought_at = now() where id = p_id;
  else
    update shopping set bought_by = null, bought_at = null where id = p_id;
  end if;
end $$;

create or replace function delete_item(p_code text, p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _check(p_code);
  delete from shopping where id = p_id;
end $$;

create or replace function clear_bought(p_code text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _check(p_code);
  delete from shopping where bought_at is not null;
end $$;

-- Tâches

create or replace function save_task(
  p_code text, p_id bigint, p_title text, p_assignee_id bigint,
  p_recurrence text, p_rotate boolean, p_due_date date
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  t text := _text(p_title, 120, 'Le titre');
  rec text := coalesce(p_recurrence, 'none');
  due date := p_due_date;
  new_id bigint;
begin
  perform _check(p_code);
  if rec not in ('none', 'daily', 'weekly', 'biweekly', 'monthly') then raise exception 'Récurrence invalide'; end if;
  if rec <> 'none' and due is null then due := _today(); end if;
  if p_id is null then
    insert into tasks (title, assignee_id, recurrence, rotate, due_date)
    values (t, p_assignee_id, rec, coalesce(p_rotate, true), due)
    returning id into new_id;
    return new_id;
  end if;
  update tasks
     set title = t, assignee_id = p_assignee_id, recurrence = rec, rotate = coalesce(p_rotate, true), due_date = due
   where id = p_id;
  return p_id;
end $$;

create or replace function complete_task(p_code text, p_id bigint, p_by bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  t tasks;
  base date;
begin
  perform _check(p_code);
  select * into t from tasks where id = p_id;
  if not found then raise exception 'Tâche introuvable'; end if;
  if t.recurrence = 'none' then
    update tasks set done = true, last_done_by = p_by, last_done_at = now() where id = p_id;
    return;
  end if;
  -- Tâche récurrente : on avance l'échéance et on passe au coloc suivant.
  base := greatest(coalesce(t.due_date, _today()), _today());
  update tasks
     set due_date = case t.recurrence
                      when 'daily' then base + 1
                      when 'weekly' then base + 7
                      when 'biweekly' then base + 14
                      else (base + interval '1 month')::date
                    end,
         assignee_id = case when t.rotate then _next_assignee(coalesce(t.assignee_id, p_by)) else t.assignee_id end,
         last_done_by = p_by,
         last_done_at = now()
   where id = p_id;
end $$;

create or replace function reopen_task(p_code text, p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _check(p_code);
  update tasks set done = false where id = p_id;
end $$;

create or replace function delete_task(p_code text, p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _check(p_code);
  delete from tasks where id = p_id;
end $$;

create or replace function clear_done(p_code text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _check(p_code);
  delete from tasks where done;
end $$;

-- Réglages

create or replace function set_tricount_url(p_code text, p_url text) returns void
language plpgsql security definer set search_path = public as $$
declare
  u text := nullif(btrim(coalesce(p_url, '')), '');
begin
  perform _check(p_code);
  if u is not null and (char_length(u) > 500 or u !~* '^https://\S+$') then
    raise exception 'Le lien doit commencer par https://';
  end if;
  insert into settings (key, value) values ('tricount_url', u)
  on conflict (key) do update set value = excluded.value;
end $$;

notify pgrst, 'reload schema';
