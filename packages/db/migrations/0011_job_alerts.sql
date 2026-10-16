-- Tell the owner when a scheduled job keeps failing, and again when it works.
-- failures: failed runs in a row; alerted_at: when the owner was told (null = not yet).
alter table app.job_heartbeats
  add column failures int not null default 0,
  add column alerted_at timestamptz;
