import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';
import {build} from '../services/cartesia/node_modules/esbuild/lib/main.js';

// Build the normal map first. This produces the complete, dependency-free
// Worker source used by the Sites worker-esm starter; no credentials are copied.
const root = fileURLToPath(new URL('../',import.meta.url));
const destination = process.argv[2];
if (!destination) throw new Error('Usage: node scripts/build-hosted-preview.mjs /absolute/site/worker/index.js');
await import('../apps/map-preview/build.mjs');
const assets = {};
for (const name of ['index.html','contracts.html','parcel-fixtures.json','demo-handoff-example.json']) {
  let body = await readFile(resolve(root,'apps/map-preview/dist',name),'utf8');
  if (name.endsWith('.html')) {
    body = body.replace('Fictional site simulation','Hosted simulation · calls unavailable');
    body = body.replace('<div class="onboarding-brand">',
      '<p style="font-size:11px;line-height:1.6;color:#526548;margin:0 0 16px">Private demo · simulated agreements and payments. Live phone calls are not configured.</p><div class="onboarding-brand">');
  }
  assets[`/${name}`] = {body,type:name.endsWith('.html')?'text/html; charset=utf-8':'application/json; charset=utf-8'};
}
await mkdir(dirname(resolve(destination)),{recursive:true});
await build({
  entryPoints:[resolve(root,'apps/map-preview/server/hosted-worker.mjs')],
  outfile:resolve(destination),bundle:true,format:'esm',platform:'neutral',target:'es2022',
  external:['node:crypto','node:buffer'],
  mainFields:['module','main'],
  plugins:[{
    name:'hosted-preview-resources',
    setup(builder) {
      builder.onResolve({filter:/^easygrid:preview-assets$/},()=>({path:'assets',namespace:'easygrid'}));
      builder.onLoad({filter:/.*/,namespace:'easygrid'},()=>({contents:`export default ${JSON.stringify(assets)};`,loader:'js'}));
      builder.onResolve({filter:/^node:fs\/promises$/},()=>({path:'filesystem',namespace:'unsupported'}));
      builder.onLoad({filter:/.*/,namespace:'unsupported'},()=>({contents:
        'function unavailable(){throw new Error("Filesystem persistence is unavailable; a durable stateStore is required.")} export {unavailable as mkdir,unavailable as readFile,unavailable as writeFile,unavailable as rename};',loader:'js'}));
      builder.onResolve({filter:/^node:timers\/promises$/},()=>({path:'timers',namespace:'worker-timers'}));
      builder.onLoad({filter:/.*/,namespace:'worker-timers'},()=>({contents:
        'export const setTimeout = ms => new Promise(resolve => globalThis.setTimeout(resolve,ms));',loader:'js'}));
    },
  }],
});
console.log('Built hosted preview Worker with embedded map and contract assets.');
