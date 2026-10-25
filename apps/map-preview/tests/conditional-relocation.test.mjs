import test from 'node:test';
import assert from 'node:assert/strict';
import {relocateWithinParcel,CONDITIONAL_RELOCATION_POLICY} from '../src/conditional-relocation.js';
import {ROUTING_ASSUMPTIONS,evaluateTowerSite,evaluateTransmissionSpan,computeTransmissionRoutes} from '../src/routing.js';
import {COST_KEYS,emptyRouteCosts,terminalConstructionCosts} from '../src/cost-model.js';
import {analyzeRouteParcels} from '../src/parcel-analysis.js';
import {createWorld} from '../src/world.js';
import {createPlacement} from '../src/placement.js';

const clone=value=>JSON.parse(JSON.stringify(value));
const config={...ROUTING_ASSUMPTIONS,maxSpanTiles:24};
function fixture({neighbor=false,anchored=false,towerPoints}={}) {
  const bounds={x0:-12,x1:12,z0:-12,z1:12},tiles=[],lookup=new Map();
  for(let z=-20;z<20;z++)for(let x=-20;x<20;x++){
    const target=x>=bounds.x0&&x<bounds.x1&&z>=bounds.z0&&z<bounds.z1;
    const tile={x:x+.5,z:z+.5,height:1.5,terrain:'meadow',occupiedBy:[],parcelId:target?'own':'other',routingPolicy:{linePassage:'possible'}};
    tiles.push(tile);lookup.set(`${x},${z}`,tile);
  }
  const parcels=['own','other'].map(id=>({id,name:id,ownerId:`owner-${id}`,synthetic:true,sourceMode:'fixture',
    bounds:id==='own'?bounds:{x0:-20,x1:20,z0:-20,z1:20},landUse:'open-land',areaTiles:576,accessConsent:'unknown',negotiationStatus:'pending',
    compensation:{upfrontPerTileCents:id==='own'?100:200,monthlyPerTileCents:10}}));
  const world={width:40,depth:40,tiles,parcels,activityAreas:[],parcelById:new Map(parcels.map(p=>[p.id,p])),
    ownerById:new Map(parcels.map(p=>[p.ownerId,{id:p.ownerId,alias:p.ownerId,synthetic:true,dialTarget:null}])),
    tileAt:(x,z)=>lookup.get(`${Math.floor(x)},${Math.floor(z)}`)};
  const placements=Object.fromEntries([['substation',neighbor||anchored?-16:-4],['datacenter',anchored?16:4]].map(([kind,x])=>[kind,
    {y:1.5,connectionPoint:{x,z:-11},footprint:{x0:x-1,x1:x+1,z0:-15,z1:-12}}]));
  const sites=(towerPoints??(anchored?[[-10,-9],[0,-4],[10,-9]]:[[0,-4]])).map(([x,z])=>evaluateTowerSite(world,x,z,placements,config));
  const nodes=[{id:'start',kind:'terminal',facilityKind:'substation',x:placements.substation.connectionPoint.x,z:-11,groundY:1.5,height:10,parcelIds:[]},
    ...sites.map((site,index)=>({id:`owned-tower-${index}`,kind:'tower',x:site.x,z:site.z,groundY:site.groundY,height:site.height,foundation:site.foundation,parcelIds:site.parcelIds})),
    {id:'end',kind:'terminal',facilityKind:'datacenter',x:placements.datacenter.connectionPoint.x,z:-11,groundY:1.5,height:10,parcelIds:[]}];
  const costBreakdown=emptyRouteCosts(),ids=new Set(sites.flatMap(s=>s.parcelIds));let lengthTiles=0;
  const add=costs=>{for(const key of COST_KEYS)costBreakdown[key]+=costs[key];};sites.forEach(site=>add(site.costs));add(terminalConstructionCosts());
  const spans=nodes.slice(1).map((b,i)=>{
    const edge=evaluateTransmissionSpan(world,nodes[i],b,placements,config);assert(edge,'fixture span must be feasible');
    add(edge.costs);edge.parcelIds.forEach(id=>ids.add(id));lengthTiles+=edge.lengthTiles;
    return {from:nodes[i].id,to:b.id,lengthTiles:edge.lengthTiles,sag:config.sagTiles,parcelIds:edge.parcelIds};
  });
  const route={id:'original-route',profile:'balanced',sourceMode:'fixture',coordinateSystem:'local-demo-grid',nodes,spans,
    parcelIds:[...ids].sort(),lengthTiles,costBreakdown,totalCostCents:COST_KEYS.reduce((n,k)=>n+costBreakdown[k],0),metrics:{towerCount:sites.length},
    agreedCompensationCents:123457,sessionId:'original-session',readyToApprove:false};
  analyzeRouteParcels(world,route,config);
  return {world,route,placements,parcelId:'own',assumptions:config,agreedTermsByParcel:{own:{compensationCents:123457,monthlyRentCents:317},other:{compensationCents:223459}}};
}

test('four canonical edges move actual pads and wires, recompute metrics, and retain IDs and exact agreed money',()=>{
  for(const direction of CONDITIONAL_RELOCATION_POLICY.directions){
    const input=fixture(),before=clone(input.route),terms=clone(input.agreedTermsByParcel);
    const result=relocateWithinParcel({...input,condition:{direction,target:'edge'},currentTotalCents:input.route.totalCostCents+17777});
    assert.equal(result.status,'applied',`${direction}: ${result.reason}`);
    assert.equal(result.route.id,before.id);assert.equal(result.route.sessionId,before.sessionId);
    assert.equal(result.route.agreedCompensationCents,123457);assert.deepEqual(result.agreedTermsByParcel,terms);
    assert.deepEqual(result.route.nodes.map(n=>n.id),before.nodes.map(n=>n.id));
    assert.deepEqual(input.route,before);assert.deepEqual(input.agreedTermsByParcel,terms);
    assert.notDeepEqual(result.route.nodes[1],before.nodes[1]);assert.notEqual(result.route.spans[0].lengthTiles,before.spans[0].lengthTiles);
    assert.deepEqual(result.route.nodes[0],before.nodes[0]);assert.deepEqual(result.route.nodes.at(-1),before.nodes.at(-1));
    assert.equal(result.route.readyToApprove,false);assert.equal(result.accepted,undefined);
    assert.equal(result.updatedTotalCents,input.route.totalCostCents+17777+result.constructionCostDeltaCents);
    assert.equal(result.route.totalCostCents,COST_KEYS.reduce((n,k)=>n+result.route.costBreakdown[k],0));
    const f=result.route.nodes[1].foundation,b=input.world.parcelById.get('own').bounds;
    assert(direction==='north'?f.z1<=b.z0+4:direction==='south'?f.z0>=b.z1-4:direction==='east'?f.x0>=b.x1-4:f.x1<=b.x0+4);
    assert.equal(result.conditionEvidence.outsideGeometryUnchanged,true);
    assert.equal(result.route.metrics.humanDisturbanceUnits,0);
    analyzeRouteParcels(input.world,result.route,input.assumptions);
    assert.deepEqual(relocateWithinParcel({...input,condition:{direction,target:'edge'},currentTotalCents:input.route.totalCostCents+17777}),result);
  }
});

test('an existing neighboring parcel cannot have its crossing geometry changed even without a new affected parcel',()=>{
  const input=fixture({neighbor:true}),before=clone(input.route);
  assert.deepEqual(input.route.parcelIds,['other','own']);
  const result=relocateWithinParcel({...input,condition:{direction:'north',target:'edge'}});
  assert.equal(result.status,'review_required');assert.match(result.reason,/crossing span/);assert.equal(result.route,null);
  assert.deepEqual(input.route,before);
});

test('an interior tower can move while existing edge anchors, neighboring spans and other-owner amounts remain identical',()=>{
  const input=fixture({anchored:true}),before=clone(input.route),beforeAnalysis=analyzeRouteParcels(input.world,before,config);
  const result=relocateWithinParcel({...input,condition:{direction:'north',target:'edge'}});
  assert.equal(result.status,'applied',result.reason);
  assert.deepEqual(result.changedNodeIds,['owned-tower-1']);assert.deepEqual(result.changedSpanIndices,[1,2]);
  for(const index of [0,1,3,4])assert.deepEqual(result.route.nodes[index],before.nodes[index]);
  for(const index of [0,3])assert.deepEqual(result.route.spans[index],before.spans[index]);
  assert.deepEqual(result.route.parcelIds,before.parcelIds);
  const after=analyzeRouteParcels(input.world,result.route,config);
  assert.deepEqual(after.parcels.find(p=>p.parcelId==='other'),beforeAnalysis.parcels.find(p=>p.parcelId==='other'));
  assert.deepEqual(result.agreedTermsByParcel,input.agreedTermsByParcel);
});

test('edge obstacles, clearance, max span and exact construction budget fail closed',()=>{
  for(const kind of ['foundation','clearance','span','budget']){
    const input=fixture();
    if(kind==='foundation')for(const tile of input.world.tiles)if(tile.z>8)tile.occupiedBy=['tree'];
    if(kind==='clearance')for(const tile of input.world.tiles)if(tile.z>7&&tile.z<8)tile.height=30;
    if(kind==='span')input.assumptions={...config,maxSpanTiles:15};
    const result=relocateWithinParcel({...input,condition:{direction:'south',target:'edge'},
      ...(kind==='budget'?{budgetCents:input.route.totalCostCents,currentTotalCents:input.route.totalCostCents}:{})});
    assert.equal(result.status,'review_required',kind);assert.equal(result.route,null);
  }
});

test('a parcel island or clipped corner cannot be crossed by a shifted foundation or corridor',()=>{
  const input=fixture();
  for(const tile of input.world.tiles)if(tile.z>7&&tile.z<8)tile.parcelId='other';
  const result=relocateWithinParcel({...input,condition:{direction:'south',target:'edge'}});
  assert.equal(result.status,'review_required');assert.equal(result.route,null);
});

test('an edge relocation cannot overlap a fixed tower foundation',()=>{
  const input=fixture({anchored:true,towerPoints:[[0,-9],[0,-4],[10,-9]]});
  const result=relocateWithinParcel({...input,condition:{direction:'north',target:'edge'}});
  assert.equal(result.status,'review_required');assert.equal(result.route,null);
});

test('unclear and unsupported conditions and stale source amounts are never cosmetic successes',()=>{
  for(const condition of [null,'north',{direction:'north'},{direction:'north',target:'half'},
    {direction:'north',target:'edge',avoid:'house'},{direction:'up',target:'edge'}]){
    const result=relocateWithinParcel({...fixture(),condition});assert.equal(result.status,'review_required');
  }
  const input=fixture();input.route.costBreakdown.lineCents++;
  assert.equal(relocateWithinParcel({...input,condition:{direction:'north',target:'edge'}}).status,'review_required');
});

test('the ordinary cross-valley route is reviewed when its towers require changing neighboring geometry',()=>{
  const world=createWorld(),substation=createPlacement(world,'substation',-43,-17);
  const placements={substation,datacenter:createPlacement(world,'datacenter',43,-17,{substation})};
  const computed=computeTransmissionRoutes(world,placements),route=computed.candidates[0],before=clone(route);
  const parcelId=route.nodes.find(n=>n.kind==='tower'&&n.parcelIds.length===1).parcelIds[0];
  const result=relocateWithinParcel({world,route,placements,parcelId,assumptions:computed.assumptions,condition:{direction:'north',target:'edge'}});
  assert.equal(result.status,'review_required');assert.match(result.reason,/crossing span/);assert.deepEqual(route,before);
});
