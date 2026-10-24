import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world.js';
import { createPlacement } from '../src/placement.js';
import { ROUTING_ASSUMPTIONS, computeTransmissionRoutes, evaluateTransmissionSpan, evaluateTowerSite } from '../src/routing.js';
import { normalizeRoutingConstraints, spanIntersectsExclusion, foundationIntersectsExclusion } from '../src/routing-constraints.js';

const rectangle=(x0,z0,x1,z1)=>[[x0,z0],[x1,z0],[x1,z1],[x0,z1],[x0,z0]];
function flatWorld(){
  const tiles=[],lookup=new Map(),ring=rectangle(-12,-12,12,12);
  for(let z=-12;z<12;z++)for(let x=-12;x<12;x++){
    const tile={x:x+.5,z:z+.5,height:1.5,terrain:'meadow',occupiedBy:[],parcelId:'land',routingPolicy:{linePassage:'possible'}};
    tiles.push(tile);lookup.set(`${x},${z}`,tile);
  }
  return {width:24,depth:24,tiles,tileAt:(x,z)=>lookup.get(`${Math.floor(x)},${Math.floor(z)}`),
    parcelById:new Map([['land',{accessConsent:'unknown',compensation:{upfrontPerTileCents:100,monthlyPerTileCents:10},
      geometry:{coordinateSystem:'local-demo-grid',type:'Polygon',rings:[ring]}}]])};
}
const node=(x,z)=>({x,z,groundY:1.5,kind:'tower',height:10});
const baseWorld=createWorld();
const substation=createPlacement(baseWorld,'substation',-43,-17);
const placements={substation,datacenter:createPlacement(baseWorld,'datacenter',43,-17,{substation})};

test('spatial restrictions reject malformed, outside, crossed and unknown-parcel geometry',()=>{
  const world=flatWorld(),valid={parcelId:'land',ring:rectangle(-2,-2,2,2)};
  assert.deepEqual(normalizeRoutingConstraints(world,{exclusionZones:[valid]}).exclusionZones,[valid]);
  for(const exclusionZones of [null,{},[null],[{...valid,parcelId:'unknown'}],[{...valid,scope:'towers'}],
    [{...valid,ring:[[0,0],[1,0],[0,1],[2,2]]}],
    [{...valid,ring:[[0,0],[1,1],[0,1],[1,0],[0,0]]}],
    [{...valid,ring:[[0,0],[1,0],[2,0],[0,0]]}],
    [{...valid,ring:[[0,0],[1,0],[1,0],[0,1],[0,0]]}],
    [{...valid,ring:[[0,0],[2,0],[1,0],[1,1],[0,0]]}],
    [{...valid,ring:rectangle(-13,-2,2,2)}],
    [{...valid,ring:[[0,0],[Infinity,0],[1,1],[0,0]]}]]){
    assert.throws(()=>normalizeRoutingConstraints(world,{exclusionZones}),/Exclusion/);
  }
  for(const blockedParcelIds of [null,'land',['unknown'],['land','land']])assert.throws(()=>normalizeRoutingConstraints(world,{blockedParcelIds}),/unique known/);
  for(const blockedTowerParcelIds of [null,'land',['unknown']])assert.throws(()=>normalizeRoutingConstraints(world,{blockedTowerParcelIds}),/unique known/);
  assert.throws(()=>computeTransmissionRoutes(baseWorld,placements,{exclusionZones:[{parcelId:'L008',ring:rectangle(30,30,31,31)}]}),/inside/);
});

test('zone boundaries must remain inside a concave parcel even when vertices are inside',()=>{
  const world=flatWorld();
  world.parcelById.get('land').geometry.rings=[[[0,0],[6,0],[6,6],[4,6],[4,2],[2,2],[2,6],[0,6],[0,0]]];
  assert.throws(()=>normalizeRoutingConstraints(world,{exclusionZones:[{parcelId:'land',ring:[[1,1],[5,1],[5,5],[1,5],[1,1]]}]}),/inside/);
  const accepted={parcelId:'land',ring:rectangle(0,0,6,1)};
  assert.deepEqual(normalizeRoutingConstraints(world,{exclusionZones:[accepted]}).exclusionZones,[accepted]);
});

test('normalization detaches input constraints and leaves fixture ownership untouched',()=>{
  const world=flatWorld(),before=JSON.stringify([...world.parcelById]);
  const input={blockedParcelIds:['land'],blockedTowerParcelIds:['land'],exclusionZones:[{parcelId:'land',ring:rectangle(-2,-2,2,2)}]};
  const normalized=normalizeRoutingConstraints(world,input);
  input.blockedParcelIds.pop();input.blockedTowerParcelIds.pop();input.exclusionZones[0].ring[0][0]=99;
  assert.deepEqual(normalized.blockedParcelIds,['land']);assert.deepEqual(normalized.blockedTowerParcelIds,['land']);
  assert.deepEqual(normalized.exclusionZones[0].ring,rectangle(-2,-2,2,2));
  assert.equal(JSON.stringify([...world.parcelById]),before);
});

test('corridor and foundation checks block boundary contact, crossings and enclosed zones',()=>{
  const touching=[{parcelId:'land',ring:rectangle(-1,.8,1,2)}];
  assert(spanIntersectsExclusion(node(-6,0),node(6,0),.8,touching));
  assert(!spanIntersectsExclusion(node(-6,0),node(6,0),.8,[{parcelId:'land',ring:rectangle(-1,.81,1,2)}]));
  assert(spanIntersectsExclusion(node(-5,-5),node(5,5),.8,[{parcelId:'land',ring:rectangle(-.05,-.05,.05,.05)}]));
  assert(spanIntersectsExclusion(node(-5,-5),node(5,5),.8,[{parcelId:'land',ring:rectangle(-8,-8,8,8)}]));
  assert(foundationIntersectsExclusion({x0:-1,x1:1,z0:-1,z1:1},[{parcelId:'land',ring:rectangle(1,1,2,2)}]));
  assert(!foundationIntersectsExclusion({x0:-1,x1:1,z0:-1,z1:1},[{parcelId:'land',ring:rectangle(1.01,1.01,2,2)}]));
  const world=flatWorld(),config={...ROUTING_ASSUMPTIONS,...normalizeRoutingConstraints(world,{exclusionZones:touching})};
  assert.equal(evaluateTransmissionSpan(world,node(-6,0),node(6,0),{},config),null);
  assert.equal(evaluateTowerSite(world,0,0,{},config),null);
});

test('tower-only refusal preserves overhead passage while whole-parcel refusal blocks both',()=>{
  const world=flatWorld(),config={...ROUTING_ASSUMPTIONS,...normalizeRoutingConstraints(world,{blockedTowerParcelIds:['land']})};
  assert(evaluateTransmissionSpan(world,node(-6,0),node(6,0),{},config));
  assert.equal(evaluateTowerSite(world,0,0,{},config),null);
  assert.equal(evaluateTransmissionSpan(world,node(-6,0),node(6,0),{},ROUTING_ASSUMPTIONS,new Set(['land'])),null);
});

test('whole-parcel refusal reroutes all alternatives and keeps the cost model unchanged',()=>{
  const original=computeTransmissionRoutes(baseWorld,placements);
  const refusedId='L010';assert(original.candidates[0].parcelIds.includes(refusedId));
  const refused=computeTransmissionRoutes(baseWorld,placements,{blockedParcelIds:[refusedId]});
  assert.equal(refused.status,'ok');assert(refused.candidates.every(route=>!route.parcelIds.includes(refusedId)));
  assert.notDeepEqual(refused.candidates[0].nodes.map(n=>[n.x,n.z]),original.candidates[0].nodes.map(n=>[n.x,n.z]));
  assert.deepEqual(refused.assumptions.rates,original.assumptions.rates);
  assert(refused.candidates[0].totalCostCents>=original.candidates[0].totalCostCents);
  assert.deepEqual(refused.assumptions.blockedParcelIds,[refusedId]);
});

test('a local excluded zone changes the route and every proposed corridor respects it',()=>{
  const original=computeTransmissionRoutes(baseWorld,placements);
  const support=original.candidates[0].nodes.find(n=>n.kind==='tower'&&n.parcelIds.includes('L010'));
  assert(support);
  const exclusionZones=[{parcelId:'L010',ring:rectangle(support.x-.25,support.z-.25,support.x+.25,support.z+.25)}];
  const rerouted=computeTransmissionRoutes(baseWorld,placements,{exclusionZones});
  assert.equal(rerouted.status,'ok');
  assert.notDeepEqual(rerouted.candidates[0].nodes.map(n=>[n.x,n.z]),original.candidates[0].nodes.map(n=>[n.x,n.z]));
  for(const route of rerouted.candidates){
    for(const support of route.nodes.filter(n=>n.kind==='tower'))assert(!foundationIntersectsExclusion(support.foundation,exclusionZones));
    for(let i=1;i<route.nodes.length;i++)assert(!spanIntersectsExclusion(route.nodes[i-1],route.nodes[i],rerouted.assumptions.corridorHalfWidthTiles,exclusionZones));
    assert.equal(route.totalCostCents,Object.values(route.costBreakdown).reduce((sum,c)=>sum+c,0));
  }
  assert.deepEqual(rerouted.assumptions.exclusionZones,exclusionZones);
  const start=placements.substation.connectionPoint,parcelId=baseWorld.tileAt(start.x,start.z).parcelId;
  const noRoute=computeTransmissionRoutes(baseWorld,placements,{exclusionZones:[{parcelId,ring:rectangle(start.x-.1,start.z-.1,start.x+.1,start.z+.1)}]});
  assert.equal(noRoute.status,'no-route');assert.equal(noRoute.candidates.length,0);
});
