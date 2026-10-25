import { isIP } from 'node:net';

export type EasyGridToolName = 'evaluate_counteroffer' | 'record_owner_response';

/** Pure configuration: no provider resources are created by constructing these definitions. */
export function easyGridVoiceToolDefinitions(publicBaseUrl: string) {
  const base = new URL(publicBaseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/' || !base.hostname.includes('.') || base.hostname.endsWith('.local') || base.hostname.endsWith('.localhost') || isIP(base.hostname.replace(/^\[|\]$/g,''))) throw new Error('A public HTTPS origin without credentials is required.');
  const common = {
    type:'webhook', pre_tool_speech:'auto', execution_mode:'immediate', response_timeout_secs:10,
  };
  const api = (path:string,properties:Record<string,unknown>,required:string[]) => ({
    url:new URL(path,base).href, method:'POST',
    request_headers:{
      Authorization:{type:'dynamic_variable',name:'attempt_authorization'},
      'X-EasyGrid-Call':{type:'dynamic_variable',name:'system__conversation_id'},
    },
    request_body_schema:{type:'object',properties,required},
  });
  const requestId = {type:'string',description:'Choose one unique action identifier; reuse it if this same action is retried.'};
  return [{ ...common, name:'evaluate_counteroffer' as const,
    description:'Check an exact requested compensation against the approved limits before speaking any changed offer. The server returns the only permitted offer.',
    api_schema:api('/api/voice/tools/counteroffer',{
      requestId,
      requestedCompensationCents:{type:'integer',description:'Exact requested USD cents. Omit this field if the owner objects to price without an exact amount. Never invent or round an amount.'},
    },['requestId']),
  },{ ...common, name:'record_owner_response' as const,
    description:'Record a candidate from the owner’s actual words. Conditional requires explicit tower-placement agreement if one named edge of their original parcel is used. Whole-line relocation requires review. This tool never finalizes acceptance or payment.',
    api_schema:api('/api/voice/tools/response',{
      requestId,
      decision:{type:'string',enum:['accepted','refused','conditional','review_required'],description:'Owner response; a request or unclear answer is review_required.'},
      acceptedCompensationCents:{type:'integer',description:'Required for accepted or conditional: exact tool-approved compensation accepted by the owner, in USD cents. Omit for refused or review_required. Never infer or invent an accepted amount.'},
      conditionDirection:{type:'string',enum:['north','south','east','west','none'],description:'The explicitly agreed edge. Use none when no supported location condition exists.'},
      conditionQuote:{type:'string',description:'Exact conditional agreement sentence; empty string for an unconditional decision.'},
      evidenceQuote:{type:'string',description:'The complete owner response in their own words; do not shorten away qualifications.'},
    },['requestId','decision','conditionDirection','conditionQuote','evidenceQuote']),
  }];
}

/** Explicit setup operation, never called by start(). Save each returned ID before creating the next tool.
 * A failed/uncertain POST is not retried. Existing IDs must come from the caller's saved checkpoint.
 */
export async function provisionEasyGridVoiceTools({ apiKey, publicBaseUrl, existingToolIds = {}, onCreated, fetch:transport = globalThis.fetch }: {
  apiKey:string; publicBaseUrl:string; existingToolIds?:Partial<Record<EasyGridToolName,string>>;
  onCreated:(name:EasyGridToolName,id:string)=>Promise<void>; fetch?:typeof globalThis.fetch;
}) {
  if (!apiKey.trim()) throw new Error('A Cartesia key is required.');
  const result:Partial<Record<EasyGridToolName,string>> = {};
  for (const definition of easyGridVoiceToolDefinitions(publicBaseUrl)) {
    const existing = existingToolIds[definition.name];
    if (existing && !/^[A-Za-z0-9_-]{1,160}$/.test(existing)) throw new Error('Invalid saved tool identifier.');
    const response = await transport(`https://api.cartesia.ai/v1/agents/tools${existing ? `/${encodeURIComponent(existing)}` : ''}`,{
      method:existing ? 'GET' : 'POST', redirect:'error', signal:AbortSignal.timeout(30_000),
      headers:{Authorization:`Bearer ${apiKey}`,'Cartesia-Version':'2026-08-14','Content-Type':'application/json'},
      ...(!existing ? {body:JSON.stringify(definition)} : {}),
    });
    if (!response.ok) throw new Error(`Cartesia tool setup was not confirmed (HTTP ${response.status}); inspect the saved setup status before retrying.`);
    const body = await response.json() as {id?:unknown;name?:unknown;api_schema?:{url?:unknown;request_headers?:unknown}};
    if (typeof body.id !== 'string' || !body.id || body.name !== definition.name) throw new Error('Cartesia returned an unexpected tool record.');
    if (existing && (body.id !== existing || body.api_schema?.url !== definition.api_schema.url || JSON.stringify(body.api_schema?.request_headers) !== JSON.stringify(definition.api_schema.request_headers))) throw new Error('The saved tool does not match this authenticated callback configuration.');
    if (!existing) await onCreated(definition.name,body.id);
    result[definition.name] = body.id;
  }
  return result as Record<EasyGridToolName,string>;
}
