import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const source = new URL('../voice-bindings/index.ts', import.meta.url);
await access(source);
const content = await readFile(source, 'utf8');
assert.match(content, /generated using spacetimedb cli version 2\.13\.0/);
for (const name of ['voiceWorkerAttempts', 'voiceResults', 'record_voice_tool', 'reserve_voice_attempt', 'save_voice_outcome']) {
  assert.ok(content.includes(name), `Generated binding is missing ${name}; run npm run generate:voice.`);
}
if (process.argv[2] === 'built') {
  // Import the real compiled artifact without building a connection or making
  // a network request. This catches missing files and Node ESM incompatibility.
  const bindings = await import('../dist/voice-bindings/index.js');
  const voice = await import('../dist/voice-store.js');
  assert.equal(typeof voice.createVoiceStore, 'function');
  assert.equal(typeof bindings.DbConnection.builder().withConfirmedReads, 'function');
  for (const name of ['reserveVoiceAttempt', 'claimVoiceAttempt', 'markVoiceAttempt', 'recordVoiceTool', 'saveVoiceCandidate', 'saveVoiceOutcome']) {
    assert.ok(name in bindings.reducers, `Missing generated reducer ${name}`);
  }
  for (const name of ['voiceWorkerAttempts', 'voiceResults']) assert.ok(name in bindings.tables);
  console.log('Compiled voice bindings and store load in Node without network access.');
}
