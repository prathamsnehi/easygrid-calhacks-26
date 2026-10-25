import {mkdir, writeFile, copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

const destination = resolve(process.argv[2] ?? 'deploy/cloudflare/dist');
await mkdir(destination,{recursive:true});
execFileSync(process.execPath,['scripts/build-hosted-preview.mjs',resolve(destination,'_worker.js'),'--cloudflare'],{stdio:'inherit'});
// Pages advanced mode runs the Worker on all routes, including document GETs
// that issue the secure browser session before any API request is sent.
await writeFile(resolve(destination,'_routes.json'),JSON.stringify({version:1,include:['/*'],exclude:[]},null,2)+'\n');
await copyFile('apps/map-preview/dist/index.html',resolve(destination,'index.html'));
console.log(`Cloudflare Pages upload directory: ${destination}`);
