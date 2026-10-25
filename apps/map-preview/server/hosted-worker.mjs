import {createHostedPreview} from './hosted-preview.mjs';
import assets from 'easygrid:preview-assets';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const api = await createHostedPreview({database:env.DB})(request);
    if (api) return api;
    if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed',{status:405});
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const asset = assets[path];
    if (!asset) return new Response('Not found',{status:404});
    return new Response(request.method === 'HEAD' ? null : asset.body,{headers:{
      'content-type':asset.type,
      'cache-control':'private, no-store',
      'x-content-type-options':'nosniff',
      'referrer-policy':'same-origin',
    }});
  },
};
