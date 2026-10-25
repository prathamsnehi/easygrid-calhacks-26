import { DEMO_COST_MODEL, COST_KEYS, emptyRouteCosts, applyConstructionAllowances, terminalConstructionCosts } from './cost-model.js';
import { normalizeRoutingConstraints, spanIntersectsExclusion, foundationIntersectsExclusion } from './routing-constraints.js';

/** Fictional preference weights, not dollars or surveyed/legal setbacks. */
export const HUMAN_IMPACT_POLICY = Object.freeze({
  version:'human-activity-v1',unitsPerWeightedTile:1000,
  weights:Object.freeze({farmCorridor:1,homeBuffer:4,workBuffer:2,roadCorridor:1,cropFoundation:8,activityFoundation:12}),
  objective:'Minimize weighted human disturbance first, then terrain-adjusted modeled cost; exact ties use deterministic node order.',
});

/** Deterministic routing on a finite demo support-site graph, not an engineering design. */
export const ROUTING_ASSUMPTIONS = Object.freeze({
  version:'valley-routing-v3',coordinateSystem:'local-demo-grid',sourceMode:'fixture',costModel:DEMO_COST_MODEL,
  humanImpactPolicy:HUMAN_IMPACT_POLICY,gridStep:3,maxSpanTiles:15,foundationWidthTiles:2,corridorHalfWidthTiles:.8,
  supportHeightTiles:10,sagTiles:1.1,conductorRadiusTiles:.045,minClearanceTiles:2,rentHorizonMonths:12,
  rates:Object.freeze({linePerTileCents:DEMO_COST_MODEL.linePerTileCents,towerCents:DEMO_COST_MODEL.towerCents,terminalCents:DEMO_COST_MODEL.terminalCents,
    elevatedTerrainPerTileCents:18000,elevationChangePerTileCents:60000,
    waterPerTileCents:150000,agriculturePerTileCents:35000,vegetationPerTileCents:50000,
    roadPerTileCents:45000,foundationClearingPerTileCents:120000}),
  notes:Object.freeze([
    'Horizontal distance uses 25 meters per tile; vertical heights and facility dimensions remain stylized demo geometry.',
    'Line and support allowances use MISO MTEP24 230 kV single-circuit table values, without escalation; terrain premiums and land/rent rates remain fictional.',
    'Line pricing includes three phase conductors, one optical ground wire, one shield wire and 4% sag/waste; rendered wires do not multiply this price.',
    'Construction adds 10% engineering/PM then 30% contingency on construction plus engineering; land compensation and rent receive no markup.',
    'Balanced routing minimizes additive modeled cost on the declared support-site graph.',
    'The graph uses a 3-tile support lattice, two facility terminals and spans of at most 15 tiles.',
    'Each tower needs a flat 2 × 2 foundation; water, roads, buildings, trees and rocks cannot hold towers.',
    'Overhead spans may cross farms, roads and water, subject to a conservative 0.8-tile corridor and clearance checks.',
    'Land costs use centerline length and tower-pad area at fixture parcel rates, plus 12 months of simulated rent.',
    'Lower-impact routing first minimizes full-corridor exposure to crops, farmstead/worksite buffers, roads and tower-pad disturbance; monetary cost only breaks equal-impact choices.',
    'Activity buffers come from the same fictional farmstead and work objects rendered on this map; they are demo preferences, not regulatory setbacks or real GIS.',
    'Crop clearing is modeled at agricultural tower pads; unknown owner consent remains pending.',
    'This is the least-cost path in this demo graph, not a global geographic or engineering optimum.',
  ]),
});

const STRUCTURES=new Set(['farmstead','wind-pump','fence','hay-bales','bridge']);
const FOUNDATION_OBSTACLES=new Set([...STRUCTURES,'road','tree','orchard-tree','rock']);
const EPS=1e-8;
const emptyCosts=emptyRouteCosts;
const totalCosts=costs=>COST_KEYS.reduce((sum,key)=>sum+(costs[key]??0),0);
function sumCosts(target,source){for(const key of COST_KEYS)target[key]+=source[key]??0;return target;}
function rectOverlap(a,b){return a.x0<b.x1-EPS&&a.x1>b.x0+EPS&&a.z0<b.z1-EPS&&a.z1>b.z0+EPS;}
function parcelFor(world,tile){return world.parcelById?.get(tile.parcelId);}
function isRefused(world,tile,blocked){const p=parcelFor(world,tile);return blocked.has(tile.parcelId)||p?.accessConsent==='refused'||p?.negotiationStatus==='refused';}

/** Exact slab intersection, including corner touches. */
export function segmentRectInterval(a,b,rect){
  let lo=0,hi=1;
  for(const [axis,min,max] of [['x',rect.x0,rect.x1],['z',rect.z0,rect.z1]]){
    const d=b[axis]-a[axis];
    if(Math.abs(d)<EPS){if(a[axis]<min-EPS||a[axis]>max+EPS)return null;continue;}
    let t0=(min-a[axis])/d,t1=(max-a[axis])/d;if(t0>t1)[t0,t1]=[t1,t0];
    lo=Math.max(lo,t0);hi=Math.min(hi,t1);if(lo>hi+EPS)return null;
  }
  return [Math.max(0,lo),Math.min(1,hi)];
}

/** Partition centerline length exactly at grid boundaries; no fixed-step sampling. */
export function traceSpanCells(world,a,b){
  const distance=Math.hypot(b.x-a.x,b.z-a.z),cuts=[0,1];
  if(distance<EPS)return [];
  for(const axis of ['x','z']){
    const delta=b[axis]-a[axis];if(Math.abs(delta)<EPS)continue;
    for(let value=Math.floor(Math.min(a[axis],b[axis]))+1;value<Math.max(a[axis],b[axis])-EPS;value++){
      const t=(value-a[axis])/delta;if(t>EPS&&t<1-EPS)cuts.push(t);
    }
  }
  cuts.sort((x,y)=>x-y);
  const cells=[];
  for(let i=1;i<cuts.length;i++){
    const from=cuts[i-1],to=cuts[i];if(to-from<EPS)continue;
    const t=(from+to)/2,tile=world.tileAt(a.x+(b.x-a.x)*t,a.z+(b.z-a.z)*t);
    cells.push({tile,from,to,length:(to-from)*distance});
  }
  return cells;
}

// Merge intervals so adjacent/overlapping crop tiles do not double count a corridor.
function intervalLength(intervals,length){
  intervals.sort((a,b)=>a[0]-b[0]);let total=0,lo=0,hi=0;
  for(const [from,to] of intervals){if(from>hi){total+=hi-lo;lo=from;hi=to;}else hi=Math.max(hi,to);}
  return (total+hi-lo)*length;
}
function expandedActivity(area,pad=0){
  const margin=area.bufferTiles+pad;
  return {x0:area.x0-margin,x1:area.x1+margin,z0:area.z0-margin,z1:area.z1+margin};
}
function activityFoundationArea(world,foundation){
  // At most four unit foundation cells, using their full area and avoiding overlapping buffers twice.
  let area=0;
  for(let z=Math.floor(foundation.z0);z<Math.ceil(foundation.z1);z++)for(let x=Math.floor(foundation.x0);x<Math.ceil(foundation.x1);x++){
    const cell={x0:Math.max(x,foundation.x0),x1:Math.min(x+1,foundation.x1),z0:Math.max(z,foundation.z0),z1:Math.min(z+1,foundation.z1)};
    if((world.activityAreas??[]).some(a=>rectOverlap(cell,expandedActivity(a))))area+=(cell.x1-cell.x0)*(cell.z1-cell.z0);
  }
  return area;
}
function spanHumanMetrics(world,a,b,pad,length,crops,roads){
  const home=[],work=[];
  for(const area of world.activityAreas??[]){
    const interval=segmentRectInterval(a,b,expandedActivity(area,pad));
    if(interval)(area.kind==='home-and-work'?home:work).push(interval);
  }
  const metrics={farmCorridorLengthTiles:intervalLength(crops,length),roadCorridorLengthTiles:intervalLength(roads,length),
    homeBufferLengthTiles:intervalLength(home,length),workBufferLengthTiles:intervalLength(work,length)};
  const w=HUMAN_IMPACT_POLICY.weights;
  metrics.humanDisturbanceUnits=Math.round(HUMAN_IMPACT_POLICY.unitsPerWeightedTile*(
    metrics.farmCorridorLengthTiles*w.farmCorridor+metrics.homeBufferLengthTiles*w.homeBuffer+
    metrics.workBufferLengthTiles*w.workBuffer+metrics.roadCorridorLengthTiles*w.roadCorridor));
  return metrics;
}

function minimumWireHeight(a,b,lo,hi,config){
  const start=a.groundY+config.supportHeightTiles,end=b.groundY+config.supportHeightTiles,dy=end-start,sag=config.sagTiles;
  const value=t=>start+dy*t-4*sag*t*(1-t);
  const t=sag>0?Math.max(lo,Math.min(hi,(4*sag-dy)/(8*sag))):lo;
  return Math.min(value(lo),value(hi),value(t));
}

/** Full conservative conductor corridor and all affected terrain columns are checked. */
export function evaluateTransmissionSpan(world,a,b,placements,config=ROUTING_ASSUMPTIONS,blocked=new Set()){
  const lengthTiles=Math.hypot(b.x-a.x,b.z-a.z);
  if(lengthTiles<EPS||lengthTiles>config.maxSpanTiles+EPS)return null;
  const pad=config.corridorHalfWidthTiles;
  if(spanIntersectsExclusion(a,b,pad,config.exclusionZones))return null;
  for(const [kind,placement] of Object.entries(placements)){
    if(!placement)continue;
    const f=placement.footprint;
    const terminal=a.facilityKind===kind?a:b.facilityKind===kind?b:null;
    if(terminal){
      const other=terminal===a?b:a;
      if(other.z<f.z1+pad-EPS)return null;
      const body={x0:f.x0-pad,x1:f.x1+pad,z0:f.z0-pad,z1:f.z1-1.05};
      if(segmentRectInterval(a,b,body))return null;
    }else if(segmentRectInterval(a,b,{x0:f.x0-pad,x1:f.x1+pad,z0:f.z0-pad,z1:f.z1+pad}))return null;
  }
  const parcelIds=new Set(),touchedCells=[],cropIntervals=[],roadIntervals=[];
  for(let z=Math.floor(Math.min(a.z,b.z)-pad);z<=Math.floor(Math.max(a.z,b.z)+pad);z++){
    for(let x=Math.floor(Math.min(a.x,b.x)-pad);x<=Math.floor(Math.max(a.x,b.x)+pad);x++){
      const interval=segmentRectInterval(a,b,{x0:x-pad,x1:x+1+pad,z0:z-pad,z1:z+1+pad});
      if(!interval)continue;
      const tile=world.tileAt(x+.5,z+.5);
      if(!tile||isRefused(world,tile,blocked)||tile.routingPolicy?.linePassage==='blocked'||tile.occupiedBy.some(value=>STRUCTURES.has(value)))return null;
      if(tile.terrain==='field'||tile.occupiedBy.includes('agriculture')||tile.occupiedBy.includes('orchard-tree'))cropIntervals.push(interval);
      if(tile.terrain==='road'||tile.occupiedBy.includes('road'))roadIntervals.push(interval);
      const water=tile.terrain==='river';
      const canopy=Math.max(tile.occupiedBy.some(v=>v==='tree'||v==='orchard-tree')?4.5:0,
        tile.terrain==='field'?1.3:0,tile.occupiedBy.includes('rock')?2:0,tile.occupiedBy.includes('grass')?.5:0);
      const terrainTop=(water?.79:tile.height)+canopy;
      if(minimumWireHeight(a,b,...interval,config)-config.conductorRadiusTiles<terrainTop+config.minClearanceTiles-EPS)return null;
      parcelIds.add(tile.parcelId);touchedCells.push({x:tile.x,z:tile.z,parcelId:tile.parcelId});
    }
  }
  const costs=emptyCosts(),metrics={...spanHumanMetrics(world,a,b,pad,lengthTiles,cropIntervals,roadIntervals),waterLengthTiles:0,agricultureLengthTiles:0,vegetationLengthTiles:0,roadLengthTiles:0,elevationChangeTiles:Math.abs(b.groundY-a.groundY)};
  const rates=config.rates;
  costs.lineCents=Math.round(lengthTiles*rates.linePerTileCents);
  let terrain=metrics.elevationChangeTiles*rates.elevationChangePerTileCents,compensation=0,rent=0;
  const centerline=traceSpanCells(world,a,b);
  for(const {tile,length} of centerline){
    if(!tile)return null;
    const parcel=parcelFor(world,tile),prices=parcel?.compensation;
    compensation+=length*(prices?.upfrontPerTileCents??0);
    rent+=length*(prices?.monthlyPerTileCents??0)*config.rentHorizonMonths;
    terrain+=length*Math.max(0,tile.height-1.5)*rates.elevatedTerrainPerTileCents;
    if(tile.terrain==='river'||tile.terrain==='shore')metrics.waterLengthTiles+=length;
    if(tile.terrain==='field')metrics.agricultureLengthTiles+=length;
    if(tile.occupiedBy.some(v=>v==='tree'||v==='orchard-tree'))metrics.vegetationLengthTiles+=length;
    if(tile.terrain==='road')metrics.roadLengthTiles+=length;
  }
  costs.terrainCents=Math.round(terrain);costs.compensationCents=Math.round(compensation);costs.rentCents=Math.round(rent);
  costs.waterCents=Math.round(metrics.waterLengthTiles*rates.waterPerTileCents);
  costs.agricultureCents=Math.round(metrics.agricultureLengthTiles*rates.agriculturePerTileCents);
  costs.vegetationCents=Math.round(metrics.vegetationLengthTiles*rates.vegetationPerTileCents);
  costs.roadCents=Math.round(metrics.roadLengthTiles*rates.roadPerTileCents);
  applyConstructionAllowances(costs);
  return {lengthTiles,costs,metrics,parcelIds:[...parcelIds].filter(Boolean).sort(),touchedCells};
}

export function evaluateTowerSite(world,x,z,placements,config=ROUTING_ASSUMPTIONS,blocked=new Set()){
  const radius=config.foundationWidthTiles/2,foundation={x0:x-radius,x1:x+radius,z0:z-radius,z1:z+radius};
  if(foundationIntersectsExclusion(foundation,config.exclusionZones))return null;
  if(Object.values(placements).some(p=>p&&rectOverlap(foundation,p.footprint)))return null;
  let groundY=null,cropCells=0;const parcelIds=new Set(),costs=emptyCosts();
  for(let tz=Math.floor(foundation.z0);tz<Math.ceil(foundation.z1);tz++){
    for(let tx=Math.floor(foundation.x0);tx<Math.ceil(foundation.x1);tx++){
      const tile=world.tileAt(tx+.5,tz+.5);
      if(!tile||isRefused(world,tile,blocked)||config.blockedTowerParcelIds?.includes(tile.parcelId)||['river','shore','road','farmyard'].includes(tile.terrain)||tile.occupiedBy.some(kind=>FOUNDATION_OBSTACLES.has(kind)))return null;
      if(groundY===null)groundY=tile.height;else if(groundY!==tile.height)return null;
      if(tile.terrain==='field')cropCells++;
      parcelIds.add(tile.parcelId);
      const prices=parcelFor(world,tile)?.compensation;
      costs.compensationCents+=prices?.upfrontPerTileCents??0;
      costs.rentCents+=(prices?.monthlyPerTileCents??0)*config.rentHorizonMonths;
    }
  }
  const activityFoundationAreaTiles=activityFoundationArea(world,foundation);
  const humanDisturbanceUnits=Math.round(HUMAN_IMPACT_POLICY.unitsPerWeightedTile*(cropCells*HUMAN_IMPACT_POLICY.weights.cropFoundation+activityFoundationAreaTiles*HUMAN_IMPACT_POLICY.weights.activityFoundation));
  costs.towerCents=config.rates.towerCents;
  costs.agricultureCents=cropCells*config.rates.foundationClearingPerTileCents;
  applyConstructionAllowances(costs);
  return {x,z,groundY,height:config.supportHeightTiles,kind:'tower',foundation,parcelIds:[...parcelIds].filter(Boolean).sort(),costs,cropCells,activityFoundationAreaTiles,humanDisturbanceUnits};
}

class RouteHeap {
  constructor(){this.items=[];}
  less(a,b){return a.impact<b.impact||(a.impact===b.impact&&(a.cost<b.cost||(a.cost===b.cost&&a.node<b.node)));}
  push(value){let i=this.items.length;this.items.push(value);while(i){const p=(i-1)>>1;if(!this.less(value,this.items[p]))break;this.items[i]=this.items[p];i=p;}this.items[i]=value;}
  pop(){if(!this.items.length)return null;const first=this.items[0],last=this.items.pop();if(this.items.length){let i=0;while(i*2+1<this.items.length){let child=i*2+1;if(child+1<this.items.length&&this.less(this.items[child+1],this.items[child]))child++;if(!this.less(this.items[child],last))break;this.items[i]=this.items[child];i=child;}this.items[i]=last;}return first;}
}

function edgeWeight(edge,destination,profile){
  if(profile==='shortest')return Math.round(edge.lengthTiles*1000000);
  const total=totalCosts(edge.costs)+totalCosts(destination.costs);
  if(profile==='low-impact')return total+4*(edge.costs.waterCents+edge.costs.vegetationCents+edge.costs.roadCents);
  return total;
}

/** Dijkstra with positive, integer edge costs; ties are deterministic. */
export function shortestTransmissionPath(graph,profile='balanced'){
  const distances=new Float64Array(graph.nodes.length);distances.fill(Infinity);distances[graph.start]=0;
  const impacts=new Float64Array(graph.nodes.length);impacts.fill(Infinity);impacts[graph.start]=0;
  const previous=new Int32Array(graph.nodes.length);previous.fill(-1);
  const previousEdge=new Array(graph.nodes.length),queue=new RouteHeap();queue.push({node:graph.start,cost:0,impact:0});
  while(queue.items.length){
    const item=queue.pop();if(item.cost!==distances[item.node]||item.impact!==impacts[item.node])continue;if(item.node===graph.goal)break;
    for(const connection of graph.adjacency[item.node]){
      const weight=edgeWeight(connection.edge,graph.nodes[connection.to],profile);
      if(!Number.isSafeInteger(weight)||weight<0)throw new Error('Routing requires nonnegative safe-integer edge costs.');
      const disturbance=profile==='low-impact'?(connection.edge.metrics?.humanDisturbanceUnits??0)+(graph.nodes[connection.to].humanDisturbanceUnits??0):0;
      const next=item.cost+weight,nextImpact=item.impact+disturbance;
      if(!Number.isSafeInteger(next)||!Number.isSafeInteger(nextImpact)||disturbance<0)throw new Error('Routing objectives must stay within safe nonnegative integers.');
      if(nextImpact<impacts[connection.to]||(nextImpact===impacts[connection.to]&&next<distances[connection.to])){
        distances[connection.to]=next;impacts[connection.to]=nextImpact;previous[connection.to]=item.node;
        previousEdge[connection.to]=connection.edge;queue.push({node:connection.to,cost:next,impact:nextImpact});
      }
    }
  }
  if(!Number.isFinite(distances[graph.goal]))return null;
  const indices=[],edges=[];let at=graph.goal;
  while(at!==-1){indices.push(at);if(previousEdge[at])edges.push(previousEdge[at]);at=previous[at];}
  return {indices:indices.reverse(),edges:edges.reverse(),objectiveCost:distances[graph.goal],objectiveDisturbanceUnits:impacts[graph.goal]};
}

export function buildTransmissionGraph(world,placements,options={}){
  const config={...ROUTING_ASSUMPTIONS,...options,...normalizeRoutingConstraints(world,options),rates:{...ROUTING_ASSUMPTIONS.rates,...options.rates}};
  const blocked=new Set(config.blockedParcelIds);
  if(!Number.isInteger(config.gridStep)||config.gridStep<1||config.gridStep>6||!Number.isFinite(config.maxSpanTiles)||config.maxSpanTiles<1||config.maxSpanTiles>24)throw new Error('Invalid demo graph dimensions.');
  if(Object.values(config.rates).some(rate=>!Number.isSafeInteger(rate)||rate<0))throw new Error('Demo cost rates must be nonnegative safe-integer cents.');
  if(config.foundationWidthTiles!==2||!Number.isFinite(config.corridorHalfWidthTiles)||config.corridorHalfWidthTiles<.8||config.corridorHalfWidthTiles>2||
    !Number.isFinite(config.sagTiles)||config.sagTiles<0||config.sagTiles>3||
    !Number.isFinite(config.conductorRadiusTiles)||config.conductorRadiusTiles<0||config.conductorRadiusTiles>config.corridorHalfWidthTiles-.7+EPS||
    !Number.isFinite(config.minClearanceTiles)||config.minClearanceTiles<0||config.minClearanceTiles>20||
    !Number.isFinite(config.supportHeightTiles)||config.supportHeightTiles<config.sagTiles+config.minClearanceTiles||config.supportHeightTiles>50||
    !Number.isInteger(config.rentHorizonMonths)||config.rentHorizonMonths<0||config.rentHorizonMonths>1200)throw new Error('Invalid demo foundation, clearance or rent assumptions.');
  const nodes=[],adjacency=[],lattice=new Map();
  const add=node=>{node.id=`support-${nodes.length}`;nodes.push(node);adjacency.push([]);return nodes.length-1;};
  for(const kind of ['substation','datacenter']){
    const p=placements[kind];
    add({x:p.connectionPoint.x,z:p.connectionPoint.z,groundY:p.y,height:config.supportHeightTiles,kind:'terminal',facilityKind:kind,parcelIds:[],costs:emptyCosts()});
  }
  const start=0,goal=1,step=config.gridStep;
  for(let z=-world.depth/2+2,iz=0;z<world.depth/2-1;z+=step,iz++){
    for(let x=-world.width/2+2,ix=0;x<world.width/2-1;x+=step,ix++){
      const node=evaluateTowerSite(world,x,z,placements,config,blocked);
      if(node){node.ix=ix;node.iz=iz;lattice.set(`${ix},${iz}`,add(node));}
    }
  }
  const connect=(i,j)=>{
    const a=nodes[i],b=nodes[j];
    if(Math.hypot(b.x-a.x,b.z-a.z)>config.maxSpanTiles+EPS)return;
    const edge=evaluateTransmissionSpan(world,a,b,placements,config,blocked);if(!edge)return;
    adjacency[i].push({to:j,edge});adjacency[j].push({to:i,edge});
  };
  connect(0,1);
  for(let i=2;i<nodes.length;i++){connect(0,i);connect(1,i);}
  const range=Math.ceil(config.maxSpanTiles/step);
  for(let i=2;i<nodes.length;i++){
    const node=nodes[i];
    for(let dz=0;dz<=range;dz++)for(let dx=-range;dx<=range;dx++){
      if((dz===0&&dx<=0)||Math.hypot(dx,dz)*step>config.maxSpanTiles+EPS)continue;
      const j=lattice.get(`${node.ix+dx},${node.iz+dz}`);if(j!==undefined)connect(i,j);
    }
  }
  return {nodes,adjacency,start,goal,config};
}

function routeFromPath(graph,path,profile,world){
  const costBreakdown=emptyCosts(),parcelIds=new Set();
  const metrics={towerCount:0,terminalCount:2,spanCount:path.edges.length,waterSpans:0,roadSpans:0,waterLengthTiles:0,agricultureLengthTiles:0,vegetationLengthTiles:0,roadLengthTiles:0,elevationChangeTiles:0,cropClearingTiles:0,farmCorridorLengthTiles:0,homeBufferLengthTiles:0,workBufferLengthTiles:0,roadCorridorLengthTiles:0,activityFoundationAreaTiles:0,humanDisturbanceUnits:0};
  const nodes=path.indices.map(index=>{
    const node=graph.nodes[index];sumCosts(costBreakdown,node.costs);node.parcelIds.forEach(id=>parcelIds.add(id));
    if(node.kind==='tower'){metrics.towerCount++;metrics.cropClearingTiles+=node.cropCells;metrics.activityFoundationAreaTiles+=node.activityFoundationAreaTiles;metrics.humanDisturbanceUnits+=node.humanDisturbanceUnits;}
    return {id:node.id,x:node.x,z:node.z,groundY:node.groundY,height:node.height,kind:node.kind,
      ...(node.foundation?{foundation:{...node.foundation}}:{}),...(node.facilityKind?{facilityKind:node.facilityKind}:{}),parcelIds:[...node.parcelIds]};
  });
  let lengthTiles=0;
  const spans=path.edges.map((edge,index)=>{
    sumCosts(costBreakdown,edge.costs);edge.parcelIds.forEach(id=>parcelIds.add(id));lengthTiles+=edge.lengthTiles;
    for(const key of ['waterLengthTiles','agricultureLengthTiles','vegetationLengthTiles','roadLengthTiles','elevationChangeTiles','farmCorridorLengthTiles','homeBufferLengthTiles','workBufferLengthTiles','roadCorridorLengthTiles','humanDisturbanceUnits'])metrics[key]+=edge.metrics[key];
    if(edge.metrics.waterLengthTiles>EPS)metrics.waterSpans++;
    if(edge.metrics.roadLengthTiles>EPS)metrics.roadSpans++;
    return {from:nodes[index].id,to:nodes[index+1].id,lengthTiles:edge.lengthTiles,sag:graph.config.sagTiles,parcelIds:[...edge.parcelIds]};
  });
  sumCosts(costBreakdown,terminalConstructionCosts(graph.config.rates.terminalCents));
  const ids=[...parcelIds].sort(),pendingConsentParcelIds=ids.filter(id=>world.parcelById?.get(id)?.accessConsent!=='allowed');
  metrics.parcelCount=ids.length;
  const label={balanced:'Lowest modeled cost',shortest:'Shortest connection','low-impact':'Lower-impact alternative'}[profile];
  const rateOverrides=Object.keys(graph.config.rates).filter(key=>graph.config.rates[key]!==ROUTING_ASSUMPTIONS.rates[key]);
  const costModel={...DEMO_COST_MODEL,effectiveRates:{...graph.config.rates},rateOverrides,
    rateSource:rateOverrides.length?'custom-demo-rates':'miso-benchmark-with-demo-allowances',
    linePerTileCents:graph.config.rates.linePerTileCents,towerCents:graph.config.rates.towerCents,terminalCents:graph.config.rates.terminalCents};
  return {id:profile,label,profile,nodes,spans,parcelIds:ids,pendingConsentParcelIds,lengthTiles,costBreakdown,
    costModel,
    totalCostCents:totalCosts(costBreakdown),metrics,sourceMode:'fixture',coordinateSystem:'local-demo-grid',readyToApprove:false,
    humanImpactPolicy:HUMAN_IMPACT_POLICY,objectiveDisturbanceUnits:metrics.humanDisturbanceUnits,
    objectiveCost:path.objectiveCost,reasons:[
      ...(profile==='low-impact'?['Prioritizes lower modeled disturbance around homes, work areas and crops, then cost; some exposure may be unavoidable.']:[]),
      `${metrics.towerCount} towers and ${metrics.terminalCount} facility terminals connect ${lengthTiles.toFixed(1)} grid units.`,
      `${metrics.waterSpans} water span${metrics.waterSpans===1?'':'s'}; no tower foundations in water or roads.`,
      `${ids.length} distinct parcels affected; ${pendingConsentParcelIds.length} still require owner consent.`,
    ]};
}

export function computeTransmissionRoutes(world,placements,options={}){
  if(!placements?.substation||!placements?.datacenter)return {status:'incomplete',candidates:[],recommendedId:null,reasons:['Place both facilities before calculating a connection.'],assumptions:ROUTING_ASSUMPTIONS};
  if(Object.values(placements).some(p=>p&&(!p.footprint||!p.connectionPoint||
    ![p.y,p.connectionPoint.x,p.connectionPoint.z,p.footprint.x0,p.footprint.x1,p.footprint.z0,p.footprint.z1].every(Number.isFinite)))){
    return {status:'no-route',candidates:[],recommendedId:null,reasons:['Facility connection points are invalid. Place both facilities again.'],assumptions:ROUTING_ASSUMPTIONS};
  }
  const graph=buildTransmissionGraph(world,placements,options),candidates=[],seen=new Set();
  for(const profile of ['balanced','shortest','low-impact']){
    const path=shortestTransmissionPath(graph,profile);if(!path)continue;
    const signature=path.indices.join(',');if(seen.has(signature))continue;seen.add(signature);
    candidates.push(routeFromPath(graph,path,profile,world));
  }
  const assumptions={...graph.config,rates:{...graph.config.rates},graphNodeCount:graph.nodes.length,
    graphEdgeCount:graph.adjacency.reduce((sum,list)=>sum+list.length,0)/2};
  if(!candidates.length)return {status:'no-route',candidates:[],recommendedId:null,
    reasons:['No feasible connection exists in the demo support-site graph.','Try moving a facility to leave its front connection pad clear, or choose another site.'],assumptions};
  candidates.sort((a,b)=>a.totalCostCents-b.totalCostCents||(['balanced','shortest','low-impact'].indexOf(a.id)-['balanced','shortest','low-impact'].indexOf(b.id)));
  return {status:'ok',candidates,recommendedId:candidates[0].id,assumptions,reasons:[
    'The recommended route has the lowest additive modeled cost on the validated demo graph.',
    candidates.length<3?'Some routing objectives produced the same path; duplicate alternatives are omitted.':'Distance-first and lower-impact alternatives are compared using the same modeled cost.',
  ]};
}
