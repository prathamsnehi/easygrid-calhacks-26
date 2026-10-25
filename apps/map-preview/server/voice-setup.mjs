import {mkdir,readFile,writeFile,rename,open,unlink} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

/** Provisioning is an explicit operator command. Starting the preview never creates resources. */
export async function configureVoiceProvider(options={}) {
  if(options.mode!=='provision')return configureVoiceProviderUnlocked(options);
  const checkpoint=options.checkpointURL??new URL('../.local/voice-provider-setup.json',import.meta.url);
  const lockURL=new URL('voice-provider-setup.lock',checkpoint);
  await mkdir(new URL('./',checkpoint),{recursive:true});
  let lock;
  try{lock=await open(lockURL,'wx',0o600);}
  catch{throw new Error('Provider setup is already locked. Review the other setup process and any uncertain resource creation before removing its lock.');}
  try{return await configureVoiceProviderUnlocked(options);}
  finally{await lock.close();await unlink(lockURL);}
}
async function configureVoiceProviderUnlocked({environment=process.env,mode='check',
  checkpointURL=new URL('../.local/voice-provider-setup.json',import.meta.url),fetcher=fetch,provider}={}) {
  if(!['check','provision'].includes(mode))throw new Error('Use --check or --provision.');
  const required=['CARTESIA_API_KEY','EASYGRID_VOICE_PUBLIC_URL'];
  if(required.some(key=>!environment[key]?.trim()))throw new Error('Set CARTESIA_API_KEY and EASYGRID_VOICE_PUBLIC_URL.');
  provider??=await import('../../../services/cartesia/dist/client.js');
  const definitions=provider.easyGridVoiceToolDefinitions(environment.EASYGRID_VOICE_PUBLIC_URL);
  let saved;
  try {saved=JSON.parse(await readFile(checkpointURL,'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw new Error('Preserve the unreadable provider setup checkpoint.');saved={schemaVersion:1,origin:environment.EASYGRID_VOICE_PUBLIC_URL,toolIds:{},agentId:null,pending:null};}
  if(saved.schemaVersion!==1||saved.origin!==environment.EASYGRID_VOICE_PUBLIC_URL||!saved.toolIds)throw new Error('Use the original setup origin and preserve its resource checkpoint.');
  const save=async()=>{
    await mkdir(new URL('./',checkpointURL),{recursive:true});
    const temporary=new URL('voice-provider-setup.tmp',checkpointURL);
    await writeFile(temporary,JSON.stringify(saved,null,2)+'\n',{mode:0o600});await rename(temporary,checkpointURL);
  };
  const get=async path=>{
    const response=await fetcher(`https://api.cartesia.ai${path}`,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{Authorization:`Bearer ${environment.CARTESIA_API_KEY}`,'Cartesia-Version':'2026-08-14'}});
    if(!response.ok)throw new Error('Cartesia setup verification was not confirmed.');return response.json();
  };
  if(mode==='provision') {
    if(saved.pending)throw new Error('A previous resource creation was not confirmed. Reconcile it in Cartesia and update the checkpoint before retrying.');
    if(!environment.CARTESIA_VOICE_ID?.trim()||!environment.CARTESIA_MODEL_ID?.trim())throw new Error('Set CARTESIA_VOICE_ID and CARTESIA_MODEL_ID before provisioning.');
    // Persist intent BEFORE each resource POST, including a tool created inside the helper.
    const transport=async(url,options)=>{
      if(options.method==='POST') {
        const definition=JSON.parse(options.body);
        saved.pending={kind:'tool',name:definition.name};await save();
      }
      const response=await fetcher(url,options);
      // Explicit validation/auth rejection confirms that no tool was created.
      // Lost responses and server failures retain the pending write checkpoint.
      if(options.method==='POST'&&[400,401,403,404,422].includes(response.status)) {
        saved.lastRejected={...saved.pending,status:response.status};
        saved.pending=null;await save();
      }
      return response;
    };
    saved.toolIds=await provider.provisionEasyGridVoiceTools({apiKey:environment.CARTESIA_API_KEY,
      publicBaseUrl:environment.EASYGRID_VOICE_PUBLIC_URL,existingToolIds:saved.toolIds,fetch:transport,
      onCreated:async(name,id)=>{saved.toolIds[name]=id;saved.pending=null;await save();}});
    if(!saved.agentId) {
      saved.pending={kind:'agent'};await save();
      const service=provider.createCartesiaService({apiKey:environment.CARTESIA_API_KEY,fetch:fetcher});
      const agent=await service.createAgent({name:'EasyGrid landowner roleplay',prompt:provider.EASYGRID_VOICE_PROMPT,
        voiceId:environment.CARTESIA_VOICE_ID,modelId:environment.CARTESIA_MODEL_ID,toolIds:Object.values(saved.toolIds),
        initialMessage:"Hi, I'm EasyGrid's AI assistant for this roleplay demo. Is now a good time to discuss transmission access across your fictional parcel?"});
      if(!agent?.id)throw new Error('Agent creation was not confirmed. Preserve its pending checkpoint.');
      saved.agentId=agent.id;saved.pending=null;await save();
    }
  }
  const agentId=environment.CARTESIA_AGENT_ID?.trim()||saved.agentId;
  if(!agentId||saved.pending)throw new Error('Complete and reconcile provider setup before enabling live voice.');
  const agent=await get(`/v1/agents/${encodeURIComponent(agentId)}`);
  if(agent.id!==agentId||agent.config?.instructions!==provider.EASYGRID_VOICE_PROMPT)throw new Error('The configured agent does not use the verified EasyGrid prompt.');
  const ids=new Set((agent.config?.tools??[]).map(tool=>tool.id));
  if(ids.size!==definitions.length||(agent.config?.tools??[]).length!==definitions.length)throw new Error('The agent must contain exactly the two verified EasyGrid tools.');
  const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
  const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
  for(const definition of definitions) {
    const id=saved.toolIds[definition.name];
    if(!id||!ids.has(id))throw new Error('The agent is missing an authenticated EasyGrid tool.');
    const tool=await get(`/v1/agents/tools/${encodeURIComponent(id)}`);
    if(tool.id!==id||tool.name!==definition.name||tool.type!==definition.type||tool.api_schema?.url!==definition.api_schema.url||
      tool.api_schema?.method!=='POST'||!same(tool.api_schema?.request_body_schema,definition.api_schema.request_body_schema)||
      !same(tool.api_schema?.request_headers,definition.api_schema.request_headers)||tool.api_schema?.authentication)
      throw new Error('A configured tool does not match the scoped callback configuration.');
  }
  return {agentId,toolIds:saved.toolIds,verified:true};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const mode=process.argv[2]==='--provision'?'provision':process.argv[2]==='--check'?'check':null;
  try {
    if(!mode)throw new Error('Use --check or --provision.');
    const result=await configureVoiceProvider({mode});
    console.log(`Cartesia configuration verified. CARTESIA_AGENT_ID=${result.agentId}`);
    console.log('No phone call was placed. Verify the published SpacetimeDB module separately.');
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
