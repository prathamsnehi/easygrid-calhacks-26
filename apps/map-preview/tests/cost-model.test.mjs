import test from 'node:test';
import assert from 'node:assert/strict';
import {DEMO_COST_MODEL,DEMO_METERS_PER_TILE,DEMO_BUDGET_CENTS,COST_KEYS,
  emptyRouteCosts,applyConstructionAllowances,terminalConstructionCosts} from '../src/cost-model.js';
import {createWorld} from '../src/world.js';
import {createPlacement} from '../src/placement.js';
import {ROUTING_ASSUMPTIONS,computeTransmissionRoutes,evaluateTowerSite,evaluateTransmissionSpan} from '../src/routing.js';

const sum=costs=>Object.values(costs).reduce((total,value)=>total+value,0);
function flatWorld(prices){
  return {
    tileAt:(x,z)=>({x:Math.floor(x)+.5,z:Math.floor(z)+.5,height:1.5,terrain:'meadow',occupiedBy:[],parcelId:'land'}),
    parcelById:new Map([['land',{accessConsent:'unknown',compensation:prices}]]),
  };
}

test('source-based line price includes one complete circuit and declares its un-escalated basis',()=>{
  const fullCircuitPer1000Feet=3*(1807+2477+277)+(2819+4229)+(623+936);
  assert.equal(DEMO_METERS_PER_TILE,25);
  assert.equal(DEMO_BUDGET_CENTS,500000000);
  assert.equal(DEMO_COST_MODEL.linePerTileCents,Math.round(fullCircuitPer1000Feet*1.04/304.8*25*100));
  assert.equal(DEMO_COST_MODEL.linePerTileCents,190138);
  assert.equal(DEMO_COST_MODEL.towerCents,12839300);
  assert.equal(DEMO_COST_MODEL.terminalCents,16174800);
  assert.equal(DEMO_COST_MODEL.phaseConductorCount,3);
  assert.equal(DEMO_COST_MODEL.circuitCount,1);
  assert.equal(ROUTING_ASSUMPTIONS.costModel,DEMO_COST_MODEL);
  assert.match(DEMO_COST_MODEL.dollarBasis,/MTEP24 reported/);
  assert.match(DEMO_COST_MODEL.limitations,/not escalated to 2026/);
  assert(Object.isFrozen(DEMO_COST_MODEL)&&Object.isFrozen(DEMO_COST_MODEL.source));
});

test('engineering and contingency round sequentially and exclude all land payments',()=>{
  const costs={...emptyRouteCosts(),lineCents:101,towerCents:200,waterCents:4,
    compensationCents:900000,rentCents:60000};
  applyConstructionAllowances(costs);
  assert.equal(costs.engineeringCents,31); // round(305 * .10)
  assert.equal(costs.contingencyCents,101); // round((305 + 31) * .30)
  const again={...costs};applyConstructionAllowances(again);
  assert.deepEqual(again,costs,'recomputation must not compound its prior allowances');
  const cents={...emptyRouteCosts(),lineCents:5};applyConstructionAllowances(cents);
  assert.equal(cents.engineeringCents,1);assert.equal(cents.contingencyCents,2);
  const terminals=terminalConstructionCosts(100,2);
  assert.equal(terminals.terminalCents,200);assert.equal(terminals.engineeringCents,20);
  assert.equal(terminals.contingencyCents,66);assert.equal(sum(terminals),286);
  assert.throws(()=>applyConstructionAllowances({lineCents:-1}),/nonnegative/);
  assert.throws(()=>applyConstructionAllowances({lineCents:Number.MAX_SAFE_INTEGER}),/safe-integer/);
});

test('changing compensation and rent does not mark up the span or tower construction',()=>{
  const noLand=flatWorld({upfrontPerTileCents:0,monthlyPerTileCents:0});
  const withLand=flatWorld({upfrontPerTileCents:12345,monthlyPerTileCents:678});
  const start={x:-3,z:0,groundY:1.5,kind:'tower'},end={x:3,z:0,groundY:1.5,kind:'tower'};
  const pairs=[
    [evaluateTransmissionSpan(noLand,start,end,{}),evaluateTransmissionSpan(withLand,start,end,{})],
    [evaluateTowerSite(noLand,0,0,{}),evaluateTowerSite(withLand,0,0,{})],
  ];
  for(const [baseline,priced] of pairs){
    assert(baseline&&priced);
    assert(priced.costs.compensationCents>0&&priced.costs.rentCents>0);
    for(const key of COST_KEYS.filter(key=>!['compensationCents','rentCents'].includes(key))){
      assert.equal(priced.costs[key],baseline.costs[key],key);
    }
  }
});

test('rendered supports, full-circuit spans and fixed terminal allowances reconcile with the least-cost objective',()=>{
  const world=createWorld(),substation=createPlacement(world,'substation',-43,-17);
  const placements={substation,datacenter:createPlacement(world,'datacenter',43,-17,{substation})};
  const result=computeTransmissionRoutes(world,placements);
  assert.equal(result.status,'ok');
  for(const route of result.candidates){
    const interior=route.nodes.filter(node=>node.kind==='tower');
    assert.equal(route.costBreakdown.towerCents,interior.length*DEMO_COST_MODEL.towerCents);
    assert.equal(route.costBreakdown.terminalCents,route.nodes.filter(node=>node.kind==='terminal').length*DEMO_COST_MODEL.terminalCents);
    assert.equal(route.costBreakdown.lineCents,route.spans.reduce((total,span)=>total+Math.round(span.lengthTiles*DEMO_COST_MODEL.linePerTileCents),0));
    const expected=emptyRouteCosts();
    const add=costs=>{for(const key of COST_KEYS)expected[key]+=costs[key];};
    for(const node of interior)add(evaluateTowerSite(world,node.x,node.z,placements,result.assumptions).costs);
    for(let i=1;i<route.nodes.length;i++)add(evaluateTransmissionSpan(world,route.nodes[i-1],route.nodes[i],placements,result.assumptions).costs);
    add(terminalConstructionCosts());
    assert.deepEqual(route.costBreakdown,expected);
    assert.equal(route.totalCostCents,sum(expected));
  }
  const balanced=result.candidates.find(route=>route.id==='balanced');
  assert(balanced);
  assert.equal(balanced.totalCostCents,balanced.objectiveCost+sum(terminalConstructionCosts()));
  assert(balanced.totalCostCents<DEMO_BUDGET_CENTS,'the representative route fits the explicit demo budget');
});
