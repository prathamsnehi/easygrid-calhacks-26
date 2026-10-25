import {createContractAPI} from './contract-api.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const headers = {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
const json = (status, value) => new Response(JSON.stringify(value),{status,headers});
const unavailable = 'Live calls are not configured on this hosted preview. Use the simulated approval or refusal controls.';
const emptySnapshot = () => ({schemaVersion:1,files:{}});

/**
 * Owner-private Sites adapter. Every request gets an isolated simulation, and
 * its entire ledger is committed with D1 compare-and-swap before responding.
 * Never enable an external payment or calling provider in this adapter: a CAS
 * retry is safe only because every effect belongs to the transaction snapshot.
 * The authentication header is supplied by the Sites access boundary.
 */
export function createHostedPreview({database} = {}) {
  return async request => {
    const url = new URL(request.url), pathname = url.pathname;
    if (!pathname.startsWith('/api/')) return null;
    const owner = request.headers.get('oai-authenticated-user-id');
    if (!owner || owner.length > 512) return json(401,{error:'Sign in to this private preview to continue.'});
    const origin = request.headers.get('origin');
    if ((origin && origin !== url.origin) || ['cross-site','same-site'].includes(request.headers.get('sec-fetch-site')))
      return json(403,{error:'Same-origin preview access required.'});
    if (pathname.startsWith('/api/voice/')) {
      if (request.method === 'GET' && pathname === '/api/voice/config')
        return json(200,{enabled:false,mode:'unavailable',reason:unavailable,
          paymentSchedule:'full-after-signatures',conditionalScope:'verified tower placement within the original parcel',language:'en'});
      return json(503,{error:unavailable});
    }
    if (!pathname.startsWith('/api/contracts/')) return json(404,{error:'Unknown preview endpoint.'});
    if (!database || typeof database.prepare !== 'function') return json(503,{error:'The durable preview ledger is unavailable.'});
    if (!['GET','POST'].includes(request.method)) return json(405,{error:'Method not supported.'});
    let body = '';
    if (request.method === 'POST') {
      if (origin !== url.origin || request.headers.get('x-easygrid-demo') !== '1' ||
        !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? ''))
        return json(403,{error:'Same-origin JSON preview requests are required.'});
      if (Number(request.headers.get('content-length')) > 256000) return json(413,{error:'Contract request too large.'});
      // Enforce the bound while reading, including requests without a trusted
      // Content-Length, rather than allocating an unbounded Worker body first.
      try {
        const reader = request.body?.getReader(), decoder = new TextDecoder();
        let size = 0;
        if (reader) while (true) {
          const {done,value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 256000) {await reader.cancel();return json(413,{error:'Contract request too large.'});}
          body += decoder.decode(value,{stream:true});
        }
        body += decoder.decode();
      } catch {return json(400,{error:'Invalid contract request.'});}
      try {JSON.parse(body);} catch {return json(400,{error:'Invalid contract request.'});}
    }
    const id = `easygrid:${owner}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const row = await database.prepare('SELECT revision, snapshot_json FROM worker_state WHERE id = ?').bind(id).first();
        const snapshot = row ? JSON.parse(row.snapshot_json) : emptySnapshot();
        if (snapshot?.schemaVersion !== 1 || !snapshot.files || typeof snapshot.files !== 'object' || Array.isArray(snapshot.files) ||
          (row && (!Number.isSafeInteger(row.revision) || row.revision < 1)))
          return json(503,{error:'The durable preview ledger needs review.'});
        const before = JSON.stringify(snapshot);
        const stateStore = {
          async read(target) {
            const key = String(target);
            if (!Object.hasOwn(snapshot.files,key)) throw Object.assign(new Error('Missing ledger.'),{code:'ENOENT'});
            return copy(snapshot.files[key]);
          },
          async write(target, state) {snapshot.files[String(target)] = copy(state);},
        };
        // The external origin and Sites identity have already been checked. Only
        // this private adapter supplies the local development API's host header.
        const api = await createContractAPI({environment:{EASYGRID_PAYMENT_PROVIDER:'simulation',EASYGRID_PREVIEW_PORT:'4177'},
          stateURL:new URL('file:///easygrid-preview/full-contract-ledger.json'),stateStore});
        let status = 500, responseHeaders = headers, responseBody = '';
        const response = {
          writeHead(code, values) {status=code;responseHeaders=values;return this;},
          end(value = '') {responseBody=String(value);return this;},
        };
        const incoming = {method:request.method,url:pathname,
          headers:{host:'localhost:4177',origin:'http://localhost:4177','content-type':'application/json','x-easygrid-demo':'1'},
          async *[Symbol.asyncIterator]() {if (body) yield new TextEncoder().encode(body);},
        };
        const handled = await api(incoming,response,pathname);
        if (!handled) return json(404,{error:'Unknown contract endpoint.'});
        if (pathname === '/api/contracts/config' && status === 200) {
          const config = JSON.parse(responseBody);
          responseBody = JSON.stringify({...config,storage:'durable private preview ledger (D1); not SpacetimeDB',
            deploymentMode:'hosted-simulation',liveVoiceEnabled:false});
        }
        const after = JSON.stringify(snapshot);
        if (after !== before) {
          const result = row
            ? await database.prepare('UPDATE worker_state SET revision = ?, snapshot_json = ? WHERE id = ? AND revision = ?')
              .bind(row.revision + 1,after,id,row.revision).run()
            : await database.prepare('INSERT INTO worker_state (id, revision, snapshot_json) VALUES (?, 1, ?) ON CONFLICT(id) DO NOTHING')
              .bind(id,after).run();
          if (result?.meta?.changes !== 1) continue;
        }
        return new Response(responseBody,{status,headers:responseHeaders});
      } catch {
        return json(503,{error:'The durable preview ledger could not confirm this operation. Please try again.'});
      }
    }
    return json(409,{error:'Another preview action changed this agreement. Refresh and retry.'});
  };
}
