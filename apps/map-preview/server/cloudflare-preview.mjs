import {createHash, randomBytes} from 'node:crypto';
import {createHostedPreview} from './hosted-preview.mjs';

const cookieName = '__Host-easygrid-demo';
const responseHeaders = {'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'same-origin'};
function readSession(request) {
  const values = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(`${cookieName}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(cookieName.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

/** Public synthetic demo. The random cookie is a browser-scoped capability,
 * not a verified person or permission to initiate live calls or payments.
 * Platform identity headers supplied by public clients are always ignored.
 */
export function createCloudflarePreview({database, assets}) {
  return async request => {
    const url = new URL(request.url);
    if (url.protocol !== 'https:') return new Response('HTTPS required.',{status:400,headers:responseHeaders});
    const session = readSession(request);
    if (url.pathname.startsWith('/api/')) {
      if (!session) return new Response(JSON.stringify({error:'Reload the demo to start a browser session.'}),
        {status:401,headers:{...responseHeaders,'content-type':'application/json; charset=utf-8'}});
      const owner = createHash('sha256').update(session).digest('hex');
      return createHostedPreview({database,resolveOwner:() => `browser:${owner}`,
        storageDescription:'durable browser-scoped demo ledger (D1); not SpacetimeDB'})(request);
    }
    if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed.',{status:405,headers:responseHeaders});
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const asset = Object.hasOwn(assets,path) ? assets[path] : null;
    if (!asset) return new Response('Not found.',{status:404,headers:responseHeaders});
    const headers = {...responseHeaders,'content-type':asset.type};
    // Only document GETs can establish a session. API mutations can never silently
    // switch ledgers when a cookie is missing, malformed or duplicated.
    if (!session && request.method === 'GET' && ['/', '/index.html','/contracts.html'].includes(url.pathname)) {
      headers['set-cookie'] = `${cookieName}=${randomBytes(32).toString('hex')}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`;
    }
    return new Response(request.method === 'HEAD' ? null : asset.body,{headers});
  };
}
