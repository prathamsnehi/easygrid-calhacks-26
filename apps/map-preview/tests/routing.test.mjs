import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld} from '../src/world.js';
import {createPlacement} from '../src/placement.js';
import {terminalConstructionCosts} from '../src/cost-model.js';
import {ROUTING_ASSUMPTIONS,computeTransmissionRoutes,buildTransmissionGraph,shortestTransmissionPath,
  evaluateTowerSite,evaluateTransmissionSpan,traceSpanCells,segmentRectInterval} from '../src/routing.js';

const world=createWorld();
const emptyCosts=()=>Object.fromEntries(['lineCents','towerCents','terminalCents','terrainCents','waterCents','agricultureCents','vegetationCents','roadCents','compensationCents','rentCents'].map(key=>[key,0]));
function sites(ax=-43,az=-17,bx=43,bz=-17){
  const substation=createPlacement(world,'substation',ax,az);
  const datacenter=createPlacement(world,'datacenter',bx,bz,{substation});
  assert(substation&&datacenter,'test placements must be valid');return {substation,datacenter};
}
function flatWorld(){
  const tiles=[],lookup=new Map();
  for(let z=-12;z<12;z++)for(let x=-12;x<12;x++){
    const tile={x:x+.5,z:z+.5,height:1.5,terrain:'meadow',occupiedBy:[],parcelId:'land',routingPolicy:{linePassage:'possible'}};
    tiles.push(tile);lookup.set(`${x},${z}`,tile);
  }
  return {width:24,depth:24,tiles,tileAt:(x,z)=>lookup.get(`${Math.floor(x)},${Math.floor(z)}`),
    parcelById:new Map([['land',{accessConsent:'unknown',compensation:{upfrontPerTileCents:100,monthlyPerTileCents:10}}]])};
}
const node=(x,z,groundY=1.5)=>({x,z,groundY,kind:'tower',height:10});

test('weighted search agrees with exhaustive simple paths and chooses cost over distance',()=>{
  const graph={start:0,goal:3,nodes:Array.from({length:4},()=>({costs:emptyCosts()})),adjacency:Array.from({length:4},()=>[])};
  graph.nodes[1].costs.towerCents=30;graph.nodes[2].costs.towerCents=1;
  for(const [a,b,length,cost] of [[0,1,1,2],[1,3,1,2],[0,2,3,3],[2,3,3,3],[1,2,1,10]]){
    const edge={lengthTiles:length,costs:{...emptyCosts(),lineCents:cost}};
    graph.adjacency[a].push({to:b,edge});graph.adjacency[b].push({to:a,edge});
  }
  let exhaustive=Infinity;
  function visit(at,seen,cost){if(at===graph.goal){exhaustive=Math.min(exhaustive,cost);return;}
    for(const next of graph.adjacency[at])if(!seen.has(next.to))visit(next.to,new Set([...seen,next.to]),cost+next.edge.costs.lineCents+graph.nodes[next.to].costs.towerCents);
  }
  visit(0,new Set([0]),0);
  const costPath=shortestTransmissionPath(graph,'balanced'),shortPath=shortestTransmissionPath(graph,'shortest');
  assert.equal(costPath.objectiveCost,exhaustive);assert.deepEqual(costPath.indices,[0,2,3]);
  assert.deepEqual(shortPath.indices,[0,1,3]);
  graph.adjacency[0]=[];assert.equal(shortestTransmissionPath(graph),null);
});

test('exact traversal partitions distance and corridor checks catch corner clipping',()=>{
  const fixture=flatWorld(),a=node(-5,-5),b=node(5,5);
  const cells=traceSpanCells(fixture,a,b);
  assert(Math.abs(cells.reduce((sum,c)=>sum+c.length,0)-Math.hypot(10,10))<1e-9);
  assert(segmentRectInterval(a,b,{x0:0,x1:1,z0:1,z1:2}),'a geometric corner touch counts');
  assert(evaluateTransmissionSpan(fixture,a,b,{}));
  fixture.tileAt(.5,1.5).occupiedBy=['farmstead'];
  assert.equal(evaluateTransmissionSpan(fixture,a,b,{}),null,'diagonal span must not squeeze through a blocked corner');
});

test('water, roads, trees and uneven foundations are forbidden while farms can be cleared',()=>{
  for(const kind of ['river','shore','road']){
    const fixture=flatWorld();fixture.tileAt(.5,.5).terrain=kind;
    assert.equal(evaluateTowerSite(fixture,0,0,{}),null,kind);
  }
  for(const kind of ['tree','rock','farmstead','bridge']){
    const fixture=flatWorld();fixture.tileAt(.5,.5).occupiedBy=[kind];
    assert.equal(evaluateTowerSite(fixture,0,0,{}),null,kind);
  }
  const uneven=flatWorld();uneven.tileAt(.5,.5).height=2;
  assert.equal(evaluateTowerSite(uneven,0,0,{}),null);
  const farm=flatWorld();farm.tileAt(.5,.5).terrain='field';farm.tileAt(.5,.5).occupiedBy=['agriculture'];
  const cleared=evaluateTowerSite(farm,0,0,{});
  assert(cleared);assert.equal(cleared.cropCells,1);assert(cleared.costs.agricultureCents>0);
});

test('overhead crossings are allowed with clearance but long and obstructed spans are rejected',()=>{
  const fixture=flatWorld(),a=node(-6,0),b=node(6,0);
  for(const t of fixture.tiles)if(t.x>-2&&t.x<2){t.terrain='river';t.height=.2;}
  const crossing=evaluateTransmissionSpan(fixture,a,b,{});
  assert(crossing&&crossing.metrics.waterLengthTiles>0&&crossing.costs.waterCents>0);
  assert.equal(evaluateTransmissionSpan(fixture,node(-9,0),node(9,0),{}),null);
  fixture.tileAt(.5,.5).height=20;fixture.tileAt(.5,.5).terrain='hill';
  assert.equal(evaluateTransmissionSpan(fixture,a,b,{}),null,'terrain must clear the sagging line');
});

test('clearance checks include off-center tree and rock envelopes',()=>{
  for(const [kind,height] of [['tree',5.5],['rock',7.5]]){
    const fixture=flatWorld(),a=node(-6,0),b=node(6,0);
    const t=fixture.tileAt(.5,.5);t.height=height;
    assert(evaluateTransmissionSpan(fixture,a,b,{}),'bare ground is below the modeled clearance envelope');
    t.occupiedBy=[kind];
    assert.equal(evaluateTransmissionSpan(fixture,a,b,{}),null,`${kind} must not be ignored`);
  }
});

test('clearance protects the conductor tube bottom, not only its centerline',()=>{
  const fixture=flatWorld(),a=node(-6,0),b=node(6,0);
  const tile=fixture.tileAt(.5,.5);tile.height=8.4;
  assert(evaluateTransmissionSpan(fixture,a,b,{}, {...ROUTING_ASSUMPTIONS,conductorRadiusTiles:0}));
  assert.equal(evaluateTransmissionSpan(fixture,a,b,{}),null,'2.0 centerline clearance is insufficient for a 0.045-radius conductor');
  tile.height=8.35;
  assert(evaluateTransmissionSpan(fixture,a,b,{}),'the tube bottom now clears terrain by more than 2.0');
});

test('facility terminals only connect through their front apron',()=>{
  const placements=sites(),p=placements.substation;
  const terminal={...node(p.connectionPoint.x,p.connectionPoint.z),kind:'terminal',facilityKind:'substation'};
  assert.equal(evaluateTransmissionSpan(world,terminal,node(p.x,p.z-7),placements),null);
  assert(evaluateTransmissionSpan(world,terminal,node(p.x,p.footprint.z1+7),placements));
  assert.equal(evaluateTowerSite(world,p.x,p.z,placements),null);
});

test('normal routes reconcile costs, hit endpoints and never violate their span graph',()=>{
  const placements=sites(),result=computeTransmissionRoutes(world,placements);
  assert.equal(result.status,'ok');assert.equal(result.recommendedId,'balanced');
  assert(result.candidates.length>=1&&result.candidates.length<=3);
  const signatures=new Set();
  for(const route of result.candidates){
    assert.equal(route.nodes[0].x,placements.substation.connectionPoint.x);
    assert.equal(route.nodes[0].z,placements.substation.connectionPoint.z);
    assert.equal(route.nodes.at(-1).x,placements.datacenter.connectionPoint.x);
    assert.equal(route.nodes.at(-1).z,placements.datacenter.connectionPoint.z);
    assert.equal(route.totalCostCents,Object.values(route.costBreakdown).reduce((sum,n)=>sum+n,0));
    assert(Object.values(route.costBreakdown).every(n=>Number.isSafeInteger(n)&&n>=0));
    assert.equal(route.metrics.towerCount,route.nodes.filter(n=>n.kind==='tower').length);
    assert.equal(route.metrics.spanCount,route.nodes.length-1);
    assert.equal(route.parcelIds.length,new Set(route.parcelIds).size);
    assert(route.parcelIds.every(id=>world.parcelById.has(id)));
    assert.equal(route.readyToApprove,false);assert(route.pendingConsentParcelIds.length>0);
    const signature=route.nodes.map(n=>n.id).join(',');assert(!signatures.has(signature));signatures.add(signature);
    for(const support of route.nodes)if(support.kind==='tower')assert(evaluateTowerSite(world,support.x,support.z,placements));
    for(let i=1;i<route.nodes.length;i++)assert(evaluateTransmissionSpan(world,route.nodes[i-1],route.nodes[i],placements));
  }
  const best=result.candidates[0];
  assert(result.candidates.every(route=>best.totalCostCents<=route.totalCostCents));
  assert.equal(best.totalCostCents,best.objectiveCost+Object.values(terminalConstructionCosts()).reduce((sum,n)=>sum+n,0));
  const again=computeTransmissionRoutes(world,placements);
  assert.deepEqual(again.candidates.map(r=>[r.id,r.totalCostCents,r.nodes.map(n=>n.id)]),result.candidates.map(r=>[r.id,r.totalCostCents,r.nodes.map(n=>n.id)]));
});

test('missing placements, refused land and invalid assumptions fail explicitly',()=>{
  assert.equal(computeTransmissionRoutes(world,{}).status,'incomplete');
  const placements=sites();
  const refused=computeTransmissionRoutes(world,placements,{blockedParcelIds:world.parcels.map(p=>p.id)});
  assert.equal(refused.status,'no-route');assert.equal(refused.recommendedId,null);assert.equal(refused.candidates.length,0);
  for(const rate of [-1,NaN,Infinity,1.5])assert.throws(()=>buildTransmissionGraph(world,placements,{rates:{linePerTileCents:rate}}),/nonnegative/);
  assert.throws(()=>buildTransmissionGraph(world,placements,{maxSpanTiles:Infinity}),/dimensions/);
  for(const radius of [-1,NaN,Infinity,.11])assert.throws(()=>buildTransmissionGraph(world,placements,{conductorRadiusTiles:radius}),/clearance/);
  const broken={substation:{...placements.substation,connectionPoint:{x:NaN,z:0}},datacenter:placements.datacenter};
  assert.equal(computeTransmissionRoutes(world,broken).status,'no-route');
});

test('representative same-bank and cross-bank clearings remain connected',()=>{
  for(const coordinates of [[-43,-17,-43,17],[-43,17,43,35],[-43,35,43,-17],[43,17,-43,-17]]){
    const result=computeTransmissionRoutes(world,sites(...coordinates));
    assert.equal(result.status,'ok',coordinates.join(','));
    assert(result.candidates[0].totalCostCents>0);
  }
});
