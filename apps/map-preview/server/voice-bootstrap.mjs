import {mkdir,open,readFile,rename,unlink,writeFile,chmod} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {pathToFileURL} from 'node:url';
import {configureVoiceProvider} from './voice-setup.mjs';

const envURL = new URL('../.env.voice',import.meta.url);
const identityURL = new URL('../.local/voice-worker-identity.json',import.meta.url);
const failure = message => new Error(message);

async function atomicPrivateWrite(target,contents) {
  const temporary = new URL(`${target.pathname.split('/').at(-1)}.tmp`,target);
  await writeFile(temporary,contents,{mode:0o600});
  await chmod(temporary,0o600);
  await rename(temporary,target);
}

/** Operator-only setup. Creates an application identity, never loads CLI credentials,
 * never invokes a reducer, never calls a phone, and never enables the live host. */
export async function prepareVoice({environmentURL=envURL,checkpointURL=identityURL,
  connect=connectApplicationIdentity,verifyState=verifyVoiceState,configureProvider=configureVoiceProvider,
  onProgress=()=>{}}={}) {
  await mkdir(new URL('./',checkpointURL),{recursive:true});
  const lockURL = new URL('voice-bootstrap.lock',checkpointURL);
  let lock;
  try {lock=await open(lockURL,'wx',0o600);}
  catch {throw failure('Voice preparation is already running. Preserve its lock until that process has stopped.');}
  try {
    let original=await readFile(environmentURL,'utf8');
    const environment=parseEnv(original);
    const databaseName=environment.SPACETIMEDB_DATABASE?.trim();
    const uri=environment.SPACETIMEDB_URI?.trim()||'https://maincloud.spacetimedb.com';
    if(!databaseName||databaseName!==environment.SPACETIMEDB_EXPECTED_DATABASE?.trim())
      throw failure('The database and isolated-database pin must match before setup.');
    if(environment.EASYGRID_VOICE_ENABLED!=='no')
      throw failure('Keep EASYGRID_VOICE_ENABLED=no during preparation.');
    for(const key of ['CARTESIA_API_KEY','CARTESIA_VOICE_ID','CARTESIA_MODEL_ID','CARTESIA_FROM_NUMBER_ID','EASYGRID_VOICE_PUBLIC_URL'])
      if(!environment[key]?.trim())throw failure(`Set ${key} before preparation.`);
    let saved;
    try {saved=JSON.parse(await readFile(checkpointURL,'utf8'));}
    catch(error) {if(error.code!=='ENOENT')throw failure('Preserve the unreadable application identity checkpoint.');}
    if(saved&&(saved.schemaVersion!==1||saved.uri!==uri||saved.databaseName!==databaseName||
      typeof saved.token!=='string'||!saved.token||typeof saved.identity!=='string'))
      throw failure('The saved identity belongs to another database or needs review.');
    const configuredToken=environment.SPACETIMEDB_TOKEN?.trim();
    if(saved&&configuredToken&&saved.token!==configuredToken)
      throw failure('The configured application token differs from its saved identity.');

    // A reconnect restores the same application identity even if a previous
    // schema check or provider setup stopped halfway through preparation.
    const auth=await connect({uri,databaseName,token:configuredToken||saved?.token});
    if(!auth||typeof auth.token!=='string'||!auth.token||/[\r\n]/.test(auth.token)||
      typeof auth.identity!=='string'||!auth.identity)
      throw failure('An application identity was not confirmed.');
    if(saved&&saved.identity!==auth.identity)throw failure('The application identity changed unexpectedly.');
    saved={schemaVersion:1,uri,databaseName,identity:auth.identity,token:auth.token};
    await atomicPrivateWrite(checkpointURL,JSON.stringify(saved,null,2)+'\n');
    const updateEnvironment=async updates=>{
      if(await readFile(environmentURL,'utf8')!==original)
        throw failure('The private environment changed during setup. Preserve the checkpoint and rerun after reviewing the edit.');
      for(const [key,value] of Object.entries(updates)) {
        if(typeof value!=='string'||!value||/[\r\n]/.test(value))throw failure('Invalid private configuration value.');
        const pattern=new RegExp(`^${key}=.*$`,'gm');
        const matches=[...original.matchAll(pattern)];
        if(matches.length>1)throw failure(`Remove duplicate ${key} entries before setup.`);
        const line=`${key}=${JSON.stringify(value)}`;
        original=matches.length?original.replace(pattern,()=>line):`${original.trimEnd()}\n${line}\n`;
        environment[key]=value;
      }
      await atomicPrivateWrite(environmentURL,original);
    };
    await updateEnvironment({SPACETIMEDB_TOKEN:auth.token});
    try {await verifyState({uri,databaseName,token:auth.token});}
    catch {throw failure('The application identity was saved, but the published voice views were not confirmed. No provider resource was created.');}
    onProgress('Application identity saved; published voice views verified.');
    const provider=await configureProvider({environment,mode:'provision',
      checkpointURL:new URL('voice-provider-setup.json',checkpointURL)});
    if(!provider?.verified||!provider.agentId)throw failure('Cartesia configuration was not verified.');
    await updateEnvironment({CARTESIA_AGENT_ID:provider.agentId});
    onProgress('Cartesia agent and both scoped callback tools verified.');
    return {stateVerified:true,providerVerified:true,liveEnabled:false};
  } finally {await lock.close();await unlink(lockURL);}
}

export async function connectApplicationIdentity({uri,databaseName,token},timeoutMs=15000) {
  const {DbConnection}=await import('../../../services/spacetimedb/dist/voice-bindings/index.js');
  return new Promise((resolve,reject)=>{
    let connection,done=false;
    const finish=(value,error)=>{
      if(done)return;done=true;clearTimeout(timer);connection?.disconnect();
      if(error)reject(error);else resolve(value);
    };
    const timer=setTimeout(()=>finish(null,failure('SpacetimeDB connection timed out. No live calls were enabled.')),timeoutMs);
    try {
      const builder=DbConnection.builder().withUri(uri).withDatabaseName(databaseName)
        .onConnect((connected,identity,issuedToken)=>{
          connection=connected;
          if(done){connected.disconnect();return;}
          finish({identity:identity.toHexString(),token:issuedToken});
        })
        .onConnectError(()=>finish(null,failure('SpacetimeDB connection failed. Check network access and the published database.')));
      if(token)builder.withToken(token);
      connection=builder.build();
    } catch {finish(null,failure('Build the SpacetimeDB service before preparation.'));}
  });
}

async function verifyVoiceState(options) {
  const {createVoiceStore}=await import('../../../services/spacetimedb/dist/voice-store.js');
  const store=await createVoiceStore(options);
  store.close();
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    if(process.argv[2]!=='--prepare')throw failure('Use --prepare.');
    await prepareVoice({onProgress:message=>console.log(message)});
    console.log('Preparation complete. Live calling remains disabled; deploy and verify the authenticated call host before enabling it.');
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
