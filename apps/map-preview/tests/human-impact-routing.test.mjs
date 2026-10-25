import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld} from '../src/world.js';
import {createPlacement} from '../src/placement.js';
import {computeTransmissionRoutes,shortestTransmissionPath,evaluateTransmissionSpan,evaluateTowerSite} from '../src/routing.js';

function flatWorld(){
  const tiles=[],lookup=new Map();
  for(let z=-12;z<12;z++)for(let x=-12;x<12;x++){
    const tile={x:x+.5,z:z+.5,height:1.5,terrain:'meadow',occupiedBy:[],parcelId:'land'};
    tiles.push(tile);lookup.set(`${x},${z}`,tile);
  }
  return {width:24,depth:24,tiles,activityAreas:[],tileAt:(x,z)=>lookup.get(`${Math.floor(x)},${Math.floor(z)}`),
    parcelById:new Map([['land',{accessConsent:'unknown',compensation:{upfrontPerTileCents:100,monthlyPerTileCents:10}}]])};
}
const node=(x,z)=>({x,z,groundY:1.5,kind:'tower',height:10});
const costs=value=>({lineCents:value,towerCents:0,terminalCents:0,terrainCents:0,waterCents:0,agricultureCents:0,vegetationCents:0,roadCents:0,compensationCents:0,rentCents:0});

test('human disturbance counts crops at the corridor edge and merges overlapping tile intervals',()=>{
  const world=flatWorld();
  for(let x=-2;x<2;x++)world.tileAt(x+.5,.5).terrain='field';
  const span=evaluateTransmissionSpan(world,node(-6,-.2),node(6,-.2),{});
  assert(span);
  assert.equal(span.metrics.agricultureLengthTiles,0,'the centerline itself is outside crops');
  assert(Math.abs(span.metrics.farmCorridorLengthTiles-5.6)<1e-8,'union exposure includes the full corridor without counting neighboring tiles twice');
  assert.equal(span.metrics.humanDisturbanceUnits,5600);
});

test('farmstead and active-work buffers are preferences while building footprints remain hard exclusions',()=>{
  const world=flatWorld();
  world.activityAreas=[{x0:-1,x1:1,z0:-1,z1:1,kind:'home-and-work',bufferTiles:3}];
  for(let z=-1;z<1;z++)for(let x=-1;x<1;x++)world.tileAt(x+.5,z+.5).occupiedBy=['farmstead'];
  assert.equal(evaluateTransmissionSpan(world,node(-6,0),node(6,0),{}),null);
  const close=evaluateTransmissionSpan(world,node(-6,4),node(6,4),{});
  const distant=evaluateTransmissionSpan(world,node(-6,6),node(6,6),{});
  assert(close&&distant);
  assert(close.metrics.homeBufferLengthTiles>0);
  assert.equal(distant.metrics.homeBufferLengthTiles,0);
  const nearPad=evaluateTowerSite(world,3,3,{}),farPad=evaluateTowerSite(world,7,7,{});
  assert(nearPad&&farPad);
  assert(nearPad.activityFoundationAreaTiles>0);
  assert.equal(farPad.activityFoundationAreaTiles,0);
  assert.deepEqual(nearPad.costs,farPad.costs,'preference scores cannot alter real monetary amounts');
  world.activityAreas[0].kind='worksite';
  const work=evaluateTransmissionSpan(world,node(-6,4),node(6,4),{});
  assert(work.metrics.workBufferLengthTiles>0);
  assert.equal(work.metrics.homeBufferLengthTiles,0);
});

test('low impact prioritizes human exposure over dollars and uses cost for equal exposure',()=>{
  const graph={start:0,goal:3,nodes:Array.from({length:4},()=>({costs:costs(0)})),adjacency:Array.from({length:4},()=>[])};
  const connect=(a,b,cost,exposure)=>{const edge={lengthTiles:1,costs:costs(cost),metrics:{humanDisturbanceUnits:exposure}};
    graph.adjacency[a].push({to:b,edge});graph.adjacency[b].push({to:a,edge});};
  connect(0,1,100,1000);connect(1,3,100,1000);connect(0,2,1000000,0);connect(2,3,1000000,0);
  assert.deepEqual(shortestTransmissionPath(graph,'balanced').indices,[0,1,3]);
  assert.deepEqual(shortestTransmissionPath(graph,'low-impact').indices,[0,2,3]);
  graph.adjacency[0][0].edge.metrics.humanDisturbanceUnits=0;graph.adjacency[1][1].edge.metrics.humanDisturbanceUnits=0;
  assert.deepEqual(shortestTransmissionPath(graph,'low-impact').indices,[0,1,3],'equal impact must not create an expensive detour');
  graph.adjacency[0][0].edge.metrics.humanDisturbanceUnits=1000;graph.adjacency[1][1].edge.metrics.humanDisturbanceUnits=1000;
  graph.adjacency[0]=graph.adjacency[0].filter(c=>c.to!==2);
  assert.deepEqual(shortestTransmissionPath(graph,'low-impact').indices,[0,1,3],'unavoidable exposure remains a valid least-disturbing route');
});

test('rendered farm scenario reduces human disturbance and crop corridor exposure without changing cost accounting',()=>{
  const world=createWorld();
  assert(world.activityAreas.some(a=>a.sourceKind==='farmstead'));
  assert(world.activityAreas.some(a=>a.sourceKind==='hay-bales'));
  const substation=createPlacement(world,'substation',-43,17);
  const datacenter=createPlacement(world,'datacenter',43,17,{substation});
  assert(substation&&datacenter);
  const result=computeTransmissionRoutes(world,{substation,datacenter});
  assert.equal(result.status,'ok');
  const balanced=result.candidates.find(r=>r.id==='balanced');
  const low=result.candidates.find(r=>r.id==='low-impact');
  assert(balanced&&low,'the fixture must expose two distinct choices');
  assert(low.metrics.humanDisturbanceUnits<balanced.metrics.humanDisturbanceUnits);
  assert(low.metrics.farmCorridorLengthTiles<balanced.metrics.farmCorridorLengthTiles);
  assert(low.metrics.cropClearingTiles<=balanced.metrics.cropClearingTiles);
  for(const route of result.candidates){
    assert.equal(route.totalCostCents,Object.values(route.costBreakdown).reduce((a,b)=>a+b,0));
    assert.equal(route.sourceMode,'fixture');
    for(let i=1;i<route.nodes.length;i++)assert(evaluateTransmissionSpan(world,route.nodes[i-1],route.nodes[i],{substation,datacenter}));
  }
});
