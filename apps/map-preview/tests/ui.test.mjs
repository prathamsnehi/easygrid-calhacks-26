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
const privateUser={alias:'Test User',phone:'+12025550123'};

function boot({saved=new Map(),storageFails=false,prepareWorld=()=>{},autoStart=true,panelRects={},rect={left:37,top:100,width:1100,height:700}}={}) {
  const errors=[],elements=new Map();
  let currentScene,currentCamera,clock=1000;
  let timerSequence=0;
  const timers=new Map();
  let viewport={...rect};
  const withEdges=rect=>({...rect,x:rect.left,y:rect.top,right:rect.left+rect.width,bottom:rect.top+rect.height});
  // Controlled layout inputs for camera math; this harness does not lay out CSS.
  function elementRect(element) {
    const analysisOpen=elements.get('demo-workspace')?.dataset.analysisOpen==='true';
    const cssHidden=(element.id==='context-card'&&element.classList.contains('overview'))||
      (['context-card','route-panel'].includes(element.id)&&analysisOpen);
    if(element.hidden||cssHidden)return withEdges({left:0,top:0,width:0,height:0});
    const configured=panelRects[element.id];
    if(configured)return withEdges(typeof configured==='function'?configured(viewport):configured);
    const {left,top,width,height}=viewport;
    const compactLandscape=width<=900&&width>height&&height<=400;
    if(element.id==='analysis-panel')return withEdges(width>900?
      {left:left+width-360,top:top+12,width:348,height:height-24}:
      compactLandscape?{left:left+width-width*.4-12,top:top+10,width:width*.4,height:height-22}:
      {left:left+12,top:top+height*.56,width:width-24,height:height*.44-12});
    if(element.id==='context-card')return withEdges(width>900?
      {left:left+24,top:top+height-304,width:312,height:280}:
      compactLandscape?{left:left+12,top:top+10,width:Math.min(312,width*.4),height:height-22}:
      {left:left+12,top:top+height*.57,width:width-24,height:height*.43-12});
    if(element.id==='route-panel')return withEdges(width>900?
      {left:left+width-350,top:top+14,width:326,height:height-98}:
      {left:left+12,top:top+height*.54,width:width-24,height:height*.46-12});
    return withEdges(viewport);
  }
  class Element {
    constructor(id,tag='') {
      this.id=id;this.dataset={};this.style={};this.attributes=new Map();this.listeners=new Map();
      this.hidden=/\shidden(?:\s|>)/.test(tag);this.disabled=/\sdisabled(?:\s|>)/.test(tag);
      this.inert=/\sinert(?:\s|>)/.test(tag);
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
    emit(type,values={}){
      const event={type,target:this,currentTarget:this,defaultPrevented:false,
        preventDefault(){this.defaultPrevented=true;},stopPropagation(){},stopImmediatePropagation(){this.immediatePropagationStopped=true;},...values};
      for(const handler of this.listeners.get(type)??[]){handler(event);if(event.immediatePropagationStopped)break;}
      return event;
    }
    click(){if(!this.disabled)this.emit('click');}
    focus(){document.activeElement=this;}
    scrollIntoView(){}
    setPointerCapture(){}
    getBoundingClientRect(){return elementRect(this);}
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
  const context=vm.createContext({
    document,window,TestRenderer,prepareWorld,AbortController,AbortSignal,Date:ClockDate,performance:{now:()=>clock},
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
  const app={
    canvas,elements,saved,errors,point,input,window,document,
    click:id=>elements.get(id).click(),
    advance:ms=>{clock+=ms;},
    scene:()=>currentScene,
    camera:()=>currentCamera,
    storage:()=>JSON.parse(saved.get(PLAN_STORAGE_KEY)),
    hover:(x,z)=>input('pointermove',point(x,z)),
    tap:(x,z)=>{const p=point(x,z);input('pointerdown',p);input('pointerup',p);},
    resize:rect=>{viewport={...rect};window.emit('resize');},
    pendingTimers:()=>timers.size,
    pendingCallbacks:()=>[...timers.values()].map(job=>()=>job.callback(...job.args)),
    async runTimersFor(ms){
      const deadline=clock+ms;let runs=0;
      while(timers.size){
        const [id,job]=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
        if(job.at>deadline)break;
        assert(runs++<50,'timer queue must settle');
        timers.delete(id);clock=Math.max(clock,job.at);
        await job.callback(...job.args);await Promise.resolve();
      }
      clock=Math.max(clock,deadline);
    },
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
  if(autoStart)enterUser(app);
  return app;
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
  const amounts=['cost-line','cost-structures','cost-impact','cost-engineering','cost-contingency','cost-land','cost-rent'].map(id=>Math.round(Number(app.elements.get(id).textContent.replace(/[^\d.]/g,''))*100));
  assert.equal(amounts.reduce((sum,value)=>sum+value,0),route.totalCostCents);
  assert.equal(app.elements.get('route-choice-0').attributes.get('aria-pressed'),'true');
  assert.match(app.elements.get('route-status-note').textContent,/^\d+ parcels awaiting consent$/);
  for(const id of ['route-reason','route-method-copy','route-rates','route-assumptions'])assert.equal(app.elements.has(id),false);
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

test('A/B route analysis stays visible for 1.6 seconds before revealing geometry, costs or handoff',async()=>{
  const app=boot();placePair(app);
  assert.equal(app.elements.get('route-loading').hidden,false);
  assert.equal(app.elements.get('route-panel').getAttribute('aria-busy'),'true');
  assert.equal(app.canvas.getAttribute('aria-busy'),'true');
  assert.equal(app.elements.get('route-summary').hidden,true);
  assert.equal(app.elements.get('recalculate-route').disabled,true);
  await app.runTimersFor(16); // The actual solver runs on the first yielded task.
  assert.equal(app.pendingTimers(),1,'only the result reveal remains queued');
  assert.equal(app.canvas.dataset.routeState,'calculating');
  assert.equal(app.canvas.dataset.routeCandidateCount,'0');
  assert.equal(networkOf(app).children.length,0);
  assert.equal(app.window.easygridDemo.getHandoff(),null);
  assert.equal(app.elements.get('open-analysis').disabled,true);
  app.click('step-route'); // Returning to the panel must not restart the delay.
  await app.runTimersFor(1583);
  assert.equal(app.canvas.dataset.routeState,'calculating','no result at 1599 ms');
  assert.equal(app.canvas.dataset.routeTotalCents,'');
  assert.equal(networkOf(app).children.length,0);
  await app.runTimersFor(1);
  assert.equal(app.canvas.dataset.routeState,'ok','result appears at 1600 ms');
  assert.equal(app.pendingTimers(),0);
  assert.equal(app.elements.get('route-loading').hidden,true);
  assert.equal(app.elements.get('route-summary').hidden,false);
  assert.equal(app.elements.get('route-panel').getAttribute('aria-busy'),'false');
  assert.equal(app.canvas.getAttribute('aria-busy'),'false');
  assert(networkOf(app).getObjectByName('Three-phase conductors'));
  assert(app.window.easygridDemo.getHandoff());
  assert.deepEqual(app.errors,[]);
});

test('computed but unrevealed routes cannot survive a site change, reset or participant edit',async()=>{
  const app=boot();placePair(app);await app.runTimersFor(16);
  const [oldReveal]=app.pendingCallbacks();
  app.click('step-a');app.click('next-site');app.click('confirm-placement');
  await oldReveal();
  assert.equal(app.canvas.dataset.routeState,'calculating');
  assert.equal(networkOf(app).children.length,0);
  assert.equal(app.pendingTimers(),1,'a stale callback cannot discard the newer calculation');
  await app.runTimersFor(1599);
  assert.equal(networkOf(app).children.length,0);
  await app.runTimersFor(1);
  const expected=expectedRoutes(app);
  assert.equal(app.canvas.dataset.routeId,expected.recommendedId);

  for(const action of ['reset-plan','edit-participant']){
    const pending=boot();placePair(pending);await pending.runTimersFor(16);
    const [reveal]=pending.pendingCallbacks();
    pending.click(action);
    assert.equal(pending.pendingTimers(),0);
    await reveal();await pending.flushTimers();
    assert.equal(pending.canvas.dataset.routeState,'incomplete');
    assert.equal(pending.elements.get('route-loading').hidden,true);
    assert.equal(pending.canvas.getAttribute('aria-busy'),'false');
    assert.equal(networkOf(pending).children.length,0);
    assert.equal(pending.window.easygridDemo.getHandoff(),null);
    assert.deepEqual(pending.errors,[]);
  }
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

test('one-finger dragging pans, two-finger dragging orbits and pinching zooms without accidental placement',()=>{
  const app=boot(),rect=app.canvas.getBoundingClientRect();
  const rotation=()=>{
    const q=app.camera().quaternion;return new THREE.Quaternion(q.x,q.y,q.z,q.w);
  };
  const touch=(pointerId,clientX,clientY)=>({pointerId,clientX,clientY,button:0,pointerType:'touch'});
  const x=rect.left+rect.width*.45,y=rect.top+rect.height*.45;
  const initialFocus=app.canvas.dataset.focus,initialRotation=rotation(),initialZoom=app.canvas.dataset.zoom;
  app.input('pointerdown',touch(1,x,y));
  app.input('pointermove',touch(1,x+80,y+30));
  app.input('pointerup',touch(1,x+80,y+30));
  assert.notEqual(app.canvas.dataset.focus,initialFocus,'a primary one-finger drag moves the map target');
  assert(rotation().angleTo(initialRotation)<1e-7,'panning preserves camera orientation');
  assert.equal(app.canvas.dataset.zoom,initialZoom);
  assert.equal(app.canvas.dataset.placementCount,'0');

  const orbitFocus=app.canvas.dataset.focus,orbitStart=rotation();
  app.input('pointerdown',touch(1,x-50,y));
  app.input('pointerdown',touch(2,x+50,y));
  app.input('pointermove',touch(1,x-30,y+12));
  app.input('pointermove',touch(2,x+70,y+12));
  assert(rotation().angleTo(orbitStart)>.02,'moving both fingers together changes the viewing angle');
  assert.equal(app.canvas.dataset.focus,orbitFocus,'two-finger orbit keeps the map target fixed');
  const pinchStartZoom=Number(app.canvas.dataset.zoom);
  app.input('pointermove',touch(1,x-50,y+12));
  app.input('pointermove',touch(2,x+90,y+12));
  assert(Number(app.canvas.dataset.zoom)>pinchStartZoom+.2,'spreading the fingers zooms in');
  assert.equal(app.canvas.dataset.focus,orbitFocus,'pinch zoom does not pan the target');
  app.input('pointerup',touch(1,x-50,y+12));
  app.input('pointerup',touch(2,x+90,y+12));
  assert.equal(app.canvas.dataset.placementCount,'0','ending a two-finger gesture cannot place a facility');

  for(const alternate of [{button:2},{button:0,shiftKey:true}]){
    const focus=app.canvas.dataset.focus,before=rotation(),mouse={pointerId:1,pointerType:'mouse',...alternate};
    app.input('pointerdown',{...mouse,clientX:x,clientY:y});
    app.input('pointermove',{...mouse,clientX:x+20,clientY:y+8});
    app.input('pointerup',{...mouse,clientX:x+20,clientY:y+8});
    assert(rotation().angleTo(before)>.02,'right-drag and Shift-drag provide mouse orbit alternatives');
    assert.equal(app.canvas.dataset.focus,focus);
    assert.equal(app.canvas.dataset.placementCount,'0');
  }

  app.click('next-site');
  const preview=app.scene().getObjectByName('Preview substation');
  app.tap(preview.position.x,preview.position.z);
  assert.equal(app.canvas.dataset.placementCount,'1','a later clean tap still places a facility');
  assert.deepEqual(app.errors,[]);
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

const handoffOf=app=>app.window.easygridDemo.getHandoff();
function enterUser(app,{alias=privateUser.alias,phone=privateUser.phone,consent=true}={}) {
  for(const [id,value] of [['user-alias',alias],['user-phone',phone]]){
    const field=app.elements.get(id);field.value=value;field.emit('input');
  }
  const checkbox=app.elements.get('user-consent');checkbox.checked=consent;checkbox.emit('input');
  app.elements.get('user-form').emit('submit');
}
async function settlePromises(){for(let i=0;i<5;i++)await Promise.resolve();}

test('parcel analysis reconciles the selected route and assigns the onboarded participant without re-entry',async()=>{
  const app=boot();
  assert.equal(handoffOf(app),null);
  assert.equal(app.elements.get('open-analysis').disabled,true);
  placePair(app);await app.flushTimers();
  app.click('open-analysis');
  assert.equal(app.elements.get('analysis-panel').hidden,false);
  const handoff=handoffOf(app),route=handoff.snapshot.routes[0];
  assert.equal(handoff.schemaVersion,2);
  assert.equal(route.id,app.canvas.dataset.routeId);
  assert.equal(handoff.parcelAnalysis.length,route.parcelIds.length);
  assert.equal(app.elements.get('analysis-parcel-list').children.length,route.parcelIds.length);
  assert.equal(app.elements.get('analysis-count').textContent,String(route.parcelIds.length));
  assert.equal(app.elements.get('analysis-upfront').textContent,usd(route.upfrontCompensationCents));
  assert.equal(app.elements.get('analysis-upfront-label').textContent,handoff.parcelAnalysis.some(row=>row.recommendationStatus==='review-required')?'Priced subtotal':'Recommended total');
  assert.equal(app.elements.get('analysis-rent').textContent,usd(route.recurringRentTotalCents));
  assert.equal(handoff.parcelAnalysis.filter(row=>row.userRole).length,1);
  assert(route.parcelIds.includes(handoff.userRole.parcelId));
  assert.equal(handoff.userRole.participantReady,true);
  assert.equal(app.elements.get('agent-call').disabled,true);
  assert.equal(app.elements.get('agent-call').textContent,'Agent call');
  assert.equal(app.elements.has('export-handoff'),false);
  assert.equal(app.elements.has('prepare-handoff'),false);
  assert(!/\bdownload(?:=|\s)/.test(markup),'the application has no download control');
  app.click('focus-user-parcel');
  assert.equal(app.elements.get('analysis-owner').textContent,privateUser.alias);
  assert.match(app.elements.get('analysis-parcel-copy').textContent,new RegExp(handoff.userRole.parcelId));
  const selected=handoff.parcelAnalysis.find(row=>row.parcelId===handoff.userRole.parcelId);
  assert.equal(app.elements.get('analysis-offer').textContent,usd(selected.upfrontCents));
  assert.equal(app.elements.get('analysis-limit').textContent,usd(selected.offerCapCents));
  assert.equal(app.elements.get('analysis-parcel-rent').textContent,`${selected.monthlyRentIsApproximate?'≈ ':''}${usd(selected.monthlyRentEquivalentCents)}`);
  assert.equal(app.elements.get('analysis-parcel-rent-label').textContent,'Monthly fee');
  assert.match(app.elements.get('analysis-line-length').textContent,/ m$/);
  assert.equal(app.elements.get('analysis-negotiation').textContent,'Pending');
  assert.equal(app.elements.get('handoff-status-badge').textContent,'OFFLINE');
  assert.match(markup,/<details class="analysis-breakdown"><summary>View breakdown<\/summary>/);
  for(const id of ['analysis-email','analysis-contact','user-contact-status','user-role-note','handoff-budget-note','registered-participant-consent']){
    assert.equal(app.elements.has(id),false,`${id} should not duplicate information in the compact panel`);
  }
  assert.equal(app.scene().getObjectByName('Selected fictional parcel').visible,true);
  app.click('close-analysis');
  assert.equal(app.elements.get('analysis-panel').hidden,true);
  assert.equal(app.document.activeElement,app.elements.get('open-analysis'));
  assert.deepEqual(app.errors,[]);
});

test('settlement stays locked until host approval, then lights up and is revoked on route or participant changes',async()=>{
  const app=boot(),api=app.window.easygridDemo;
  assert.equal(app.elements.get('settle-payment').disabled,true);
  placePair(app);await app.flushTimers();app.click('open-analysis');
  const packet=handoffOf(app);let request;
  api.setSettlementHandler(async input=>{request=input;return {status:'submitted',approvalId:input.approval.approvalId,
    requestKey:input.requestKey,requestId:'settlement-request-1'};});
  assert.equal(app.elements.get('settle-payment').disabled,true,'call consent is not settlement approval');
  const approval=()=>({approvalId:'approval-ui-1',packageHash:`sha256:${'a'.repeat(64)}`,simulated:true,mapBinding:api.getSettlementBinding()});
  api.setSettlementApproval(approval());
  assert.equal(app.elements.get('settle-payment').disabled,false);
  assert(app.elements.get('settle-payment').classList.contains('settlement-ready'));
  app.click('settle-payment');await settlePromises();
  assert.equal(app.elements.get('settle-payment').textContent,'Request sent');
  assert.equal(request.stage,'contract_tranche');assert(!('participant' in request));
  assert(!JSON.stringify(request).includes(privateUser.phone));assert(!JSON.stringify(request).includes(privateUser.alias));
  assert.equal(handoffOf(app).snapshot.project.status,packet.snapshot.project.status,'button never manufactures project approval');
  assert(handoffOf(app).ownerHandoff.parcels.every(p=>p.terms.outcome==='pending'));
  app.click('close-analysis');app.click('recalculate-route');
  assert.equal(app.elements.get('settle-payment').disabled,true);assert.equal(app.elements.get('settlement-status').textContent,'Awaiting approval');
  await app.flushTimers();
  api.setSettlementApproval({...approval(),approvalId:'approval-ui-2'});
  assert.equal(app.elements.get('settle-payment').disabled,false);
  app.click('edit-participant');assert.equal(app.elements.get('settle-payment').disabled,true);
  assert.equal(api.getSettlementBinding(),null);assert.deepEqual(app.errors,[]);
});

test('participant consent gates Agent call while public snapshots and saved plans stay contact-redacted',async()=>{
  const app=boot();placePair(app);await app.flushTimers();app.click('open-analysis');
  app.click('edit-analysis-participant');
  assert.equal(app.elements.get('demo-onboarding').hidden,false);
  assert.equal(app.elements.get('demo-workspace').inert,true);
  assert.equal(handoffOf(app),null,'opening participant editing revokes the current private handoff');
  assert.equal(networkOf(app).children.length,0);
  enterUser(app,{consent:false});
  assert.equal(handoffOf(app),null);
  assert.equal(app.elements.get('agent-call').disabled,true);
  enterUser(app,{phone:'555-0123'});
  assert.equal(handoffOf(app),null);
  enterUser(app);await app.flushTimers();
  assert.equal(handoffOf(app).userRole.participantReady,true);
  assert.equal(app.elements.get('agent-call').disabled,true,'saving contact does not connect or call a backend');
  const serialized=JSON.stringify(handoffOf(app));
  for(const secret of Object.values(privateUser)){
    assert(!serialized.includes(secret),'shareable handoff must not contain entered participant data');
    assert(!JSON.stringify([...app.saved]).includes(secret),'participant data must not enter local storage');
  }
  const field=app.elements.get('user-phone');field.value='+12025550124';field.emit('input');
  assert.equal(handoffOf(app),null,'an edit revokes the saved participant and its route handoff');
  assert.equal(app.elements.get('agent-call').disabled,true);
  enterUser(app);await app.flushTimers();
  app.click('clear-user');
  assert.equal(app.elements.get('user-phone').value,'');
  assert.equal(app.elements.get('user-consent').checked,false);
  assert.equal(handoffOf(app),null);
  assert.deepEqual(app.errors,[]);
});

test('route changes invalidate prior handoffs, preserve the original user role and reset clears private contact',async()=>{
  const app=boot();placePair(app);await app.flushTimers();
  const prior=handoffOf(app);
  app.click('route-choice-1');
  const alternate=handoffOf(app);
  assert.notEqual(alternate.snapshot.routes[0].id,prior.snapshot.routes[0].id);
  assert(alternate.routeVersion>prior.routeVersion);
  assert.equal(alternate.userRole.parcelId,prior.userRole.parcelId);
  assert.equal(alternate.parcelAnalysis.filter(row=>row.userRole).length,Number(alternate.userRole.roleOnRoute));
  assert.equal(alternate.userRole.roleOnRoute,alternate.snapshot.routes[0].parcelIds.includes(prior.userRole.parcelId));
  assert.equal(alternate.userRole.participantReady,true);
  app.click('step-a');app.click('next-site');app.click('confirm-placement');
  assert.equal(handoffOf(app),null,'old route data must disappear during recalculation');
  assert.equal(app.elements.get('agent-call').disabled,true);
  await app.flushTimers();
  const moved=handoffOf(app);
  assert.equal(moved.userRole.parcelId,prior.userRole.parcelId);
  assert.equal(moved.parcelAnalysis.filter(row=>row.userRole).length,Number(moved.userRole.roleOnRoute));
  assert.equal(moved.userRole.roleOnRoute,moved.snapshot.routes[0].parcelIds.includes(prior.userRole.parcelId));
  assert.equal(moved.userRole.participantReady,true);
  app.click('reset-plan');
  assert.equal(handoffOf(app),null);
  assert.equal(app.elements.get('user-phone').value,'');
  assert.equal(app.elements.get('user-alias').value,'');
  assert.equal(app.elements.get('user-consent').checked,false);
  placePair(app);await app.flushTimers();
  assert.equal(app.canvas.dataset.placementCount,'0','reset requires a new participant before placement');
  assert.equal(handoffOf(app),null);
  enterUser(app);placePair(app);await app.flushTimers();
  assert.equal(handoffOf(app).userRole.participantReady,true);
  assert.deepEqual(app.errors,[]);
});

test('refusal demo bypasses the original owner, simulates all new-route agreements and keeps settlement locked',async()=>{
  const app=boot();placePair(app);await app.flushTimers();
  const api=app.window.easygridDemo,before=handoffOf(app),original=before.userRole.parcelId;
  let calls=0;api.setHandoffHandler(async()=>{calls++;});
  api.setSettlementHandler(async()=>{throw new Error('No payment should be requested.');});
  api.setSettlementApproval({approvalId:'before-reroute',packageHash:`sha256:${'b'.repeat(64)}`,simulated:true,mapBinding:api.getSettlementBinding()});
  assert.equal(app.elements.get('simulate-refusal').disabled,false);
  app.click('simulate-refusal');
  assert.equal(api.getNegotiationState().phase,'rerouting');
  assert.equal(app.elements.get('settle-payment').disabled,true);
  assert.equal(app.canvas.dataset.previousRouteVisible,'true');
  assert.equal(app.scene().getObjectByName('Previous route').children.length,1);
  await app.runTimersFor(1600);
  assert.equal(api.getNegotiationState().phase,'negotiating');
  assert.match(app.elements.get('negotiation-reason').textContent,/simulated/);
  await app.flushTimers();
  const after=handoffOf(app),state=api.getNegotiationState(),agreed=api.getNegotiatedHandoff();
  assert.equal(state.phase,'confirmed',JSON.stringify(state));
  assert.equal(after.userRole.parcelId,original);assert.equal(after.userRole.roleOnRoute,false);
  assert.equal(after.userRole.liveCallLocked,true);
  assert(!after.snapshot.routes[0].parcelIds.includes(original));
  assert.notDeepEqual(after.snapshot.routes[0].geometry,before.snapshot.routes[0].geometry);
  assert(after.routeVersion>before.routeVersion);
  assert.equal(agreed.sourceMode,'mock');assert.equal(agreed.ownerHandoff.referenceBinding,'local-fixture');
  assert.equal(agreed.ownerHandoff.routeStatus,'ready_for_agreements');
  assert.equal(agreed.negotiations.length,after.snapshot.routes[0].parcelIds.length);
  assert(agreed.negotiations.every(n=>n.outcome==='accepted'&&n.sourceMode==='mock'&&n.parcelId!==original));
  assert.equal(app.elements.get('negotiation-new-cost').textContent,new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(agreed.totals.totalCostCents/100));
  assert.match(app.elements.get('negotiation-parcels').textContent,new RegExp(`Removed: .*${original}`));
  app.click('open-analysis');
  assert.match(app.elements.get('analysis-consent-note').textContent,/0 pending/);
  const row=app.elements.get('analysis-parcel-list').children[0];row.click();
  assert.equal(app.elements.get('analysis-negotiation').textContent,'Accepted · simulated');
  app.click('agent-call');assert.equal(calls,0);
  assert.equal(app.elements.get('settle-payment').disabled,true,'simulated owner agreement does not create manager approval');
  assert.equal(app.elements.get('simulate-refusal').disabled,true);
  assert(after.ownerHandoff.parcels.every(p=>p.terms.outcome==='pending'),'original map estimate stays separate from simulated agreements');
  for(const secret of Object.values(privateUser))assert(!JSON.stringify(agreed).includes(secret));
  app.click('close-analysis');app.click('recalculate-route');
  assert.equal(api.getNegotiatedHandoff(),null,'old-route agreement is revoked immediately');
  await app.runTimersFor(1600);
  assert.equal(api.getNegotiatedHandoff(),null,'a newly calculated route needs fresh agreements');
  await app.flushTimers();
  assert(!handoffOf(app).snapshot.routes[0].parcelIds.includes(original),'later recalculation preserves refusal');
  assert.equal(api.getNegotiatedHandoff().ownerHandoff.routeVersion,handoffOf(app).routeVersion);
  assert.equal(calls,0,'only fictional owners are simulated again');
  app.click('reset-plan');
  assert.equal(api.getNegotiationState().blockedParcelIds.length,0);
  assert.equal(app.scene().getObjectByName('Previous route').children.length,0);
  assert.deepEqual(app.errors,[]);
});

test('a host negotiation subscription disables fixture controls and is canceled on participant edits and departure',async()=>{
  const app=boot();placePair(app);await app.flushTimers();const api=app.window.easygridDemo;
  const subscriptions=[];let cleanupCount=0;
  api.setNegotiationSource(input=>{subscriptions.push(input);input.onReady();return()=>{cleanupCount++;};});
  await settlePromises();
  assert.equal(subscriptions.length,1);assert.equal(app.elements.get('simulate-refusal').hidden,true);
  assert.equal(api.getNegotiationState().connected,true);
  const initial=subscriptions[0];
  app.click('edit-participant');
  assert.equal(initial.signal.aborted,true);assert.equal(cleanupCount,1);
  assert.equal(initial.onUpdate({malformed:true}).status,'ignored');
  enterUser(app);await app.flushTimers();await settlePromises();
  assert.equal(subscriptions.length,2);assert.equal(subscriptions[1].signal.aborted,false);
  app.window.emit('pagehide');await settlePromises();
  assert.equal(subscriptions[1].signal.aborted,true);assert.equal(cleanupCount,2);
  assert.equal(api.getNegotiatedHandoff(),null);assert.deepEqual(app.errors,[]);
});

test('Agent call invokes the registered host only on click and ignores stale asynchronous completion',async()=>{
  const app=boot({autoStart:false});
  const calls=[];let finish;
  app.window.easygridDemo.setHandoffHandler(input=>{calls.push(input);return new Promise(resolve=>{finish=resolve;});});
  app.click('agent-call');assert.equal(calls.length,0);
  enterUser(app,{phone:'(202) 555-0123'});
  assert.equal(calls.length,0,'saving participant data must never invoke the host');
  assert.equal(app.elements.get('agent-call').disabled,true,'a current route is required before calling');
  placePair(app);await app.flushTimers();
  assert.equal(calls.length,0,'placing facilities must never invoke the host');
  assert.equal(app.elements.get('agent-call').disabled,false);
  app.click('agent-call');await settlePromises();
  assert.equal(calls.length,1);
  assert.equal(calls[0].participant.phoneE164,privateUser.phone);
  assert.equal(calls[0].participant.alias,privateUser.alias);
  assert.equal(calls[0].participant.consent,true);
  assert(!JSON.stringify(calls[0].handoff).includes(privateUser.phone));
  assert.equal(app.elements.get('agent-call').disabled,true);
  app.click('agent-call');assert.equal(calls.length,1,'a pending call request cannot be submitted twice');
  app.click('reset-plan');
  assert.equal(calls[0].signal.aborted,true);
  const resetMessage=app.elements.get('handoff-result').textContent;
  finish({status:'requested'});await settlePromises();
  assert.equal(app.elements.get('handoff-result').textContent,resetMessage,'late completion cannot restore stale success');
  assert.equal(handoffOf(app),null);
  assert.equal(app.elements.get('user-phone').value,'');
  assert.deepEqual(app.errors,[]);
});

test('adapter failures do not expose private contact and page departure clears participant state',async()=>{
  const app=boot();placePair(app);await app.flushTimers();
  let calls=0;
  app.window.easygridDemo.setHandoffHandler(async()=>{calls++;throw new Error(`Provider rejected ${privateUser.phone}`);});
  app.click('agent-call');await settlePromises();
  assert.equal(calls,1);
  assert.match(app.elements.get('handoff-result').textContent,/failed|unable|could not|unavailable|did not confirm/i);
  assert(!app.elements.get('handoff-result').textContent.includes(privateUser.phone));
  assert(!JSON.stringify(app.errors).includes(privateUser.phone));
  app.window.emit('pagehide');
  assert.equal(app.elements.get('user-phone').value,'');
  assert.equal(handoffOf(app),null);
});

test('accepted call request signals remain revocable after contact edits, route changes and reset',async()=>{
  const app=boot();placePair(app);await app.flushTimers();
  const accepted=[];
  app.window.easygridDemo.setHandoffHandler(async input=>{accepted.push(input);});
  app.click('agent-call');await settlePromises();
  assert.equal(accepted.length,1);
  assert.equal(accepted[0].signal.aborted,false);
  assert.equal(app.elements.get('handoff-status-badge').textContent,'REQUEST SENT');
  assert.equal(app.elements.get('handoff-result').textContent,'Call request sent to the agent.');
  assert.equal(app.elements.get('agent-call').disabled,true);
  app.click('agent-call');
  assert.equal(accepted.length,1,'an accepted call request cannot be submitted twice');
  const phone=app.elements.get('user-phone');phone.value='+12025550124';phone.emit('input');
  assert.equal(accepted[0].signal.aborted,true,'contact edits revoke even an accepted call request');
  assert.equal(handoffOf(app),null);
  enterUser(app);await app.flushTimers();app.click('agent-call');await settlePromises();
  assert.equal(accepted.length,2);
  const priorVersion=accepted[1].handoff.routeVersion;
  app.click('route-choice-1');
  assert.equal(accepted[1].signal.aborted,true,'a changed selected route revokes its accepted call request');
  assert(handoffOf(app).routeVersion>priorVersion);
  app.click('agent-call');await settlePromises();
  assert.equal(accepted.length,3);
  assert.equal(accepted[2].signal.aborted,false);
  app.click('reset-plan');
  assert.equal(accepted[2].signal.aborted,true);
  assert.equal(handoffOf(app),null);
  assert.equal(app.elements.get('user-phone').value,'');
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
  const userId=handoffOf(app).userRole.parcelId;
  app.click('inspect-parcels');
  assert.equal(app.elements.get('analysis-panel').hidden,true);
  assert.equal(app.canvas.dataset.analysisParcel,'');
  assert.equal(app.canvas.dataset.plannerMode,'inspect');
  app.click('reset-view');
  const point=[[-43,-17],[43,17]].find(([x,z])=>expectedWorld.tileAt(x,z).parcelId!==userId);
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

test('mandatory onboarding accepts a US national phone but still requires a name and roleplay consent',async()=>{
  const app=boot({autoStart:false}),modal=app.elements.get('demo-onboarding'),workspace=app.elements.get('demo-workspace');
  assert.equal(modal.hidden,false);assert.equal(workspace.inert,true);
  assert.equal(app.elements.get('user-alias').value,'');assert.equal(app.elements.get('user-phone').value,'');
  assert.equal(app.elements.get('user-consent').checked,false);
  assert.equal(handoffOf(app),null);assert.equal(app.pendingTimers(),0);
  const originalZoom=app.canvas.dataset.zoom;
  // This harness intentionally does not enforce inert: production handlers must also guard mutations.
  for(const id of ['next-site','confirm-placement','step-b','inspect-parcels','recalculate-route'])app.elements.get(id).emit('click');
  app.hover(-43,-17);app.tap(-43,-17);
  for(const key of ['1','2','Enter','+','ArrowLeft'])app.input('keydown',{key});
  app.input('wheel',{deltaY:-300,deltaMode:0});
  assert.equal(app.canvas.dataset.placementCount,'0');assert.equal(app.canvas.dataset.previewValid,'false');
  assert.equal(app.canvas.dataset.zoom,originalZoom);assert.equal(app.pendingTimers(),0);
  assert.equal(networkOf(app).children.length,0);
  const escape=app.document.emit('keydown',{key:'Escape'});
  assert.equal(escape.defaultPrevented,true);assert.equal(modal.hidden,false);
  for(const invalid of [{alias:''},{alias:'   '},{phone:'555-0123'},{consent:false}]){
    enterUser(app,invalid);
    assert.equal(modal.hidden,false);assert.equal(workspace.inert,true);
    assert.equal(handoffOf(app),null);assert.equal(app.pendingTimers(),0);
    app.elements.get('next-site').emit('click');app.elements.get('confirm-placement').emit('click');
    assert.equal(app.canvas.dataset.placementCount,'0');
  }
  enterUser(app,{phone:'202-555-0123',consent:false});
  assert.equal(modal.hidden,false);
  assert.equal(app.elements.get('user-phone').getAttribute('aria-invalid'),'false');
  assert.equal(app.elements.get('user-consent').getAttribute('aria-invalid'),'true');
  enterUser(app,{phone:'202-555-0123'});
  assert.equal(modal.hidden,true);assert.equal(workspace.inert,false);
  assert.equal(app.elements.get('user-phone').value,privateUser.phone);
  placePair(app);await app.flushTimers();app.click('open-analysis');
  const packet=handoffOf(app);
  assert.equal(packet.userRole.participantReady,true);
  assert.equal(packet.parcelAnalysis.filter(row=>row.userRole).length,1);
  assert(packet.snapshot.routes[0].parcelIds.includes(packet.userRole.parcelId));
  assert.equal(app.elements.get('analysis-owner').textContent,privateUser.alias);
  assert.equal(app.elements.get('analysis-parcel-list').children.filter(row=>row.textContent.startsWith(privateUser.alias)).length,1);
  assert(!JSON.stringify([...app.saved]).includes(privateUser.phone));
  assert(!JSON.stringify([...app.saved]).includes(privateUser.alias));
  assert.deepEqual(app.errors,[]);
});

test('restored facilities wait for fresh onboarding and no participant data survives reload',async()=>{
  const original=boot();placePair(original);await original.flushTimers();
  const plan=original.storage(),reloaded=boot({saved:original.saved,autoStart:false});
  assert.equal(reloaded.elements.get('demo-onboarding').hidden,false);
  assert.equal(reloaded.elements.get('demo-workspace').inert,true);
  assert.equal(reloaded.elements.get('user-alias').value,'');assert.equal(reloaded.elements.get('user-phone').value,'');
  assert.equal(reloaded.elements.get('user-consent').checked,false);
  assert.equal(reloaded.canvas.dataset.placementCount,'2');
  assert.equal(networkOf(reloaded).children.length,0);assert.equal(reloaded.pendingTimers(),0);
  assert.equal(handoffOf(reloaded),null);
  for(const id of ['recalculate-route','route-choice-1','step-a','next-site','confirm-placement'])reloaded.elements.get(id).emit('click');
  reloaded.tap(-43,17);reloaded.input('keydown',{key:'Enter'});
  assert.deepEqual(reloaded.storage(),plan);assert.equal(reloaded.pendingTimers(),0);
  enterUser(reloaded,{alias:'',consent:true});
  assert.equal(reloaded.pendingTimers(),0);assert.equal(handoffOf(reloaded),null);
  enterUser(reloaded);
  assert.equal(reloaded.elements.get('demo-onboarding').hidden,true);
  assert.equal(reloaded.pendingTimers(),1,'valid participant entry unlocks recomputation for restored sites');
  await reloaded.flushTimers();
  assert.equal(reloaded.canvas.dataset.routeState,'ok');
  assert.equal(handoffOf(reloaded).userRole.participantReady,true);
  assert.equal(handoffOf(reloaded).parcelAnalysis.filter(row=>row.userRole).length,1);
  reloaded.click('edit-participant');
  assert.equal(reloaded.elements.get('demo-onboarding').hidden,false);
  assert.equal(reloaded.elements.get('demo-workspace').inert,true);
  assert.equal(handoffOf(reloaded),null);
  assert.equal(networkOf(reloaded).children.length,0);
  assert.deepEqual(reloaded.errors,[]);
});

function parcelScreenBounds(app,parcelId) {
  const parcel=expectedWorld.parcelById.get(parcelId),tiles=expectedWorld.tiles.filter(tile=>tile.parcelId===parcelId);
  const heights=tiles.map(tile=>tile.terrain==='river'?.79:tile.height);
  const points=[];
  for(const x of [parcel.bounds.x0-.5,parcel.bounds.x1+.5]){
    for(const z of [parcel.bounds.z0-.5,parcel.bounds.z1+.5]){
      for(const y of [Math.min(...heights),Math.max(...heights)+1])points.push(app.point(x,z,y));
    }
  }
  return {left:Math.min(...points.map(p=>p.clientX)),right:Math.max(...points.map(p=>p.clientX)),
    top:Math.min(...points.map(p=>p.clientY)),bottom:Math.max(...points.map(p=>p.clientY))};
}
function remainingMapRect(app,panelId,side) {
  const canvas=app.canvas.getBoundingClientRect(),panel=app.elements.get(panelId).getBoundingClientRect();
  const free={left:canvas.left+24,right:canvas.right-24,top:canvas.top+(canvas.width<=900?52:24),bottom:canvas.bottom-52};
  if(side==='right')free.right=Math.min(free.right,panel.left-24);
  if(side==='left')free.left=Math.max(free.left,panel.right+24);
  if(side==='bottom')free.bottom=Math.min(free.bottom,panel.top-24);
  return free;
}
function assertParcelFits(app,parcelId,panelId,side) {
  const actual=parcelScreenBounds(app,parcelId),free=remainingMapRect(app,panelId,side),epsilon=.001;
  assert(free.right>free.left&&free.bottom>free.top,'the mocked layout must leave usable map space');
  assert(actual.left>=free.left-epsilon,`${parcelId} left ${actual.left} is outside free map ${free.left}`);
  assert(actual.right<=free.right+epsilon,`${parcelId} right ${actual.right} is outside free map ${free.right}`);
  assert(actual.top>=free.top-epsilon,`${parcelId} top ${actual.top} is outside free map ${free.top}`);
  assert(actual.bottom<=free.bottom+epsilon,`${parcelId} bottom ${actual.bottom} is outside free map ${free.bottom}`);
}
const cameraSignature=app=>[...app.camera().matrixWorld.elements,...app.camera().projectionMatrix.elements];
function panMap(app,free,dx=58,dy=22) {
  const point={clientX:(free.left+free.right)/2,clientY:(free.top+free.bottom)/2,button:0};
  app.input('pointerdown',point);app.input('pointermove',{...point,clientX:point.clientX+dx,clientY:point.clientY+dy});
  app.input('pointerup',{...point,clientX:point.clientX+dx,clientY:point.clientY+dy});
}

test('parcel framing uses the visible map beside a sidebar and above a bottom sheet across resizes',async()=>{
  const sidebarLayout=view=>view.width>900||(view.width>view.height&&view.height<=400);
  const panelRects={'analysis-panel':view=>{
    const side=sidebarLayout(view),panelWidth=Math.min(392,view.width*.4),compact=view.width<=900;
    return side?{left:view.left+view.width-panelWidth-12,top:view.top+(compact?10:12),width:panelWidth,height:view.height-(compact?22:24)}:
      {left:view.left+12,top:view.top+view.height*.56,width:view.width-24,height:view.height*.44-12};
  }};
  const app=boot({panelRects,rect:{left:37,top:100,width:1100,height:700}});
  placePair(app);await app.flushTimers();app.click('open-analysis');
  assert.equal(app.elements.get('demo-workspace').dataset.analysisOpen,'true');
  assert.equal(app.elements.get('context-card').getBoundingClientRect().width,0);
  assert.equal(app.elements.get('route-panel').getBoundingClientRect().width,0);
  const rows=app.elements.get('analysis-parcel-list').children;
  assert(rows.length>1);
  for(const row of rows){
    row.click();
    assert.equal(app.canvas.dataset.analysisParcel,row.dataset.parcelId);
    assertParcelFits(app,row.dataset.parcelId,'analysis-panel','right');
  }
  const selected=app.canvas.dataset.analysisParcel;
  const beforePan=cameraSignature(app);
  panMap(app,remainingMapRect(app,'analysis-panel','right'));
  assert.notDeepEqual(cameraSignature(app),beforePan,'manual panning remains available');
  assert.equal(app.canvas.dataset.analysisParcel,selected);
  app.input('keydown',{key:'ArrowLeft'});app.input('keydown',{key:'ArrowUp'});
  app.click('focus-analysis-parcel');
  assert.equal(app.canvas.dataset.analysisParcel,selected,'Show on map reframes the selected row');
  assertParcelFits(app,selected,'analysis-panel','right');
  for(const view of [
    {left:12,top:145,width:420,height:680},
    {left:18,top:142,width:740,height:360},
    {left:0,top:132,width:568,height:188},
    {left:29,top:96,width:1020,height:560},
  ]){
    app.resize(view);
    assert.equal(app.canvas.dataset.analysisParcel,selected,'resize preserves the selected parcel');
    assertParcelFits(app,selected,'analysis-panel',sidebarLayout(view)?'right':'bottom');
  }
  app.click('close-analysis');
  assert.equal(app.elements.get('demo-workspace').dataset.analysisOpen,'false');
  assert.deepEqual(app.errors,[]);
});

test('inspection clicks lock parcel selection and frame it without hover-driven camera movement',()=>{
  const app=boot();app.click('inspect-parcels');
  const first=expectedWorld.tileAt(-43,-17).parcelId,beforeHover=cameraSignature(app);
  app.hover(-43,-17);
  assert.equal(app.canvas.dataset.selectedParcel,first);
  assert.deepEqual(cameraSignature(app),beforeHover,'hover shows details without moving the camera');
  app.tap(-43,-17);
  assert.equal(app.canvas.dataset.inspectionLocked,'true');
  assert.equal(app.canvas.dataset.selectedParcel,first);
  assertParcelFits(app,first,'context-card','left');
  panMap(app,remainingMapRect(app,'context-card','left'),36,12);
  assert.equal(app.canvas.dataset.selectedParcel,first);
  const beforeLockedHover=cameraSignature(app),free=remainingMapRect(app,'context-card','left');
  const other=expectedWorld.tiles.find(tile=>{
    if(tile.parcelId===first||tile.height!==1.5||tile.terrain!=='meadow')return false;
    const p=app.point(tile.x,tile.z);
    return p.clientX>free.left+10&&p.clientX<free.right-10&&p.clientY>free.top+10&&p.clientY<free.bottom-10;
  });
  assert(other,'a different parcel is visible for hover and click checks');
  app.hover(other.x,other.z);
  assert.equal(app.canvas.dataset.selectedParcel,first,'hover cannot replace a clicked parcel');
  assert.deepEqual(cameraSignature(app),beforeLockedHover,'hover does not chase the pointer');
  app.click('focus-inspected-parcel');assertParcelFits(app,first,'context-card','left');
  app.click('reset-view');
  const second=expectedWorld.tileAt(43,17).parcelId;
  app.tap(43,17);
  assert.equal(app.canvas.dataset.selectedParcel,second,'an explicit click can select a different parcel');
  assert.equal(app.canvas.dataset.inspectionLocked,'true');
  assertParcelFits(app,second,'context-card','left');
  for(const [view,side] of [
    [{left:12,top:145,width:460,height:620},'bottom'],
    [{left:0,top:132,width:568,height:188},'left'],
  ]){
    app.resize(view);
    assert.equal(app.canvas.dataset.selectedParcel,second);
    assertParcelFits(app,second,'context-card',side);
  }
  assert.deepEqual(app.errors,[]);
});
