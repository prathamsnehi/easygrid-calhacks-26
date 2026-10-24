import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {acquireLedgerProcessLock} from '../server/ledger-process-lock.mjs';

const moduleURL = new URL('../server/ledger-process-lock.mjs',import.meta.url).href;
function runChild(path, action = '') {
  return spawnSync(process.execPath, ['--input-type=module','-e',
    `import {acquireLedgerProcessLock} from ${JSON.stringify(moduleURL)};
    acquireLedgerProcessLock(${JSON.stringify(path)});
    ${action}`], {encoding:'utf8',timeout:10000});
}
function temporaryLock(t) {
  const directory = mkdtempSync(join(tmpdir(),'easygrid-nessie-lock-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  return join(directory,'nessie-server.lock');
}

test('exclusive ownership blocks another process and normal exit allows a new owner', t => {
  const path = temporaryLock(t), owner = acquireLedgerProcessLock(path);
  t.after(()=>owner.release());
  const metadata = JSON.parse(readFileSync(path,'utf8'));
  assert.deepEqual(Object.keys(metadata).sort(),['pid','schemaVersion','startedAt']);
  assert.equal(metadata.pid,process.pid);
  assert.equal(statSync(path).mode & 0o777,0o600);
  const blocked = runChild(path);
  assert.notEqual(blocked.status,0);
  assert.match(blocked.stderr,/Nessie ledger is already locked/);
  assert.equal(JSON.parse(readFileSync(path,'utf8')).pid,process.pid);
  owner.release();
  const next = runChild(path);
  assert.equal(next.status,0,next.stderr);
  assert.throws(()=>statSync(path),{code:'ENOENT'});
  const restarted = acquireLedgerProcessLock(path);
  restarted.release();
  restarted.release();
});

test('an abrupt process stop leaves a lock that requires manual review', t => {
  const path = temporaryLock(t);
  const interrupted = runChild(path,"process.kill(process.pid,'SIGKILL');");
  assert.equal(interrupted.signal,'SIGKILL');
  assert.throws(()=>acquireLedgerProcessLock(path),/review any interrupted payments/);
  assert.equal(statSync(path).isFile(),true);
});

test('a stale lock is never reclaimed from its PID or age', t => {
  const path = temporaryLock(t), stale = JSON.stringify({pid:999999999,startedAt:'1970-01-01T00:00:00Z'});
  writeFileSync(path,stale);
  assert.throws(()=>acquireLedgerProcessLock(path),/already locked/);
  assert.equal(readFileSync(path,'utf8'),stale);
});

test('a failed startup releases ownership through the process exit hook', t => {
  const path = temporaryLock(t);
  const failed = runChild(path,"throw new Error('Simulated server startup failure.');");
  assert.notEqual(failed.status,0);
  assert.match(failed.stderr,/Simulated server startup failure/);
  assert.throws(()=>statSync(path),{code:'ENOENT'});
  const restarted = acquireLedgerProcessLock(path);
  restarted.release();
});

test('releasing an old owner never removes a replacement lock', t => {
  const path = temporaryLock(t), owner = acquireLedgerProcessLock(path);
  t.after(()=>owner.release());
  unlinkSync(path);
  writeFileSync(path,'replacement owner');
  owner.release();
  assert.equal(readFileSync(path,'utf8'),'replacement owner');
  assert.throws(()=>acquireLedgerProcessLock(path),/already locked/);
});
