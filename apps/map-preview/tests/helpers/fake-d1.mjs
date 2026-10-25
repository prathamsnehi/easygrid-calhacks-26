import assert from 'node:assert/strict';
const copy = value => structuredClone(value);

/** Model D1 compare-and-swap, including independent reads by concurrent workers. */
export function fakeDatabase() {
  const rows = new Map();
  const database = {rows, reads:0, writes:0, conflicts:0, failures:0, beforeWrite:null,
    prepare(sql) {
      assert(!/CREATE|ALTER/i.test(sql), 'request handlers must not run migrations');
      return {bind(...args) {
        return {
          async first() {
            assert.match(sql, /^SELECT\s+revision\s*,\s*snapshot_json\s+FROM\s+worker_state\s+WHERE\s+id\s*=\s*\?/i);
            database.reads++;
            return rows.has(args[0]) ? copy(rows.get(args[0])) : null;
          },
          async run() {
            database.writes++;
            if (database.beforeWrite) await database.beforeWrite();
            if (database.failures > 0) {database.failures--; throw new Error('private database connection failure');}
            if (database.conflicts > 0) {database.conflicts--; return {meta:{changes:0}};}
            if (/^INSERT\s+INTO\s+worker_state/i.test(sql)) {
              const [id,snapshot_json] = args;
              assert.match(sql, /ON\s+CONFLICT\s*\(id\)\s+DO\s+NOTHING/i);
              if (rows.has(id)) return {meta:{changes:0}};
              rows.set(id,{revision:1,snapshot_json});
            } else {
              assert.match(sql, /^UPDATE\s+worker_state\s+SET\s+revision\s*=\s*\?/i);
              const [revision,snapshot_json,id,previous] = args;
              if (rows.get(id)?.revision !== previous) return {meta:{changes:0}};
              assert.equal(revision,previous + 1);
              rows.set(id,{revision,snapshot_json});
            }
            return {meta:{changes:1}};
          },
        };
      }};
    },
  };
  return database;
}

