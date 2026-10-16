-- Payment and supplier keys the owner enters in Admin → Settings → Keys.
--
-- Values are AES-GCM encrypted by the Worker with DATA_KEY (which never leaves
-- the Worker's secrets), so the database alone does not reveal them. A key set
-- here takes precedence over a Worker secret of the same name. Only names from
-- the list in packages/api/src/keys.ts are accepted by the API.
create table if not exists app.store_keys (
  name text primary key check (name ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  value_enc text not null check (value_enc like 'v1.%'),
  hint text check (hint is null or length(hint) <= 8),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.users (id)
);

alter table app.store_keys enable row level security;
create policy store_server_all on app.store_keys for all to store_server using (true) with check (true);
grant select, insert, update, delete on app.store_keys to store_server;
