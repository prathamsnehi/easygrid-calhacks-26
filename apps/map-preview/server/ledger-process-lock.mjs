import {closeSync, fstatSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

// One process must own both Nessie ledgers before loading either of them.
// A leftover lock is deliberately not reclaimed from a PID or age check:
// interrupted transfers need review before another process can send money.
export function acquireLedgerProcessLock(path) {
  const lockPath = path instanceof URL ? fileURLToPath(path) : path;
  mkdirSync(dirname(lockPath), {recursive:true,mode:0o700});
  let descriptor;
  try { descriptor = openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`The Nessie ledger is already locked. Stop the other server and review any interrupted payments before manually removing ${lockPath}.`);
    throw new Error('The Nessie ledger process lock could not be created.', {cause:error});
  }
  const identity = fstatSync(descriptor);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', releaseAtExit);
    try {
      const current = lstatSync(lockPath);
      // Never delete a different process's lock if the path was replaced.
      if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    } finally { closeSync(descriptor); }
  };
  const releaseAtExit = () => {
    try { release(); }
    catch { console.error('The Nessie ledger lock could not be removed. Review it before restarting.'); }
  };
  try { writeFileSync(descriptor, JSON.stringify({schemaVersion:1,pid:process.pid,startedAt:new Date().toISOString()}) + '\n'); }
  catch (error) { release(); throw new Error('The Nessie ledger process lock could not be initialized.', {cause:error}); }
  process.once('exit', releaseAtExit);
  return {release};
}
