// Behavioral smoke checks only: no browser, DOM layout engine, or visual assertions.
// Build first so this exercises the exact standalone script delivered to the user.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from '../vendor/three.cjs';
import { createWorld } from '../src/world.js';
import { PLAN_STORAGE_KEY, createPlacement } from '../src/placement.js';
import { computeTransmissionRoutes } from '../src/routing.js';

const html=readFileSync(new URL('../dist/index.html',import.meta.url),'utf8');
const markup=html.slice(0,html.indexOf('<script>'));
const embedded=html.match(/<script>([\s\S]*)<\/script>/)?.[1];
assert(embedded?.includes("modules[\"planner.js\"]"),'Run npm run build before these tests.');
const hook='return exports;})();';
assert(embedded.includes(hook),'Standalone Three wrapper changed; update the test renderer hook.');
const worldHook='const landscape = createLandscape(THREE);';
assert(embedded.includes(worldHook),'World initialization changed; update the fixture hook.');
const compiled=new vm.Script(embedded
  .replace(hook,'return {...exports, WebGLRenderer: TestRenderer};})();')
  .replace(worldHook,`${worldHook}\nprepareWorld(landscape.world);`),{filename:'standalone-map.js'});
const expectedWorld=createWorld();

function boot({saved=new Map(),storageFails=false,prepareWorld=()=>{},rect={left:37,top:100,width:1100,height:700}}={}) {
  const errors=[],elements=new Map(),downloads=[];
  let currentScene,currentCamera,clock=1000;
  let timerSequence=0;
  const timers=new Map();
  let viewport={...rect};
  class Element {
    constructor(id,tag='') {
      this.id=id;this.dataset={};this.style={};this.attributes=new Map();this.listeners=new Map();
      this.hidden=/\shidden(?:\s|>)/.test(tag);this.disabled=/\sdisabled(?:\s|>)/.test(tag);
      this.children=[];this.parentNode=null;this.value='';this.checked=false;
      this.tagName=(tag.match(/^<(\w+)/)?.[1]??tag).toUpperCase();
      this.className=tag.match(/class="([^"]*)"/)?.[1]??'';this.textContent='';
      this.classList={
        add:name=>this.toggleClass(name,true),remove:name=>this.toggleClass(name,false),
        toggle:(name,force)=>this.toggleClass(name,force),contains:name=>this.className.split(' ').includes(name),
      };
    }
    get textContent(){return this._text+this.children.map(child=>typeof child==='string'?child:child.textContent).join('');}
    set textContent(value){this._text=String(value);this.children=[];}
    append(...children){for(const child of children){this.children.push(child);if(typeof child!=='string')child.parentNode=this;}}
    appendChild(child){this.append(child);return child;}
    replaceChildren(...children){this._text='';this.children=[];this.append(...children);}
    remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child=>child!==this);this.parentNode=null;}
    contains(node){return node===this||this.children.some(child=>typeof child!=='string'&&child.contains(node));}
    get firstChild(){return this.children[0]??null;}
    toggleClass(name,force) {
      const classes=new Set(this.className.split(' ').filter(Boolean));
      const enabled=force??!classes.has(name);enabled?classes.add(name):classes.delete(name);
      this.className=[...classes].join(' ');return enabled;
    }
    setAttribute(name,value){this.attributes.set(name,String(value));}
    getAttribute(name){return this.attributes.get(name)??null;}
    removeAttribute(name){this.attributes.delete(name);}
    addEventListener(name,handler){if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(handler);}
    emit(type,values={}){const event={type,target:this,currentTarget:this,preventDefault(){},stopPropagation(){},...values};for(const handler of this.listeners.get(type)??[])handler(event);}
    click(){if(!this.disabled){if(this.tagName==='A'&&this.download)downloads.push({filename:this.download,url:this.href});this.emit('click');}}
    focus(){document.activeElement=this;}
    scrollIntoView(){}
    setPointerCapture(){}
    getBoundingClientRect(){return{...viewport,right:viewport.left+viewport.width,bottom:viewport.top+viewport.height};}
    get clientWidth(){return viewport.width;}
    get clientHeight(){return viewport.height;}
  }
  for(const match of markup.matchAll(/<[a-z][^>]*\bid="([^"]+)"[^>]*>/g))elements.set(match[1],new Element(match[1],match[0]));
  const canvas=elements.get('map-canvas');
  const document={
    documentElement:{dataset:{}},hidden:false,activeElement:null,body:new Element('body','body'),listeners:new Map(),
    querySelector:selector=>selector==='canvas'?canvas:elements.get(selector.slice(1)),
    querySelectorAll:selector=>{assert.equal(selector,'[id]');return[...elements.values()];},
    createElement:tag=>new Element('',tag),
    addEventListener:Element.prototype.addEventListener,
    emit:Element.prototype.emit,
  };
  const window=new Element('window');
  window.devicePixelRatio=1;
  window.crypto={randomUUID:()=> '10e8be2e-334e-4e12-97a9-e8053585587f'};
  window.localStorage={
    getItem(key){if(storageFails)throw new Error('storage unavailable');return saved.get(key)??null;},
    setItem(key,value){if(storageFails)throw new Error('storage unavailable');saved.set(key,value);},
  };
  class TestRenderer {
    constructor(){this.shadowMap={};this.info={render:{calls:0,triangles:0}};}
    setPixelRatio(){}
    setSize(){}
    render(scene,camera){scene.updateMatrixWorld(true);camera.updateMatrixWorld(true);currentScene=scene;currentCamera=camera;}
  }
  class ClockDate extends Date {static now(){return clock;}}
  const blobs=new Map();
  class TestURL extends URL {
    static createObjectURL(blob){const key=`blob:test-${blobs.size+1}`;blobs.set(key,blob);return key;}
    static revokeObjectURL(){}
  }
  const context=vm.createContext({
    document,window,TestRenderer,prepareWorld,AbortController,AbortSignal,Blob,URL:TestURL,Date:ClockDate,performance:{now:()=>clock},
    matchMedia:()=>({matches:true,addEventListener(){}}),
    requestAnimationFrame:()=>1,cancelAnimationFrame(){},
    setTimeout:(callback,delay=0,...args)=>{const id=++timerSequence;timers.set(id,{callback,args,at:clock+delay});return id;},
    clearTimeout:id=>timers.delete(id),
    console:{error:error=>errors.push(String(error)),warn(){},log(){}},
  });
  compiled.runInContext(context,{timeout:10000});
  assert.equal(document.documentElement.dataset.mapReady,'true',document.documentElement.dataset.mapError??errors.join('\n'));
  assert.equal(elements.get('error').hidden,true);
  const point=(x,z,y=1.5)=>{
    const p=new THREE.Vector3(x,y,z).project(currentCamera);
    return{clientX:viewport.left+(p.x+1)*viewport.width/2,clientY:viewport.top+(1-p.y)*viewport.height/2};
  };
  const input=(type,values={})=>canvas.emit(type,{pointerId:1,button:0,shiftKey:false,...values});
  return {
    canvas,elements,saved,errors,point,input,window,document,downloads,blobs,
    click:id=>elements.get(id).click(),
    advance:ms=>{clock+=ms;},
    scene:()=>currentScene,
    storage:()=>JSON.parse(saved.get(PLAN_STORAGE_KEY)),
    hover:(x,z)=>input('pointermove',point(x,z)),
    tap:(x,z)=>{const p=point(x,z);input('pointerdown',p);input('pointerup',p);},
    resize:rect=>{viewport={...rect};window.emit('resize');},
    pendingTimers:()=>timers.size,
    pendingCallbacks:()=>[...timers.values()].map(job=>()=>job.callback(...job.args)),
    async flushTimers(){
      let runs=0;
      while(timers.size){
        assert(runs++<50,'timer queue must settle');
        const [id,job]=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
        timers.delete(id);clock=Math.max(clock,job.at);
        await job.callback(...job.args);
        await Promise.resolve();
      }
    },
  };
}

test('standalone planner completes A then B, inspection, edit, reload and reset',()=>{
  const app=boot();
  assert.equal(app.canvas.dataset.placementCount,'0');
  assert.equal(app.elements.get('step-b').disabled,true);
  app.click('step-b');assert.equal(app.canvas.dataset.plannerMode,'substation');
  app.click('next-site');
  assert.equal(app.canvas.dataset.previewValid,'true');
  app.click('confirm-placement');
  assert.equal(app.canvas.dataset.placementCount,'1');
  assert.equal(app.canvas.dataset.plannerMode,'datacenter');
  assert.equal(app.elements.get('step-b').disabled,false);
  app.click('next-site');app.click('confirm-placement');
  assert.equal(app.canvas.dataset.placementCount,'2');
  assert.equal(app.canvas.dataset.plannerMode,'overview');
  assert(Math.sign(app.storage().substation.x)!==Math.sign(app.storage().datacenter.x));
  assert.equal(app.scene().getObjectByName('substation').visible,true);
  assert.equal(app.scene().getObjectByName('datacenter').visible,true);
  app.click('inspect-parcels');
  assert.equal(app.elements.get('parcel-details').hidden,false);
  assert.match(app.elements.get('owner-email').textContent,/@example\.com$/);
  assert.match(app.elements.get('owner-phone').textContent,/demo/);
  assert.equal(app.scene().getObjectByName('Fictional property boundaries').visible,true);
  const previous=app.storage();
  app.click('step-a');app.click('next-site');
  assert.deepEqual(app.storage(),previous,'preview must preserve the committed plan');
  app.click('confirm-placement');
  assert.notDeepEqual(app.storage().substation,previous.substation);
  assert.deepEqual(app.storage().datacenter,previous.datacenter);
  const reloaded=boot({saved:app.saved});
  assert.equal(reloaded.canvas.dataset.placementCount,'2');
  assert.equal(reloaded.canvas.dataset.plannerMode,'overview');
  assert.equal(reloaded.scene().getObjectByName('substation').position.x,app.storage().substation.x);
  reloaded.click('reset-plan');
  assert.equal(reloaded.canvas.dataset.placementCount,'0');
  assert.equal(reloaded.storage().substation,null);assert.equal(reloaded.storage().datacenter,null);
  assert.equal(reloaded.elements.get('step-b').disabled,true);
});

function placePair(app) {
  app.click('next-site');app.click('confirm-placement');
  app.click('next-site');app.click('confirm-placement');
}
function expectedRoutes(app) {
  const saved=app.storage();
  const substation=createPlacement(expectedWorld,'substation',saved.substation.x,saved.substation.z);
  const datacenter=createPlacement(expectedWorld,'datacenter',saved.datacenter.x,saved.datacenter.z,{substation});
  return computeTransmissionRoutes(expectedWorld,{substation,datacenter});
}
const networkOf=app=>app.scene().getObjectByName('Transmission network');
const usd=cents=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(cents/100);

test('A/B completion automatically selects and renders the lowest modeled cost route',async()=>{
  const app=boot();
  assert.equal(app.canvas.dataset.routeState,'incomplete');
  assert.equal(app.pendingTimers(),0);
  assert.equal(app.elements.get('step-route').disabled,true);
  app.click('next-site');app.click('confirm-placement');
  assert.equal(app.canvas.dataset.routeState,'incomplete');
  app.click('next-site');app.click('confirm-placement');
  assert.equal(app.canvas.dataset.routeState,'calculating');
  assert.equal(app.pendingTimers(),1);
  assert.equal(networkOf(app).children.length,0);
  assert.equal(app.elements.get('route-panel').hidden,false);
  await app.flushTimers();
  assert.equal(app.canvas.dataset.routeState,'ok',app.errors.join('\n'));
  assert.equal(app.pendingTimers(),0);
  const expected=expectedRoutes(app);
  const route=expected.candidates.find(candidate=>candidate.id===expected.recommendedId);
  assert.equal(app.canvas.dataset.routeId,route.id);
  assert.equal(networkOf(app).userData.routeId,route.id);
  assert(networkOf(app).getObjectByName('Three-phase conductors')?.isMesh);
  assert.equal(networkOf(app).userData.diagnostics.pylonCount,route.metrics.towerCount);
  assert.equal(app.canvas.dataset.routeTotalCents,String(route.totalCostCents));
  assert.equal(app.elements.get('cost-total').textContent,usd(route.totalCostCents));
  assert.equal(app.elements.get('route-parcels').textContent,route.parcelIds.join(' · '));
  const amounts=['cost-line','cost-structures','cost-impact','cost-land','cost-rent'].map(id=>Math.round(Number(app.elements.get(id).textContent.replace(/[^\d.]/g,''))*100));
  assert.equal(amounts.reduce((sum,value)=>sum+value,0),route.totalCostCents);
  assert.equal(app.elements.get('route-choice-0').attributes.get('aria-pressed'),'true');
  assert.match(app.elements.get('route-status-note').textContent,/not an approval/i);
  for(const element of app.elements.values())assert(!/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u.test(element.textContent),element.id);
  assert.deepEqual(app.errors,[]);
});

test('manual route comparison updates physical geometry, prices and the selected button together',async()=>{
  const app=boot();placePair(app);await app.flushTimers();
  const routes=expectedRoutes(app).candidates;
  assert(routes.length>1,'the comparison fixture must include alternatives');
  const previous=networkOf(app).getObjectByName('Three-phase conductors');
  let disposed=0;previous.geometry.addEventListener('dispose',()=>disposed++);
  app.click('route-choice-1');
  assert.equal(app.canvas.dataset.routeId,routes[1].id);
  assert.equal(networkOf(app).userData.routeId,routes[1].id);
  assert.equal(app.elements.get('cost-total').textContent,usd(routes[1].totalCostCents));
  assert.equal(app.elements.get('route-choice-1').attributes.get('aria-pressed'),'true');
  assert.equal(app.elements.get('route-choice-0').attributes.get('aria-pressed'),'false');
  assert.equal(disposed,1);
  app.click('inspect-parcels');assert.equal(app.elements.get('route-panel').hidden,true);
  app.click('step-route');assert.equal(app.elements.get('route-panel').hidden,false);
  assert.equal(app.canvas.dataset.routeId,routes[1].id,'opening the route panel preserves the comparison');
});

test('moving a facility invalidates the route immediately and reset defeats stale queued work',async()=>{
  const app=boot();placePair(app);await app.flushTimers();
  const oldNodes=JSON.stringify(networkOf(app).userData.nodes);
  app.click('step-a');app.click('next-site');
  assert.equal(JSON.stringify(networkOf(app).userData.nodes),oldNodes,'a preview does not replace the committed route');
  app.click('confirm-placement');
  assert.equal(app.canvas.dataset.routeState,'calculating');
  assert.equal(networkOf(app).children.length,0);
  assert.equal(app.canvas.dataset.routeId,'');
  assert.equal(app.canvas.dataset.routeParcelIds,'');
  assert.equal(app.canvas.dataset.routeTotalCents,'');
  assert.equal(app.canvas.dataset.routeMinClearance,'');
  await app.flushTimers();
  assert.equal(app.canvas.dataset.routeState,'ok');
  assert.notEqual(JSON.stringify(networkOf(app).userData.nodes),oldNodes);
  const latest=expectedRoutes(app);
  const expected=latest.candidates.find(route=>route.id===latest.recommendedId);
  assert.equal(networkOf(app).userData.nodes[0].x,expected.nodes[0].x);
  assert.equal(networkOf(app).userData.nodes[0].z,expected.nodes[0].z);
  app.click('recalculate-route');
  const stale=app.pendingCallbacks();assert.equal(stale.length,1);
  app.click('reset-plan');
  assert.equal(app.canvas.dataset.routeState,'incomplete');
  assert.equal(app.pendingTimers(),0);
  await stale[0]();await app.flushTimers();
  assert.equal(networkOf(app).children.length,0);
  assert.equal(app.canvas.dataset.routeId,'');
  assert.equal(app.canvas.dataset.routeCandidateCount,'0');
  assert.equal(app.elements.get('step-route').disabled,true);
  assert.equal(app.elements.get('route-panel').hidden,true);
});

test('reload recomputes the route from restored endpoints rather than saving a stale network',async()=>{
  const original=boot();placePair(original);await original.flushTimers();
  const originalRoute=original.canvas.dataset.routeId,originalCost=original.canvas.dataset.routeTotalCents;
  assert(!('route' in original.storage()));
  const reloaded=boot({saved:original.saved});
  assert.equal(reloaded.canvas.dataset.routeState,'calculating');
  assert.equal(networkOf(reloaded).children.length,0);
  assert.equal(reloaded.pendingTimers(),1);
  await reloaded.flushTimers();
  assert.equal(reloaded.canvas.dataset.routeState,'ok');
  assert.equal(reloaded.canvas.dataset.routeId,originalRoute);
  assert.equal(reloaded.canvas.dataset.routeTotalCents,originalCost);
  assert(networkOf(reloaded).getObjectByName('Three-phase conductors'));
});

test('refused parcels produce an explicit no-route state with no physical transmission objects',async()=>{
  const app=boot({prepareWorld:world=>{for(const parcel of world.parcels)parcel.accessConsent='refused';}});
  placePair(app);await app.flushTimers();
  assert.equal(app.canvas.dataset.routeState,'no-route',app.errors.join('\n'));
  assert.equal(app.canvas.dataset.routeCandidateCount,'0');
  assert.equal(app.canvas.dataset.routeId,'');
  assert.equal(app.canvas.dataset.routeTotalCents,'');
  assert.equal(networkOf(app).children.length,0);
  assert.equal(app.elements.get('route-summary').hidden,true);
  assert.equal(app.elements.get('route-no-results').hidden,false);
  assert.match(app.elements.get('route-no-results').textContent,/no feasible connection/i);
  assert.equal(app.elements.get('recalculate-route').disabled,false);
  assert.deepEqual(app.errors,[]);
});

test('canvas offset and resized aspect ratio preserve terrain picking and parcel inspection',()=>{
  const app=boot();
  app.hover(43,17);
  let ghost=app.scene().getObjectByName('Preview substation');
  assert.equal(ghost.visible,true);assert.equal(ghost.position.x,43);assert.equal(ghost.position.z,17);
  app.resize({left:12,top:145,width:460,height:620});
  app.hover(-43,-17);
  ghost=app.scene().getObjectByName('Preview substation');
  assert.equal(ghost.position.x,-43);assert.equal(ghost.position.z,-17);
  app.click('inspect-parcels');app.hover(-43,-17);
  const parcel=expectedWorld.parcelById.get(expectedWorld.tileAt(-43,-17).parcelId);
  assert.equal(app.canvas.dataset.selectedParcel,parcel.id);
  assert.equal(app.elements.get('owner-name').textContent,parcel.ownerAlias);
  assert.equal(app.scene().getObjectByName('Selected fictional parcel').count,parcel.tileCount);
});

test('drags, right-clicks, cancellation and pinch releases never commit a facility',()=>{
  const app=boot();app.click('next-site');
  let p=app.point(-43,-17);
  app.input('pointerdown',p);app.input('pointermove',{...p,clientX:p.clientX+60});
  app.input('pointerup',{...p,clientX:p.clientX+60});
  assert.equal(app.canvas.dataset.placementCount,'0');
  p=app.point(-43,-17);
  app.input('pointerdown',{...p,button:2});app.input('pointerup',{...p,button:2});
  app.input('pointerdown',{...p,shiftKey:true});app.input('pointerup',{...p,shiftKey:true});
  app.input('pointerdown',p);app.input('pointercancel',p);app.input('pointerup',p);
  app.input('pointerdown',p);app.input('lostpointercapture',p);app.input('pointerup',p);
  assert.equal(app.canvas.dataset.placementCount,'0');
  app.input('pointerdown',{...p,pointerId:1});
  app.input('pointerdown',{...p,pointerId:2,clientX:p.clientX+80});
  app.input('pointermove',{...p,pointerId:2,clientX:p.clientX+100});
  app.input('pointerup',{...p,pointerId:1});
  app.input('pointerup',{...p,pointerId:2,clientX:p.clientX+100});
  assert.equal(app.canvas.dataset.placementCount,'0');
  app.click('next-site');
  const ghost=app.scene().getObjectByName('Preview substation');
  app.tap(ghost.position.x,ghost.position.z);
  assert.equal(app.canvas.dataset.placementCount,'1','a clean single tap still places');
});

test('water remains invalid and rapid follow-up taps cannot place B accidentally',()=>{
  const app=boot();app.hover(4,0);
  assert.equal(app.canvas.dataset.previewValid,'false');
  assert.equal(app.elements.get('confirm-placement').disabled,true);
  app.tap(4,0);assert.equal(app.canvas.dataset.placementCount,'0');
  app.tap(-43,-17);assert.equal(app.canvas.dataset.placementCount,'1');
  app.click('next-site');
  const ghost=app.scene().getObjectByName('Preview datacenter');
  const x=ghost.position.x,z=ghost.position.z;
  app.advance(100);app.tap(x,z);assert.equal(app.canvas.dataset.placementCount,'1');
  app.advance(400);app.tap(x,z);assert.equal(app.canvas.dataset.placementCount,'2');
});

test('unavailable storage reports the limitation but still allows placement',()=>{
  const app=boot({storageFails:true});
  assert.equal(app.elements.get('save-note').hidden,false);
  app.click('next-site');app.click('confirm-placement');
  assert.equal(app.canvas.dataset.placementCount,'1');
  assert.match(app.elements.get('save-note').textContent,/could not be saved/i);
  assert.deepEqual(app.errors,[]);
});

test('view reset, resize and leaving the canvas invalidate stale placement previews',()=>{
  const app=boot();
  app.click('next-site');assert.equal(app.canvas.dataset.previewValid,'true');
  app.click('reset-view');assert.equal(app.canvas.dataset.previewValid,'false');
  assert.equal(app.elements.get('confirm-placement').disabled,true);
  app.click('next-site');assert.equal(app.canvas.dataset.previewValid,'true');
  const ghost=app.scene().getObjectByName('Preview substation');
  const x=ghost.position.x,z=ghost.position.z;
  app.resize({left:12,top:145,width:460,height:620});
  assert.equal(app.canvas.dataset.previewValid,'false');
  app.hover(x,z);assert.equal(app.canvas.dataset.previewValid,'true');
  app.input('pointermove',{clientX:-20,clientY:-20});
  assert.equal(app.canvas.dataset.previewValid,'false');
  app.hover(x,z);assert.equal(app.canvas.dataset.previewValid,'true');
  app.input('pointermove',{clientX:NaN,clientY:NaN});
  assert.equal(app.canvas.dataset.previewValid,'false');
  app.click('confirm-placement');assert.equal(app.canvas.dataset.placementCount,'0');
});

const privateJudge={alias:'Private judge alias',phone:'+12025550123'};
const handoffOf=app=>app.window.easygridDemo.getHandoff();
const plain=value=>JSON.parse(JSON.stringify(value));
function enterJudge(app,{alias=privateJudge.alias,phone=privateJudge.phone,consent=true}={}) {
  for(const [id,value] of [['judge-alias',alias],['judge-phone',phone]]){
    const field=app.elements.get(id);field.value=value;field.emit('input');
  }
  const checkbox=app.elements.get('judge-consent');checkbox.checked=consent;checkbox.emit('change');
  app.elements.get('judge-form').emit('submit');
}
async function settlePromises(){for(let i=0;i<5;i++)await Promise.resolve();}

test('parcel analysis reconciles the selected route and reserves exactly one judge role before contact entry',async()=>{
  const app=boot();
  assert.equal(handoffOf(app),null);
  assert.equal(app.elements.get('open-analysis').disabled,true);
  placePair(app);await app.flushTimers();
  app.click('open-analysis');
  assert.equal(app.elements.get('analysis-panel').hidden,false);
  const handoff=handoffOf(app),route=handoff.snapshot.routes[0];
  assert.equal(route.id,app.canvas.dataset.routeId);
  assert.equal(handoff.parcelAnalysis.length,route.parcelIds.length);
  assert.equal(app.elements.get('analysis-parcel-list').children.length,route.parcelIds.length);
  assert.equal(app.elements.get('analysis-count').textContent,String(route.parcelIds.length));
  assert.equal(app.elements.get('analysis-upfront').textContent,usd(route.upfrontCompensationCents));
  assert.equal(app.elements.get('analysis-rent').textContent,usd(route.recurringRentTotalCents));
  assert.equal(handoff.parcelAnalysis.filter(row=>row.judgeRole).length,1);
  assert(route.parcelIds.includes(handoff.judgeRole.parcelId));
  assert.equal(handoff.judgeRole.participantReady,false);
  assert.equal(app.elements.get('prepare-handoff').disabled,true);
  assert.equal(app.elements.get('export-handoff').disabled,false);
  app.click('focus-judge-parcel');
  assert.match(app.elements.get('analysis-parcel-copy').textContent,new RegExp(handoff.judgeRole.parcelId));
  assert.equal(app.scene().getObjectByName('Selected fictional parcel').visible,true);
  app.click('close-analysis');
  assert.equal(app.elements.get('analysis-panel').hidden,true);
  assert.equal(app.document.activeElement,app.elements.get('open-analysis'));
  assert.deepEqual(app.errors,[]);
});

test('participant consent gates a private handoff while shared JSON and saved plans stay contact-redacted',async()=>{
  const app=boot();placePair(app);await app.flushTimers();app.click('open-analysis');
  enterJudge(app,{consent:false});
  assert.equal(handoffOf(app).judgeRole.participantReady,false);
  assert.equal(app.elements.get('prepare-handoff').disabled,true);
  enterJudge(app,{phone:'202-555-0123'});
  assert.equal(handoffOf(app).judgeRole.participantReady,false);
  enterJudge(app);
  assert.equal(handoffOf(app).judgeRole.participantReady,true);
  assert.equal(app.elements.get('prepare-handoff').disabled,true,'saving contact does not connect or call a backend');
  const serialized=JSON.stringify(handoffOf(app));
  for(const secret of Object.values(privateJudge)){
    assert(!serialized.includes(secret),'shareable handoff must not contain entered participant data');
    assert(!JSON.stringify([...app.saved]).includes(secret),'participant data must not enter local storage');
  }
  app.click('export-handoff');
  assert.equal(app.downloads.length,1);
  const exported=JSON.parse(await app.blobs.get(app.downloads[0].url).text());
  assert.deepEqual(exported,plain(handoffOf(app)));
  const field=app.elements.get('judge-phone');field.value='+12025550124';field.emit('input');
  assert.equal(handoffOf(app).judgeRole.participantReady,false,'an edit revokes the saved participant');
  assert.equal(app.elements.get('prepare-handoff').disabled,true);
  enterJudge(app);
  app.click('clear-judge');
  assert.equal(app.elements.get('judge-phone').value,'');
  assert.equal(app.elements.get('judge-consent').checked,false);
  assert.equal(handoffOf(app).judgeRole.participantReady,false);
  assert.deepEqual(app.errors,[]);
});

test('route changes invalidate prior handoffs, rebind the judge to an affected parcel and reset clears private contact',async()=>{
  const app=boot();placePair(app);await app.flushTimers();enterJudge(app);
  const prior=handoffOf(app);
  app.click('route-choice-1');
  const alternate=handoffOf(app);
  assert.notEqual(alternate.snapshot.routes[0].id,prior.snapshot.routes[0].id);
  assert(alternate.routeVersion>prior.routeVersion);
  assert.equal(alternate.parcelAnalysis.filter(row=>row.judgeRole).length,1);
  assert(alternate.snapshot.routes[0].parcelIds.includes(alternate.judgeRole.parcelId));
  assert.equal(alternate.judgeRole.participantReady,true);
  if(alternate.snapshot.routes[0].parcelIds.includes(prior.judgeRole.parcelId))assert.equal(alternate.judgeRole.parcelId,prior.judgeRole.parcelId);
  app.click('step-a');app.click('next-site');app.click('confirm-placement');
  assert.equal(handoffOf(app),null,'old route data must disappear during recalculation');
  assert.equal(app.elements.get('export-handoff').disabled,true);
  await app.flushTimers();
  const moved=handoffOf(app);
  assert.equal(moved.parcelAnalysis.filter(row=>row.judgeRole).length,1);
  assert(moved.snapshot.routes[0].parcelIds.includes(moved.judgeRole.parcelId));
  assert.equal(moved.judgeRole.participantReady,true);
  app.click('reset-plan');
  assert.equal(handoffOf(app),null);
  assert.equal(app.elements.get('judge-phone').value,'');
  assert.equal(app.elements.get('judge-alias').value,'');
  assert.equal(app.elements.get('judge-consent').checked,false);
  placePair(app);await app.flushTimers();
  assert.equal(handoffOf(app).judgeRole.participantReady,false);
  assert.deepEqual(app.errors,[]);
});

test('the host receives private contact only on explicit preparation and stale asynchronous completion is ignored',async()=>{
  const app=boot();placePair(app);await app.flushTimers();
  const calls=[];let finish;
  app.window.easygridDemo.setHandoffHandler(input=>{calls.push(input);return new Promise(resolve=>{finish=resolve;});});
  app.click('prepare-handoff');assert.equal(calls.length,0);
  enterJudge(app);
  assert.equal(calls.length,0,'saving participant data must never invoke the host');
  assert.equal(app.elements.get('prepare-handoff').disabled,false);
  app.click('prepare-handoff');await settlePromises();
  assert.equal(calls.length,1);
  assert.equal(calls[0].participant.phoneE164,privateJudge.phone);
  assert.equal(calls[0].participant.alias,privateJudge.alias);
  assert.equal(calls[0].participant.consent,true);
  assert(!JSON.stringify(calls[0].handoff).includes(privateJudge.phone));
  assert.equal(app.elements.get('prepare-handoff').disabled,true);
  app.click('prepare-handoff');assert.equal(calls.length,1,'a pending handoff cannot be submitted twice');
  app.click('reset-plan');
  assert.equal(calls[0].signal.aborted,true);
  const resetMessage=app.elements.get('handoff-result').textContent;
  finish({status:'prepared'});await settlePromises();
  assert.equal(app.elements.get('handoff-result').textContent,resetMessage,'late completion cannot restore stale success');
  assert.equal(handoffOf(app),null);
  assert.equal(app.elements.get('judge-phone').value,'');
  assert.deepEqual(app.errors,[]);
});

test('adapter failures do not expose private contact and page departure clears participant state',async()=>{
  const app=boot();placePair(app);await app.flushTimers();enterJudge(app);
  let calls=0;
  app.window.easygridDemo.setHandoffHandler(async()=>{calls++;throw new Error(`Provider rejected ${privateJudge.phone}`);});
  app.click('prepare-handoff');await settlePromises();
  assert.equal(calls,1);
  assert.match(app.elements.get('handoff-result').textContent,/failed|unable|could not|unavailable|did not confirm/i);
  assert(!app.elements.get('handoff-result').textContent.includes(privateJudge.phone));
  assert(!JSON.stringify(app.errors).includes(privateJudge.phone));
  app.window.emit('pagehide');
  assert.equal(app.elements.get('judge-phone').value,'');
  assert.equal(handoffOf(app).judgeRole.participantReady,false);
});

test('accepted handoff signals remain revocable after success on contact edits, route changes and reset',async()=>{
  const app=boot();placePair(app);await app.flushTimers();enterJudge(app);
  const accepted=[];
  app.window.easygridDemo.setHandoffHandler(async input=>{accepted.push(input);});
  app.click('prepare-handoff');await settlePromises();
  assert.equal(accepted.length,1);
  assert.equal(accepted[0].signal.aborted,false);
  assert.equal(app.elements.get('handoff-status-badge').textContent,'PREPARED');
  assert.equal(app.elements.get('prepare-handoff').disabled,true);
  const phone=app.elements.get('judge-phone');phone.value='+12025550124';phone.emit('input');
  assert.equal(accepted[0].signal.aborted,true,'contact edits revoke even a successfully prepared handoff');
  assert.equal(handoffOf(app).judgeRole.participantReady,false);
  enterJudge(app);app.click('prepare-handoff');await settlePromises();
  assert.equal(accepted.length,2);
  const priorVersion=accepted[1].handoff.routeVersion;
  app.click('route-choice-1');
  assert.equal(accepted[1].signal.aborted,true,'a changed selected route revokes its prepared handoff');
  assert(handoffOf(app).routeVersion>priorVersion);
  app.click('prepare-handoff');await settlePromises();
  assert.equal(accepted.length,3);
  assert.equal(accepted[2].signal.aborted,false);
  app.click('reset-plan');
  assert.equal(accepted[2].signal.aborted,true);
  assert.equal(handoffOf(app),null);
  assert.equal(app.elements.get('judge-phone').value,'');
  assert.deepEqual(app.errors,[]);
});

test('changing planner mode closes analysis and parcel inspection highlights the displayed owner',async()=>{
  const app=boot();placePair(app);await app.flushTimers();
  for(const id of ['step-a','step-b']){
    app.click('open-analysis');
    assert.equal(app.elements.get('analysis-panel').hidden,false);
    app.click(id);
    assert.equal(app.elements.get('analysis-panel').hidden,true);
    assert.equal(app.canvas.dataset.analysisParcel,'');
  }
  app.click('open-analysis');
  const judgeId=handoffOf(app).judgeRole.parcelId;
  app.click('inspect-parcels');
  assert.equal(app.elements.get('analysis-panel').hidden,true);
  assert.equal(app.canvas.dataset.analysisParcel,'');
  assert.equal(app.canvas.dataset.plannerMode,'inspect');
  app.click('reset-view');
  const point=[[-43,-17],[43,17]].find(([x,z])=>expectedWorld.tileAt(x,z).parcelId!==judgeId);
  app.hover(...point);
  const parcel=expectedWorld.parcelById.get(expectedWorld.tileAt(...point).parcelId);
  assert.equal(app.canvas.dataset.selectedParcel,parcel.id);
  assert.equal(app.elements.get('owner-name').textContent,parcel.ownerAlias);
  const highlight=app.scene().getObjectByName('Selected fictional parcel'),matrix=new THREE.Matrix4();
  assert.equal(highlight.visible,true);assert.equal(highlight.count,parcel.tileCount);
  highlight.getMatrixAt(0,matrix);
  const firstTile=expectedWorld.tiles.find(tile=>tile.parcelId===parcel.id);
  assert.equal(matrix.elements[12],firstTile.x);assert.equal(matrix.elements[14],firstTile.z);
  for(const key of ['1','2']){
    app.click('open-analysis');app.input('keydown',{key});
    assert.equal(app.elements.get('analysis-panel').hidden,true,`keyboard ${key} closes analysis`);
    assert.equal(app.canvas.dataset.analysisParcel,'');
  }
  assert.deepEqual(app.errors,[]);
});
