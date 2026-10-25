CREATE TABLE IF NOT EXISTS worker_state (
  id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL
);
