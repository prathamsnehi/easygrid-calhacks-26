import {ROUTING_ASSUMPTIONS, evaluateTowerSite, evaluateTransmissionSpan} from './routing.js';
import {analyzeRouteParcels} from './parcel-analysis.js';
import {COST_KEYS, emptyRouteCosts, terminalConstructionCosts, DEMO_BUDGET_CENTS} from './cost-model.js';
import {normalizeRoutingConstraints} from './routing-constraints.js';

/** Fixture geometry only: these distances are not engineering/legal setbacks. */
export const CONDITIONAL_RELOCATION_POLICY = Object.freeze({
  version:'parcel-edge-translation-v1',coordinateSystem:'local-demo-grid',
  directions:Object.freeze(['north','south','east','west']),target:'edge',
  edgeBandTiles:4,innerSetbackTiles:1,xAxis:'east',zAxis:'south',
  scope:'All tower pads on the original parcel; unchanged crossing spans and other parcels.',
});
const copy = value => JSON.parse(JSON.stringify(value));
const cents = value => Number.isSafeInteger(value) && value >= 0;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const sameIds = (a,b) => same([...a].sort(),[...b].sort());
const sum = costs => COST_KEYS.reduce((total,key) => total + costs[key],0);
const construction = costs => sum(costs) - costs.compensationCents - costs.rentCents;
const check = (value,message) => {if (!value) throw new Error(message);};
const onlyParcel = (ids,id) => ids.length === 1 && ids[0] === id;

function configFor(world,assumptions) {
  const config = {...ROUTING_ASSUMPTIONS,...assumptions,...normalizeRoutingConstraints(world,assumptions),
    rates:{...ROUTING_ASSUMPTIONS.rates,...assumptions.rates}};
  check(config.foundationWidthTiles === 2 && config.corridorHalfWidthTiles >= .8 && config.corridorHalfWidthTiles <= 2 &&
    config.maxSpanTiles >= 1 && config.maxSpanTiles <= 24 && config.sagTiles >= 0 && config.sagTiles <= 3 &&
    config.minClearanceTiles >= 0 && config.minClearanceTiles <= 20 && config.conductorRadiusTiles >= 0 &&
    config.conductorRadiusTiles <= config.corridorHalfWidthTiles-.7+1e-8 &&
    config.supportHeightTiles >= config.sagTiles+config.minClearanceTiles && config.supportHeightTiles <= 50 &&
    Number.isInteger(config.rentHorizonMonths) && config.rentHorizonMonths >= 0 && config.rentHorizonMonths <= 1200 &&
    Object.values(config.rates).every(cents),'The routing assumptions are unsupported.');
  return config;
}

// Re-evaluate the entire support chain with the current routing safety/cost model.
// Never move a rendered support without rebuilding its physical spans and costs.
function rebuild(world,source,nodes,placements,config) {
  const costs = emptyRouteCosts(), ids = new Set(), blocked = new Set(config.blockedParcelIds);
  const add = values => {for (const key of COST_KEYS) costs[key] += values[key];};
  const metrics = {towerCount:0,terminalCount:2,spanCount:nodes.length-1,waterSpans:0,roadSpans:0,
    waterLengthTiles:0,agricultureLengthTiles:0,vegetationLengthTiles:0,roadLengthTiles:0,elevationChangeTiles:0,
    cropClearingTiles:0,farmCorridorLengthTiles:0,homeBufferLengthTiles:0,workBufferLengthTiles:0,
    roadCorridorLengthTiles:0,activityFoundationAreaTiles:0,humanDisturbanceUnits:0};
  const sites = nodes.map((node,index) => {
    if (index === 0 || index === nodes.length-1) {
      const kind = index === 0 ? 'substation' : 'datacenter', placement = placements[kind];
      check(node.kind === 'terminal' && node.facilityKind === kind && placement && node.x === placement.connectionPoint.x &&
        node.z === placement.connectionPoint.z && node.groundY === placement.y,'Facility terminals changed.');
      return null;
    }
    const site = evaluateTowerSite(world,node.x,node.z,placements,config,blocked);
    check(site && node.kind === 'tower' && Number.isInteger(node.x) && Number.isInteger(node.z),'A tower foundation is not feasible.');
    check(node.height === site.height && node.groundY === site.groundY && same(node.foundation,site.foundation) && sameIds(node.parcelIds,site.parcelIds),'Tower geometry or parcel metadata is stale.');
    add(site.costs);site.parcelIds.forEach(id=>ids.add(id));metrics.towerCount++;
    metrics.cropClearingTiles += site.cropCells;metrics.activityFoundationAreaTiles += site.activityFoundationAreaTiles;
    metrics.humanDisturbanceUnits += site.humanDisturbanceUnits;
    return site;
  });
  for (let i=1;i<sites.length-1;i++) for (let j=i+1;j<sites.length-1;j++) {
    const a=sites[i].foundation,b=sites[j].foundation;
    check(!(a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0),'Tower foundations would overlap.');
  }
  let lengthTiles = 0, objectiveCost = 0;
  const spans = nodes.slice(1).map((b,index) => {
    const a = nodes[index], edge = evaluateTransmissionSpan(world,a,b,placements,config,blocked);
    check(edge,'A conductor corridor, clearance or span constraint is not feasible.');
    add(edge.costs);edge.parcelIds.forEach(id=>ids.add(id));lengthTiles += edge.lengthTiles;
    for (const key of ['waterLengthTiles','agricultureLengthTiles','vegetationLengthTiles','roadLengthTiles','elevationChangeTiles',
      'farmCorridorLengthTiles','homeBufferLengthTiles','workBufferLengthTiles','roadCorridorLengthTiles','humanDisturbanceUnits']) metrics[key] += edge.metrics[key];
    if (edge.metrics.waterLengthTiles > 1e-8) metrics.waterSpans++;
    if (edge.metrics.roadLengthTiles > 1e-8) metrics.roadSpans++;
    objectiveCost += source.profile === 'shortest' ? Math.round(edge.lengthTiles*1000000) :
      sum(edge.costs) + (sites[index+1] ? sum(sites[index+1].costs) : 0) +
      (source.profile === 'low-impact' ? 4*(edge.costs.waterCents+edge.costs.vegetationCents+edge.costs.roadCents) : 0);
    return {from:a.id,to:b.id,lengthTiles:edge.lengthTiles,sag:config.sagTiles,parcelIds:edge.parcelIds};
  });
  add(terminalConstructionCosts(config.rates.terminalCents));
  check(COST_KEYS.every(key=>cents(costs[key])) && cents(sum(costs)) && cents(objectiveCost),'Recomputed costs exceed exact integer cents.');
  metrics.parcelCount = ids.size;
  return {...copy(source),nodes:copy(nodes),spans,parcelIds:[...ids].sort(),lengthTiles,costBreakdown:costs,
    totalCostCents:sum(costs),metrics,objectiveCost,objectiveDisturbanceUnits:metrics.humanDisturbanceUnits,
    readyToApprove:false};
}

function atEdge(f,b,direction) {
  const {edgeBandTiles:band,innerSetbackTiles:inset} = CONDITIONAL_RELOCATION_POLICY;
  if (f.x0 < b.x0+inset || f.x1 > b.x1-inset || f.z0 < b.z0+inset || f.z1 > b.z1-inset) return false;
  return direction === 'north' ? f.z1 <= b.z0+band : direction === 'south' ? f.z0 >= b.z1-band :
    direction === 'east' ? f.x0 >= b.x1-band : f.x1 <= b.x0+band;
}

/**
 * Takes canonical conditions only, never natural-language claims or approvals.
 * Costs on returned route are geometry estimates. Agreed compensation/rent are
 * copied unchanged; the budget uses only the change in construction costs.
 * Conservative finite search: translate unsatisfied owned towers along one axis;
 * preserve anchors already at that edge. All owned towers must satisfy the edge. If
 * this cannot prove the condition without changing crossing spans, seek review.
 */
export function relocateWithinParcel({world,route,placements,parcelId,condition,assumptions = ROUTING_ASSUMPTIONS,
  budgetCents = DEMO_BUDGET_CENTS,currentTotalCents = route?.totalCostCents,agreedTermsByParcel = {}} = {}) {
  const review = reason => ({status:'review_required',reason,route:null,conditionEvidence:null,changedNodeIds:[],changedSpanIndices:[]});
  try {
    check(condition && Object.keys(condition).length === 2 && condition.target === 'edge' &&
      CONDITIONAL_RELOCATION_POLICY.directions.includes(condition.direction),'Only an explicit north/south/east/west parcel-edge tower condition is supported.');
    check(world?.parcelById instanceof Map && route?.nodes?.length >= 3 && Array.isArray(route.spans),'The current route or parcel fixture is missing.');
    const parcel = world.parcelById.get(parcelId), bounds = parcel?.bounds;
    check(parcel?.synthetic === true && bounds && ['x0','x1','z0','z1'].every(key=>Number.isFinite(bounds[key])) &&
      bounds.x1 > bounds.x0 && bounds.z1 > bounds.z0,'The original fictional parcel bounds are unavailable.');
    check(cents(budgetCents) && cents(currentTotalCents),'The current exact project total and budget are required.');
    const config = configFor(world,assumptions), beforeAnalysis = analyzeRouteParcels(world,route,config);
    const before = rebuild(world,route,route.nodes,placements,config);
    check(COST_KEYS.every(key=>route.costBreakdown[key] === before.costBreakdown[key]) && route.totalCostCents === before.totalCostCents,'The original route costs are stale.');
    const targetIndices = route.nodes.flatMap((node,index)=>node.kind === 'tower' && node.parcelIds.includes(parcelId) ? [index] : []);
    check(targetIndices.length,'The original parcel has no tower to relocate.');
    check(targetIndices.every(index=>onlyParcel(route.nodes[index].parcelIds,parcelId)),'A shared tower pad cannot be moved by one parcel owner.');
    const indices = targetIndices.filter(index=>!atEdge(route.nodes[index].foundation,bounds,condition.direction));
    check(indices.length,'All existing towers already meet this edge condition; no relocation was performed.');
    const moved = new Set(indices), changedSpanIndices = route.spans.flatMap((_,index)=>moved.has(index)||moved.has(index+1) ? [index] : []);
    check(changedSpanIndices.every(index=>onlyParcel(before.spans[index].parcelIds,parcelId)),
      'Relocating these towers would change a crossing span on another parcel, even if the affected owner list stayed the same.');
    const axis = ['north','south'].includes(condition.direction) ? 'z' : 'x';
    const sign = ['north','west'].includes(condition.direction) ? -1 : 1;
    const limit = Math.ceil(bounds[`${axis}1`]-bounds[`${axis}0`]);
    check(limit <= 256,'The parcel exceeds the supported finite relocation search.');
    for (let distance = 1; distance <= limit; distance++) {
      const nodes = copy(route.nodes);let feasible = true;
      for (const index of indices) {
        const old = nodes[index], location = {...old,[axis]:old[axis]+sign*distance};
        const site = evaluateTowerSite(world,location.x,location.z,placements,config,new Set(config.blockedParcelIds));
        if (!site || !onlyParcel(site.parcelIds,parcelId) || !atEdge(site.foundation,bounds,condition.direction)) {feasible=false;break;}
        nodes[index] = {...old,x:site.x,z:site.z,groundY:site.groundY,height:site.height,foundation:site.foundation,parcelIds:site.parcelIds};
      }
      if (!feasible) continue;
      try {
        const candidate = rebuild(world,route,nodes,placements,config);
        if (!sameIds(candidate.parcelIds,before.parcelIds) || !changedSpanIndices.every(index=>onlyParcel(candidate.spans[index].parcelIds,parcelId))) continue;
        // Outside geometry must be identical, not just its parcel ID set.
        if (!nodes.every((node,index)=>moved.has(index)||same(node,route.nodes[index])) ||
          !candidate.spans.every((span,index)=>changedSpanIndices.includes(index)||same(span,before.spans[index]))) continue;
        const analysis = analyzeRouteParcels(world,candidate,config);
        if (!beforeAnalysis.parcels.filter(row=>row.parcelId !== parcelId).every(row=>same(row,analysis.parcels.find(next=>next.parcelId === row.parcelId)))) continue;
        const constructionCostDeltaCents = construction(candidate.costBreakdown)-construction(before.costBreakdown);
        const updatedTotalCents = currentTotalCents+constructionCostDeltaCents;
        if (!cents(updatedTotalCents) || updatedTotalCents > budgetCents) continue;
        candidate.reasons = ['Verified local parcel-edge relocation; other parcel geometry is unchanged.','Geometry estimates do not replace any agreed compensation or rent.'];
        return {status:'applied',reason:'The requested edge condition is geometrically verified within the original parcel.',route:candidate,
          changedNodeIds:indices.map(index=>nodes[index].id),changedSpanIndices,
          modeledCostDeltaCents:candidate.totalCostCents-before.totalCostCents,constructionCostDeltaCents,
          currentTotalCents,updatedTotalCents,budgetCents,agreedTermsByParcel:copy(agreedTermsByParcel),
          conditionEvidence:{policyVersion:CONDITIONAL_RELOCATION_POLICY.version,parcelId,condition:copy(condition),
            coordinateSystem:'local-demo-grid',xAxis:'east',zAxis:'south',edgeBandTiles:4,innerSetbackTiles:1,
            translation:{x:axis === 'x' ? sign*distance : 0,z:axis === 'z' ? sign*distance : 0},
            originalParcelIds:[...before.parcelIds],outsideGeometryUnchanged:true,otherOwnerTermsUnchanged:true,
            towers:targetIndices.map(index=>({id:nodes[index].id,changed:moved.has(index),before:{x:route.nodes[index].x,z:route.nodes[index].z},
              after:{x:nodes[index].x,z:nodes[index].z},foundation:copy(nodes[index].foundation)}))}};
      } catch { /* This candidate fails geometry, allocation or exact-cent checks. */ }
    }
    return review('No supported parcel-edge translation satisfies geometry, other-owner protection and the current exact budget.');
  } catch (error) {return review(error.message ?? 'The relocation cannot be verified.');}
}
