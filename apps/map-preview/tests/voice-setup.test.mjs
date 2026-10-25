import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {configureVoiceProvider} from '../server/voice-setup.mjs';
import {easyGridVoiceToolDefinitions,provisionEasyGridVoiceTools} from '../../../services/cartesia/easygrid-tools.ts';
import {EASYGRID_VOICE_PROMPT} from '../../../services/cartesia/easygrid-voice.ts';

async function fixture(t,{lost}={}) {
  const directory=await mkdtemp(join(tmpdir(),'easygrid-voice-setup-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const checkpointURL=pathToFileURL(join(directory,'setup.json'));
  const environment={CARTESIA_API_KEY:'test-private-key',EASYGRID_VOICE_PUBLIC_URL:'https://voice.example.com',
    CARTESIA_VOICE_ID:'test-voice',CARTESIA_MODEL_ID:'test-model'};
  const tools=new Map(),calls=[];let agent=null;
  const checkpoint=async()=>JSON.parse(await readFile(checkpointURL,'utf8'));
  const fetcher=async(url,options)=>{
    const path=new URL(url).pathname;calls.push({path,method:options.method});
    assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer test-private-key');
    if(options.method==='POST'){
      assert.equal(path,'/v1/agents/tools');
      const definition=JSON.parse(options.body),saved=await checkpoint();
      assert.deepEqual(saved.pending,{kind:'tool',name:definition.name},'intent is durable before the external write');
      const value={...definition,id:`tool-${tools.size+1}`};tools.set(value.id,value);
      if(lost==='tool')throw new Error('Lost tool creation response.');
      return Response.json(value,{status:201});
    }
    if(path.startsWith('/v1/agents/tools/'))return Response.json(tools.get(path.split('/').at(-1))??{},{status:tools.has(path.split('/').at(-1))?200:404});
    if(path.startsWith('/v1/agents/'))return Response.json(agent??{},{status:agent?200:404});
    throw new Error('Unexpected mock provider endpoint.');
  };
  const provider={easyGridVoiceToolDefinitions,provisionEasyGridVoiceTools,EASYGRID_VOICE_PROMPT,
    createCartesiaService:()=>({createAgent:async options=>{
      calls.push({path:'/v1/agents',method:'POST'});
      assert.deepEqual((await checkpoint()).pending,{kind:'agent'});
      assert.equal(options.prompt,EASYGRID_VOICE_PROMPT);assert.deepEqual(options.toolIds,[...tools.keys()]);
      agent={id:'agent-1',config:{instructions:options.prompt,tools:options.toolIds.map(id=>({id}))}};
      if(lost==='agent')throw new Error('Lost agent creation response.');
      return agent;
    }})};
  const options={environment,checkpointURL,fetcher,provider};
  return {directory,options,tools,calls,checkpoint,getAgent:()=>agent};
}

test('read-only setup check never creates provider resources or a checkpoint',async t=>{
  const f=await fixture(t);
  await assert.rejects(configureVoiceProvider(f.options),/Complete and reconcile/);
  assert.deepEqual(f.calls,[]);await assert.rejects(readFile(f.options.checkpointURL),{code:'ENOENT'});
});

test('explicit provisioning checkpoints each write, then check and rerun reuse the same resources',async t=>{
  const f=await fixture(t),environment=structuredClone(f.options.environment);
  const result=await configureVoiceProvider({...f.options,mode:'provision'});
  assert.equal(result.verified,true);assert.equal(result.agentId,'agent-1');
  assert.equal(f.calls.filter(c=>c.method==='POST').length,3);
  const saved=await f.checkpoint();assert.equal(saved.pending,null);assert.equal(saved.agentId,'agent-1');
  assert.equal(Object.keys(saved.toolIds).length,2);assert.equal((await stat(f.options.checkpointURL)).mode&0o777,0o600);
  const original=await readFile(f.options.checkpointURL,'utf8');assert(!original.includes(environment.CARTESIA_API_KEY));
  await configureVoiceProvider({...f.options,mode:'check'});
  assert.equal(await readFile(f.options.checkpointURL,'utf8'),original);
  await configureVoiceProvider({...f.options,mode:'provision'});
  assert.equal(f.calls.filter(c=>c.method==='POST').length,3,'rerunning setup must not duplicate tools or agent');
  assert.deepEqual(f.options.environment,environment);assert(!f.calls.some(c=>c.path.includes('call')));
});

test('uncertain tool or agent creation is preserved and cannot be blindly repeated',async t=>{
  for(const lost of ['tool','agent']){
    const f=await fixture(t,{lost});
    await assert.rejects(configureVoiceProvider({...f.options,mode:'provision'}),/Lost/);
    assert.equal((await f.checkpoint()).pending.kind,lost);
    const original=await readFile(f.options.checkpointURL,'utf8'),calls=f.calls.length;
    await assert.rejects(configureVoiceProvider({...f.options,mode:'provision'}),/previous resource creation/);
    await assert.rejects(configureVoiceProvider({...f.options,mode:'check'}),/Complete and reconcile/);
    assert.equal(f.calls.length,calls);assert.equal(await readFile(f.options.checkpointURL,'utf8'),original);
  }
});

test('checkpoint persistence failure stops before a provider POST',async t=>{
  const f=await fixture(t);
  await mkdir(join(f.directory,'voice-provider-setup.tmp'));
  await assert.rejects(configureVoiceProvider({...f.options,mode:'provision'}));
  assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});

test('changed setup origin, unreadable checkpoint, modified prompt and wrong callback stay unverified',async t=>{
  const f=await fixture(t);await configureVoiceProvider({...f.options,mode:'provision'});
  const original=await readFile(f.options.checkpointURL,'utf8'),calls=f.calls.length;
  await assert.rejects(configureVoiceProvider({...f.options,environment:{...f.options.environment,EASYGRID_VOICE_PUBLIC_URL:'https://other.example.com'}}),/original setup origin/);
  assert.equal(f.calls.length,calls);
  await writeFile(f.options.checkpointURL,'{broken');
  await assert.rejects(configureVoiceProvider(f.options),/unreadable/);assert.equal(f.calls.length,calls);
  await writeFile(f.options.checkpointURL,original);
  f.getAgent().config.instructions='A different unverified prompt.';
  await assert.rejects(configureVoiceProvider(f.options),/verified EasyGrid prompt/);
  f.getAgent().config.instructions=EASYGRID_VOICE_PROMPT;
  f.tools.get('tool-1').api_schema.url='https://other.example.com/callback';
  await assert.rejects(configureVoiceProvider(f.options),/scoped callback configuration/);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,3);
});

test('verification rejects extra agent capabilities and any altered tool contract',async t=>{
  const f=await fixture(t);await configureVoiceProvider({...f.options,mode:'provision'});
  const agent=f.getAgent(),originalTool=structuredClone(f.tools.get('tool-1'));
  agent.config.tools.push({id:'unapproved-third-tool'});
  await assert.rejects(configureVoiceProvider(f.options),/exactly the two/);
  agent.config.tools.pop();
  for(const mutate of [
    tool=>{tool.name='different-tool';},tool=>{tool.type='client';},tool=>{tool.api_schema.method='GET';},
    tool=>{tool.api_schema.request_body_schema.required=[];},
    tool=>{tool.api_schema.request_headers.Authorization={type:'value',value:'unscoped'};},
    tool=>{tool.api_schema.authentication={type:'bearer'};},
  ]){
    const altered=structuredClone(originalTool);mutate(altered);f.tools.set('tool-1',altered);
    await assert.rejects(configureVoiceProvider(f.options),/scoped callback configuration/);
  }
  f.tools.set('tool-1',originalTool);
  assert.equal((await configureVoiceProvider(f.options)).verified,true);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,3);
});

test('provisioning has one exclusive checkpoint owner and never steals a stale lock',async t=>{
  const f=await fixture(t);let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  t.after(()=>release());
  let first=true;
  const pending=configureVoiceProvider({...f.options,mode:'provision',fetcher:async(url,options)=>{
    if(first&&options.method==='POST'){first=false;entered();await gate;}
    return f.options.fetcher(url,options);
  }});
  await started;
  await assert.rejects(configureVoiceProvider({...f.options,mode:'provision'}),/already locked/);
  release();await pending;
  assert.equal(f.calls.filter(c=>c.method==='POST').length,3);
  const lock=join(f.directory,'voice-provider-setup.lock');
  await assert.rejects(stat(lock),{code:'ENOENT'});
  await writeFile(lock,'earlier uncertain provisioning');
  const count=f.calls.length;
  await assert.rejects(configureVoiceProvider({...f.options,mode:'provision'}),/already locked/);
  assert.equal(f.calls.length,count);assert.equal(await readFile(lock,'utf8'),'earlier uncertain provisioning');
});
