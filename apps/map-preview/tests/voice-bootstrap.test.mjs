import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';
import {prepareVoice} from '../server/voice-bootstrap.mjs';

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'easygrid-voice-bootstrap-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const environmentURL=pathToFileURL(join(dir,'.env.voice'));
  const checkpointURL=pathToFileURL(join(dir,'worker.json'));
  await writeFile(environmentURL,[
    'EASYGRID_VOICE_ENABLED=no','SPACETIMEDB_DATABASE=private-test','SPACETIMEDB_EXPECTED_DATABASE=private-test',
    'SPACETIMEDB_TOKEN=','CARTESIA_API_KEY=private-provider-key','CARTESIA_AGENT_ID=',
    'CARTESIA_VOICE_ID=voice-test','CARTESIA_MODEL_ID=model-test','CARTESIA_FROM_NUMBER_ID=number-test',
    'EASYGRID_VOICE_PUBLIC_URL=https://voice.example.com','UNRELATED_SETTING=keep-me','',
  ].join('\n'),{mode:0o600});
  const effects=[];
  const options={environmentURL,checkpointURL,
    connect:async input=>{effects.push(['connect',input.token]);return {identity:'worker-test',token:'private-app-token'};},
    verifyState:async input=>{effects.push(['verify']);assert.equal(input.token,'private-app-token');},
    configureProvider:async input=>{effects.push(['provider']);assert.equal(input.environment.SPACETIMEDB_TOKEN,'private-app-token');
      assert.equal(input.environment.EASYGRID_VOICE_ENABLED,'no');assert.equal(input.mode,'provision');
      return {verified:true,agentId:'agent-test'};},
  };
  const env=async()=>parseEnv(await readFile(environmentURL,'utf8'));
  return {options,effects,env};
}

test('preparation saves a private application identity, verifies state before provider setup, and never enables calls',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await prepareVoice(f.options),{stateVerified:true,providerVerified:true,liveEnabled:false});
  assert.deepEqual(f.effects.map(x=>x[0]),['connect','verify','provider']);
  const env=await f.env();
  assert.equal(env.SPACETIMEDB_TOKEN,'private-app-token');assert.equal(env.CARTESIA_AGENT_ID,'agent-test');
  assert.equal(env.CARTESIA_API_KEY,'private-provider-key');assert.equal(env.UNRELATED_SETTING,'keep-me');
  assert.equal(env.EASYGRID_VOICE_ENABLED,'no');
  for(const path of [f.options.environmentURL,f.options.checkpointURL])assert.equal((await stat(path)).mode&0o777,0o600);
  await prepareVoice(f.options);
  assert.deepEqual(f.effects[3],['connect','private-app-token'],'repeated setup restores the saved worker');
});

test('a wrong database pin stops before authentication or external resource creation',async t=>{
  const f=await fixture(t);
  const text=await readFile(f.options.environmentURL,'utf8');
  await writeFile(f.options.environmentURL,text.replace('SPACETIMEDB_DATABASE=private-test','SPACETIMEDB_DATABASE=another-test'));
  await assert.rejects(prepareVoice(f.options),/pin must match/);assert.deepEqual(f.effects,[]);
});

test('missing deployed views preserve the worker for retry and prevent Cartesia writes',async t=>{
  const f=await fixture(t);
  await assert.rejects(prepareVoice({...f.options,verifyState:async()=>{throw new Error('missing views');}}),/views were not confirmed/);
  assert.equal((await f.env()).SPACETIMEDB_TOKEN,'private-app-token');
  assert.deepEqual(f.effects.map(x=>x[0]),['connect']);
  await prepareVoice(f.options);
  assert.deepEqual(f.effects[1],['connect','private-app-token']);
});

test('a later provider failure preserves state setup and leaves live calling disabled',async t=>{
  const f=await fixture(t);
  await assert.rejects(prepareVoice({...f.options,configureProvider:async()=>{throw new Error('provider unavailable');}}),/provider unavailable/);
  const env=await f.env();assert.equal(env.SPACETIMEDB_TOKEN,'private-app-token');
  assert.equal(env.CARTESIA_AGENT_ID,'');assert.equal(env.EASYGRID_VOICE_ENABLED,'no');
  await prepareVoice(f.options);assert.deepEqual(f.effects[2],['connect','private-app-token']);
});

test('concurrent edits are preserved instead of overwritten by setup',async t=>{
  const f=await fixture(t);
  const text=await readFile(f.options.environmentURL,'utf8');
  await assert.rejects(prepareVoice({...f.options,connect:async()=>{
    await writeFile(f.options.environmentURL,text+'NEW_USER_SETTING=preserve\n');
    return {identity:'worker-test',token:'private-app-token'};
  }}),/environment changed/);
  assert.equal((await f.env()).NEW_USER_SETTING,'preserve');assert.deepEqual(f.effects,[]);
});

test('a saved identity cannot silently move to a different isolated database',async t=>{
  const f=await fixture(t);await prepareVoice(f.options);f.effects.length=0;
  await writeFile(f.options.environmentURL,(await readFile(f.options.environmentURL,'utf8')).replaceAll('private-test','different-test'));
  await assert.rejects(prepareVoice(f.options),/another database/);assert.deepEqual(f.effects,[]);
});
