import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world.js';
import { createPlacement } from '../src/placement.js';
import { ROUTING_ASSUMPTIONS, computeTransmissionRoutes, evaluateTransmissionSpan, evaluateTowerSite } from '../src/routing.js';
import { analyzeRouteParcels, chooseJudgeParcel } from '../src/parcel-analysis.js';

const world=createWorld();
function routes(ax=-43,az=-17,bx=43,bz=-17,options={}){
  const substation=createPlacement(world,'substation',ax,az);
  const datacenter=createPlacement(world,'datacenter',bx,bz,{substation});
  assert(substation&&datacenter);
  const result=computeTransmissionRoutes(world,{substation,datacenter},options);
  assert.equal(result.status,'ok');return result;
}
function quadrants(){
  const owners=['A','B','C','D'].map(id=>({id:`O${id}`,alias:`Owner ${id}`,synthetic:true,contactRef:`fixture-${id}`,email:`${id.toLowerCase()}@example.com`,phoneDisplay:'555-0100 · demo',dialTarget:null}));
  const parcels=owners.map((owner,index)=>({id:['A','B','C','D'][index],name:`Parcel ${index}`,ownerId:owner.id,synthetic:true,landUse:'open-land',areaTiles:144,
    accessConsent:'unknown',negotiationStatus:'pending',compensation:{upfrontPerTileCents:101+index,monthlyPerTileCents:11+index,offerCapCents:100000}}));
  const tiles=[],lookup=new Map();
  for(let z=-12;z<12;z++)for(let x=-12;x<12;x++){
    const parcelId=['A','B','C','D'][(z>=0?2:0)+(x>=0?1:0)];
    const tile={x:x+.5,z:z+.5,height:1.5,terrain:'meadow',occupiedBy:[],parcelId,routingPolicy:{linePassage:'possible'}};
    tiles.push(tile);lookup.set(`${x},${z}`,tile);
  }
  return {width:24,depth:24,tiles,parcels,owners,parcelById:new Map(parcels.map(p=>[p.id,p])),ownerById:new Map(owners.map(o=>[o.id,o])),tileAt:(x,z)=>lookup.get(`${Math.floor(x)},${Math.floor(z)}`)};
}
function makeRoute(fixture,coordinates,config=ROUTING_ASSUMPTIONS){
  const nodes=coordinates.map(([x,z],index)=>{
    const terminal=index===0||index===coordinates.length-1;
    const base=terminal?{x,z,groundY:1.5,height:config.supportHeightTiles,kind:'terminal',parcelIds:[]}:evaluateTowerSite(fixture,x,z,{},config);
    assert(base);return {...base,id:`node-${index}`};
  });
  const affected=new Set(),costBreakdown={compensationCents:0,rentCents:0};
  for(const node of nodes){for(const id of node.parcelIds)affected.add(id);for(const key of Object.keys(costBreakdown))costBreakdown[key]+=node.costs?.[key]??0;}
  const spans=nodes.slice(1).map((node,index)=>{
    const edge=evaluateTransmissionSpan(fixture,nodes[index],node,{},config);assert(edge);
    for(const id of edge.parcelIds)affected.add(id);
    for(const key of Object.keys(costBreakdown))costBreakdown[key]+=edge.costs[key];
    return {from:nodes[index].id,to:node.id,lengthTiles:edge.lengthTiles,sag:config.sagTiles,parcelIds:edge.parcelIds};
  });
  return {id:'test-route',sourceMode:'fixture',coordinateSystem:'local-demo-grid',nodes,spans,parcelIds:[...affected].sort(),costBreakdown,
    lengthTiles:spans.reduce((n,s)=>n+s.lengthTiles,0),metrics:{towerCount:nodes.filter(n=>n.kind==='tower').length}};
}

test('selected route parcel costs reconcile exactly without mutating fixtures or routes',()=>{
  const result=routes(),beforeWorld=JSON.stringify({owners:world.owners,parcels:world.parcels}),beforeRoutes=JSON.stringify(result);
  for(const route of result.candidates){
    const analysis=analyzeRouteParcels(world,route,result.assumptions);
    assert.equal(analysis.totals.upfrontCents,route.costBreakdown.compensationCents);
    assert.equal(analysis.totals.rentTotalCents,route.costBreakdown.rentCents);
    assert.equal(analysis.totals.foundationAreaTiles,route.metrics.towerCount*4);
    assert.equal(analysis.totals.towerCount,route.metrics.towerCount);
    assert(Math.abs(analysis.totals.lineLengthTiles-route.lengthTiles)<1e-9);
    assert.deepEqual(analysis.parcels.map(p=>p.parcelId),[...route.parcelIds].sort());
    for(const parcel of analysis.parcels){
      assert.equal(parcel.ownerAlias,world.ownerById.get(parcel.ownerId).alias);
      assert.equal(parcel.contactRef,world.ownerById.get(parcel.ownerId).contactRef);
      assert(parcel.email.endsWith('@example.com'));
      assert.equal(parcel.monthlyRentIsApproximate,parcel.monthlyRentCents*analysis.rentHorizonMonths!==parcel.rentTotalCents);
      assert.equal(parcel.withinOfferCap,parcel.upfrontCents<=parcel.offerCapCents);
      assert(!('dialTarget' in parcel));
    }
    const isolated=analysis.parcels[0];isolated.towerIds.push('test-change');isolated.ownerAlias='Changed';
  }
  assert.equal(JSON.stringify({owners:world.owners,parcels:world.parcels}),beforeWorld);
  assert.equal(JSON.stringify(result),beforeRoutes);
});

test('diagonal corner corridor parcels remain visible with zero centerline cost',()=>{
  const fixture=quadrants(),route=makeRoute(fixture,[[-2,-2],[2,2]]),analysis=analyzeRouteParcels(fixture,route);
  assert.deepEqual(analysis.parcels.map(p=>p.parcelId),['A','B','C','D']);
  for(const id of ['B','C']){
    const parcel=analysis.parcels.find(p=>p.parcelId===id);
    assert.equal(parcel.corridorOnly,true);assert.equal(parcel.lineLengthTiles,0);
    assert.equal(parcel.upfrontCents,0);assert.equal(parcel.rentTotalCents,0);
    assert.deepEqual(parcel.affectReasons,['line-corridor']);
  }
  assert.equal(analysis.totals.upfrontCents,Math.round(Math.sqrt(8)*101+Math.sqrt(8)*104));
  assert.equal(analysis.totals.rentTotalCents,route.costBreakdown.rentCents);
  assert.equal(analysis.parcels.reduce((n,p)=>n+p.upfrontCents,0),analysis.totals.upfrontCents);
});

test('boundary foundations allocate each tile once and count shared towers explicitly',()=>{
  const fixture=quadrants(),route=makeRoute(fixture,[[-6,0],[0,0],[6,0]]),analysis=analyzeRouteParcels(fixture,route);
  assert.equal(analysis.totals.towerCount,1);assert.equal(analysis.totals.parcelTowerTouches,4);
  assert.equal(analysis.totals.foundationAreaTiles,4);
  for(const parcel of analysis.parcels){assert.equal(parcel.foundationAreaTiles,1);assert.equal(parcel.towerCount,1);assert.deepEqual(parcel.towerIds,['node-1']);}
  assert.equal(analysis.totals.upfrontCents,route.costBreakdown.compensationCents);
  assert.equal(analysis.totals.rentTotalCents,route.costBreakdown.rentCents);
});

test('allocation remains exact for differing horizons, geometry and reversed routes',()=>{
  for(const [ax,az,bx,bz] of [[-43,17,43,35],[43,17,-43,-17],[-43,-17,-43,17]]){
    const result=routes(ax,az,bx,bz,{rentHorizonMonths:7});
    for(const route of result.candidates){
      const analysis=analyzeRouteParcels(world,route,result.assumptions);
      assert.equal(analysis.totals.upfrontCents,route.costBreakdown.compensationCents);
      assert.equal(analysis.totals.rentTotalCents,route.costBreakdown.rentCents);
    }
  }
  const fixture=quadrants(),config={...ROUTING_ASSUMPTIONS,rentHorizonMonths:0};
  const analysis=analyzeRouteParcels(fixture,makeRoute(fixture,[[-2,-2],[2,2]],config),config);
  assert.equal(analysis.totals.rentTotalCents,0);assert(analysis.parcels.every(p=>p.monthlyRentCents===0&&!p.monthlyRentIsApproximate));
});

test('stale parcel metadata, costs and invalid geometry fail instead of producing a handoff',()=>{
  const fixture=quadrants(),route=makeRoute(fixture,[[-2,-2],[2,2]]);
  const changed=structuredClone(route);changed.costBreakdown.compensationCents++;
  assert.throws(()=>analyzeRouteParcels(fixture,changed),/land costs changed/);
  const omitted=structuredClone(route);omitted.parcelIds=omitted.parcelIds.filter(id=>id!=='B');
  assert.throws(()=>analyzeRouteParcels(fixture,omitted),/omits affected parcel/);
  const broken=structuredClone(route);broken.spans[0].from='missing';
  assert.throws(()=>analyzeRouteParcels(fixture,broken),/span order/);
  const invalid=structuredClone(route);invalid.nodes[0].x=NaN;
  assert.throws(()=>analyzeRouteParcels(fixture,invalid),/coordinates/);
  fixture.parcelById.get('A').compensation.upfrontPerTileCents++;
  assert.throws(()=>analyzeRouteParcels(fixture,route),/land costs changed/);
  fixture.parcelById.get('A').accessConsent='refused';
  assert.throws(()=>analyzeRouteParcels(fixture,route),/no longer feasible/);
});

test('judge binding is guaranteed, stable while affected and rebinds when excluded',()=>{
  const analysis={parcels:[
    {parcelId:'C',towerCount:0,lineLengthTiles:30},
    {parcelId:'B',towerCount:1,lineLengthTiles:5},
    {parcelId:'A',towerCount:1,lineLengthTiles:5},
  ]};
  assert.equal(chooseJudgeParcel(analysis),'A');
  assert.equal(chooseJudgeParcel(analysis,'C'),'C');
  assert.equal(chooseJudgeParcel(analysis,'not-selected'),'A');
  assert.equal(chooseJudgeParcel({parcels:analysis.parcels.filter(p=>p.parcelId!=='C')},'C'),'A');
  assert.equal(chooseJudgeParcel({parcels:[]}),null);
  assert.equal(chooseJudgeParcel(null),null);
  assert.deepEqual(analysis.parcels.map(p=>p.parcelId),['C','B','A'],'selection never sorts caller state in place');
});
