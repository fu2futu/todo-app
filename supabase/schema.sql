create extension if not exists "pgcrypto";

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(trim(title)) > 0),
  priority integer not null unique,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists set_tasks_updated_at on public.tasks;

create trigger set_tasks_updated_at
before update on public.tasks
for each row
execute function public.set_updated_at();

alter table public.tasks enable row level security;

drop policy if exists "tasks public read" on public.tasks;
drop policy if exists "tasks public insert" on public.tasks;
drop policy if exists "tasks public update" on public.tasks;
drop policy if exists "tasks public delete" on public.tasks;

create policy "tasks public read"
on public.tasks
for select
to anon, authenticated
using (true);

create policy "tasks public insert"
on public.tasks
for insert
to anon, authenticated
with check (true);

create policy "tasks public update"
on public.tasks
for update
to anon, authenticated
using (true)
with check (true);

create policy "tasks public delete"
on public.tasks
for delete
to anon, authenticated
using (true);
