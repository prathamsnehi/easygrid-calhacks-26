import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createWorld } from './src/world.js';
import { createPlacement } from './src/placement.js';
import { computeTransmissionRoutes } from './src/routing.js';
import { analyzeRouteParcels } from './src/parcel-analysis.js';
import { createHandoff } from './src/handoff.js';

const root=dirname(fileURLToPath(import.meta.url));
const names=['cost-model.js','offer-policy.js','parcels.js','world.js','landscape.js','facility-models.js','placement.js','routing-constraints.js','routing.js','parcel-analysis.js','handoff.js','transmission-models.js','planner.js','route-controller.js','settlement-controller.js','demo-agreements.js','negotiation-controller.js','negotiation-result-controller.js','contract-authoring.js','contract-handoff.js','contract-api-client.js','contract-workspace.js','contract-entry.js','analysis-controller.js','voice-client.js','voice-host.js','main.js'];
const [vendor,template,styles,contractStyles,contractWorkspace,contractTemplate,...sources]=await Promise.all([
  readFile(join(root,'vendor/three.cjs'),'utf8'),
  readFile(join(root,'src/index.html'),'utf8'),
  readFile(join(root,'src/styles.css'),'utf8'),
  readFile(join(root,'src/contract-styles.css'),'utf8'),
  readFile(join(root,'src/contract-workspace.html'),'utf8'),
  readFile(join(root,'src/contract-demo.html'),'utf8'),
  ...names.map(name=>readFile(join(root,'src',name),'utf8')),
]);
// Keep module scopes separate while producing one offline-capable HTML file.
const bundleModules=(moduleNames,moduleSources)=>moduleSources.map((source,index)=>{
  const exports=[...source.matchAll(/^export\s+(?:async\s+)?(?:const|let|function|class)\s+(\w+)/gm)].map(match=>match[1]);
  const body=source
    .replace(/^import \* as THREE from 'three';\s*$/gm,'')
    .replace(/^import\s*\{([^}]+)\}\s*from\s*['"]\.\/([^'"]+)['"];?\s*$/gm,(_,bindings,name)=>`const {${bindings}} = modules[${JSON.stringify(name)}];\n`)
    .replace(/^export\s/gm,'');
  return `modules[${JSON.stringify(moduleNames[index])}] = (() => {\n${body}\nreturn {${exports.join(',')}};\n})();`;
}).join('\n');
const bundled=bundleModules(names,sources);
const script=`(() => {\nconst THREE=(() => {const exports={};\n${vendor}\nreturn exports;})();\ntry {\nconst modules=Object.create(null);\n${bundled}\n} catch(error) {console.error(error);document.documentElement.dataset.mapError=error.message;document.querySelector('#error').hidden=false;}\n})();`;
const html=template.replace('/* APP_STYLES */',()=>styles+'\n'+contractStyles).replace('<!-- CONTRACT_WORKSPACE -->',()=>contractWorkspace).replace('<!-- APP_SCRIPT -->',()=>`<script>${script.replace(/<\/script/gi,'<\\/script')}</script>`);
const contractNames=['contract-authoring.js','contract-fixtures.js','contract-api-client.js','contract-workspace.js','contract-demo.js'];
const contractSources=await Promise.all(contractNames.map(name=>readFile(join(root,'src',name),'utf8')));
const contractScript=`(() => {const modules=Object.create(null);\n${bundleModules(contractNames,contractSources)}\n})();`;
const contractHTML=contractTemplate.replace('/* CONTRACT_STYLES */',()=>contractStyles).replace('<!-- CONTRACT_WORKSPACE -->',()=>contractWorkspace).replace('<!-- CONTRACT_SCRIPT -->',()=>`<script>${contractScript.replace(/<\/script/gi,'<\\/script')}</script>`);
const world=createWorld();
const fixtures={schemaVersion:1,fixtureVersion:world.parcelFixtureVersion,sourceMode:'fixture',
  coordinateSystem:'local-demo-grid',width:world.width,depth:world.depth,tileCount:world.tiles.length,
  owners:world.owners,parcels:world.parcels};
await mkdir(join(root,'dist'),{recursive:true});
await writeFile(join(root,'dist/index.html'),html);
await writeFile(join(root,'dist/contracts.html'),contractHTML);
await writeFile(join(root,'dist/parcel-fixtures.json'),JSON.stringify(fixtures,null,2)+'\n');
const substation=createPlacement(world,'substation',-43,-17);
const placements={substation,datacenter:createPlacement(world,'datacenter',43,-17,{substation})};
const routes=computeTransmissionRoutes(world,placements);
const route=routes.candidates.find(candidate=>candidate.id===routes.recommendedId);
const example=createHandoff({world,route,placements,analysis:analyzeRouteParcels(world,route,routes.assumptions),
  sessionId:'example-cal-23',routeVersion:1});
await writeFile(join(root,'dist/demo-handoff-example.json'),JSON.stringify(example,null,2)+'\n');
await writeFile(join(root,'dist/voice-config.json'),await readFile(join(root,'voice-config.json')));
console.log(`Built standalone index.html (${Math.round(Buffer.byteLength(html)/1024)} KiB), ${world.parcels.length} fictional parcels and a redacted handoff example. No external requests required.`);
