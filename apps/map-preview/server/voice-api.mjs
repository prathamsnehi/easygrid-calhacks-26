import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';

const COOKIE = 'easygrid_voice_client';
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const json = (res, code, body) => res.writeHead(code, {'content-type':'application/json; charset=utf-8',
  'cache-control':'no-store', 'x-content-type-options':'nosniff'}).end(JSON.stringify(body));
const sign = (secret, value) => createHmac('sha256', secret).update(`voice-client:${value}`).digest('base64url');
function equal(a, b) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
async function readBody(req,limit=32768) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request too large.');
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid request.');
  return body;
}

/** Only the two authenticated Cartesia callback paths may be publicly proxied.
 * All browser endpoints remain bound to the local preview host and signed cookie.
 */
export function createVoiceAPI({coordinator = null, secret, port = 4177, reason = 'Live voice is not configured.',
  pollIntervalMs = 2000, procedureConfig = null} = {}) {
  if (coordinator && (typeof secret !== 'string' || secret.length < 32)) throw new Error('A stable private voice secret is required.');
  const localHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const streams = new Set(); let polling = false, stopped = false;
  function client(req, res) {
    const value = String(req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (value) {
      const match = /^([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{43})$/.exec(value);
      if (match && equal(match[2], sign(secret, match[1]))) return match[1];
    }
    const id = randomBytes(24).toString('base64url');
    res.setHeader('set-cookie', `${COOKIE}=${id}.${sign(secret,id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
    return id;
  }
  async function poll() {
    if (!coordinator || polling || stopped) return;
    polling = true;
    try {
      // A saved dispatching/unknown attempt is inspected, never dispatched again.
      for (const id of await coordinator.listPendingIds()) {
        if (stopped) break;
        try { await coordinator.refresh(id); } catch { /* Saved state stays authoritative on outages. */ }
      }
    } catch { /* Connection loss does not grant a new call or an approval. */ }
    finally { polling = false; }
  }
  const timer = coordinator && pollIntervalMs > 0 ? setInterval(poll,pollIntervalMs) : null;
  timer?.unref();
  const handler = async (req, res, pathname) => {
    if (!pathname.startsWith('/api/voice/')) return false;
    const tool = /^\/api\/voice\/tools\/(counteroffer|response)$/.exec(pathname);
    if (tool) {
      if (!coordinator) {json(res,503,{error:'Live voice is unavailable.'}); return true;}
      if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json') ||
        typeof req.headers.authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(req.headers.authorization)) {
        json(res,403,{error:'Authenticated provider request required.'}); return true;
      }
      try {
        const input = await readBody(req);
        const result = await coordinator.tool({authorization:req.headers.authorization,input,kind:tool[1],providerCallId:req.headers['x-easygrid-call']});
        json(res,200,result);
      } catch {json(res,409,{error:'The tool result was not confirmed. Keep this call pending for review.'});}
      return true;
    }
    if (!localHosts.has(req.headers.host) || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) ||
      ['cross-site','same-site'].includes(req.headers['sec-fetch-site'])) {
      json(res,403,{error:'Same-origin local preview access required.'}); return true;
    }
    if (req.method === 'GET' && pathname === '/api/voice/config') {
      if(procedureConfig){
        json(res,200,{enabled:true,mode:'database-procedure',...procedureConfig,
          reason:'Cartesia call with post-call review; agreement and payment integration remain separate.',language:'en'});
        return true;
      }
      if (coordinator) client(req,res);
      json(res,200,{enabled:!!coordinator,mode:coordinator?'live':'unavailable',
        reason:coordinator?'Cartesia calls with saved SpacetimeDB results.':reason,
        paymentSchedule:'full-after-signatures',conditionalScope:'verified tower placement within the original parcel',language:'en'});
      return true;
    }
    if (!coordinator) {json(res,503,{error:'Live voice is unavailable. Finish server configuration first.'}); return true;}
    const clientId = client(req,res);
    if (req.method === 'GET' && pathname === '/api/voice/active') {
      try {json(res,200,{active:await coordinator.getActive({clientId})});}
      catch {json(res,503,{error:'The saved demo could not be restored.'});}
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/voice/calls') {
      if (!String(req.headers['content-type']).startsWith('application/json') || req.headers['x-easygrid-demo'] !== '1') {
        json(res,403,{error:'Same-origin development request required.'}); return true;
      }
      try {
        const body = await readBody(req,256000);
        if (Object.keys(body).some(key => !['context','participant','requestKey'].includes(key))) throw new Error('Unexpected fields.');
        const event = await coordinator.start({clientId,...body});
        json(res,200,{attemptId:event.attemptId,status:event.status});
      } catch {json(res,409,{error:'The saved call could not be confirmed. Check the current attempt before continuing.'});}
      return true;
    }
    if (req.method === 'GET' && ['/api/voice/attempt','/api/voice/events'].includes(pathname)) {
      const query = new URL(req.url,'http://localhost').searchParams;
      const sessionId = query.get('sessionId');
      if (!SESSION.test(sessionId ?? '') || [...query.keys()].some(key=>key!=='sessionId') || query.getAll('sessionId').length !== 1) {
        json(res,400,{error:'A valid session reference is required.'}); return true;
      }
      if (pathname === '/api/voice/attempt') {
        try {json(res,200,{attempt:await coordinator.getResult({clientId,sessionId})});}
        catch {json(res,503,{error:'Saved voice state is unavailable.'});}
        return true;
      }
      let unsubscribe, heartbeat, closed = false;
      const close = () => {if(closed)return;closed=true;clearInterval(heartbeat);unsubscribe?.();streams.delete(close);res.end();};
      try {
        const initial = await coordinator.getResult({clientId,sessionId});
        res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','connection':'keep-alive','x-accel-buffering':'no'});
        res.flushHeaders?.();
        const send = event => {if(!closed && event)res.write(`data: ${JSON.stringify(event)}\n\n`);};
        streams.add(close); req.on('close',close);
        send(initial);
        unsubscribe = await coordinator.subscribe({clientId,sessionId},send);
        if(closed)unsubscribe?.();
        heartbeat = setInterval(()=>{if(!closed)res.write(': keepalive\n\n');},15000); heartbeat.unref();
      } catch {if(!res.headersSent)json(res,503,{error:'Saved voice state is unavailable.'});close();}
      return true;
    }
    json(res,404,{error:'Unknown voice operation.'}); return true;
  };
  handler.close = () => {stopped=true;clearInterval(timer);for(const close of streams)close();coordinator?.close();};
  handler.poll = poll;
  return handler;
}
