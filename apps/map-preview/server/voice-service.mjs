import {createVoiceAPI} from './voice-api.mjs';
import {createVoiceProposal} from './voice-proposal.mjs';
import {configureVoiceProvider} from './voice-setup.mjs';

/** Live services are loaded only when explicitly configured. Offline preview remains usable. */
export async function createConfiguredVoiceService({environment=process.env, dependencies,verifyProvider=configureVoiceProvider} = {}) {
  const port=Number(environment.EASYGRID_PREVIEW_PORT ?? 4177);
  const disabled=reason=>({api:createVoiceAPI({port,reason}),coordinator:null,enabled:false,reason});
  if(environment.EASYGRID_VOICE_ENABLED!=='yes')return disabled('Live voice is disabled. Configure the Cartesia and SpacetimeDB services to enable it.');
  const required=['SPACETIMEDB_DATABASE','SPACETIMEDB_TOKEN','CARTESIA_API_KEY','CARTESIA_AGENT_ID','CARTESIA_FROM_NUMBER_ID','EASYGRID_VOICE_SECRET','EASYGRID_VOICE_PUBLIC_URL'];
  if(required.some(key=>!environment[key]?.trim()) || environment.EASYGRID_VOICE_SECRET.length<32)
    return disabled('Live voice configuration is incomplete. Check the server environment.');
  let store;
  try {
    const modules=dependencies ?? await Promise.all([
      import('../../../services/spacetimedb/dist/voice-store.js'),
      import('../../../services/cartesia/dist/client.js'),
      import('./voice-coordinator.mjs'),
    ]);
    const [stateModule,providerModule,coordinatorModule]=modules;
    await verifyProvider({environment,mode:'check',provider:providerModule});
    store=await stateModule.createVoiceStore({uri:environment.SPACETIMEDB_URI || 'https://maincloud.spacetimedb.com',
      databaseName:environment.SPACETIMEDB_DATABASE,token:environment.SPACETIMEDB_TOKEN});
    const service=providerModule.createCartesiaService({apiKey:environment.CARTESIA_API_KEY});
    const runtimeFactory=attempt=>providerModule.createEasyGridVoiceRuntime({service,
      agentId:environment.CARTESIA_AGENT_ID,fromNumberId:environment.CARTESIA_FROM_NUMBER_ID,
      persistTranscript:turns=>store.markAttempt({id:attempt.id,claimId:attempt.claimId,status:'completed',
        providerCallId:attempt.providerCallId,evidence:{turns}}),
      reviewer:{review:async input=>{
        const saved=await store.getAttempt(attempt.id);
        const response=saved?.toolReceipts?.[saved.lastResponseRequestId]?.payload;
        return providerModule.reviewEasyGridToolResponse(response,input);
      }},
    });
    const coordinator=coordinatorModule.createVoiceCoordinator({store,runtimeFactory,
      secret:environment.EASYGRID_VOICE_SECRET,createProposal:createVoiceProposal});
    return {enabled:true,coordinator,api:createVoiceAPI({coordinator,port,secret:environment.EASYGRID_VOICE_SECRET})};
  } catch {
    store?.close();
    return disabled('Live voice could not connect. Build the services and verify the published SpacetimeDB module, worker identity and Cartesia configuration.');
  }
}
