import { ROUTING_ASSUMPTIONS, evaluateTransmissionSpan, evaluateTowerSite, traceSpanCells } from './routing.js';
import { negotiationLimitCents, createOfferPolicy } from './offer-policy.js';

const EPSILON=1e-7;
/** Demo compensation scope: an unoccupied buffer touch is informational only. */
export function isCorridorOverlapOnly(row){
  return Number.isFinite(row?.lineLengthTiles)&&row.lineLengthTiles>=0&&row.lineLengthTiles<=EPSILON&&
    row.towerCount===0&&(row.foundationAreaTiles??0)===0;
}
const sum=(values)=>values.reduce((total,value)=>total+value,0);
function check(condition,message){if(!condition)throw new Error(`Parcel analysis: ${message}`);}
function cents(value){return Number.isSafeInteger(value)&&value>=0;}
function near(a,b){return Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=EPSILON*Math.max(1,Math.abs(a),Math.abs(b));}
function sameIds(a,b){return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&[...a].sort().every((id,i)=>id===[...b].sort()[i]);}

// Routing rounds each entire span, not each parcel. Allocate its rounded cents
// by largest fractional remainder so the owner table cannot invent or lose money.
function allocateSpanCents(rawByParcel,target,rows,key){
  check(cents(target),'a span amount is not valid integer cents.');
  const portions=[...rawByParcel].map(([parcelId,amount])=>{
    check(Number.isFinite(amount)&&amount>=0,'a span allocation is invalid.');
    return {parcelId,whole:Math.floor(amount),fraction:amount-Math.floor(amount)};
  });
  const remainder=target-sum(portions.map(portion=>portion.whole));
  check(Number.isInteger(remainder)&&remainder>=0&&remainder<=portions.length,'a span cannot be reconciled to its parcel rates.');
  portions.sort((a,b)=>b.fraction-a.fraction||a.parcelId.localeCompare(b.parcelId));
  portions.forEach((portion,index)=>{rows.get(portion.parcelId)[key]+=portion.whole+(index<remainder?1:0);});
}

/** Read-only, route-specific land costs. Distances remain fictional grid tiles. */
export function analyzeRouteParcels(world,route,assumptions=ROUTING_ASSUMPTIONS){
  check(world?.parcelById instanceof Map&&world?.ownerById instanceof Map&&typeof world.tileAt==='function','the parcel fixture is unavailable.');
  check(route&&typeof route.id==='string'&&route.id.length>0,'select a route first.');
  check(route.sourceMode==='fixture'&&route.coordinateSystem==='local-demo-grid','only local fixture routes can be analyzed.');
  check(Array.isArray(route.nodes)&&route.nodes.length>=2&&Array.isArray(route.spans)&&route.spans.length===route.nodes.length-1,'the route is not a connected support chain.');
  check(Array.isArray(route.parcelIds)&&route.parcelIds.length>0&&new Set(route.parcelIds).size===route.parcelIds.length,'affected parcel IDs are empty or duplicated.');
  check(assumptions&&Number.isInteger(assumptions.rentHorizonMonths)&&assumptions.rentHorizonMonths>=0&&assumptions.rentHorizonMonths<=1200,'the rent horizon is invalid.');
  check(assumptions.foundationWidthTiles===2&&Number.isFinite(assumptions.corridorHalfWidthTiles)&&assumptions.corridorHalfWidthTiles>=.8&&assumptions.corridorHalfWidthTiles<=2,'the analysis requires the supported tower foundation and corridor.');
  check(cents(route.costBreakdown?.compensationCents)&&cents(route.costBreakdown?.rentCents),'route land costs are missing or invalid.');
  const months=assumptions.rentHorizonMonths,rows=new Map();
  for(const parcelId of route.parcelIds){
    const parcel=world.parcelById.get(parcelId),owner=world.ownerById.get(parcel?.ownerId);
    check(parcel&&owner,`fixture owner or parcel ${parcelId} is missing.`);
    check(parcel.synthetic===true&&owner.synthetic===true,`parcel ${parcelId} is not a fictional owner record.`);
    check(owner.dialTarget==null,`parcel ${parcelId} must not expose a live dial target in its fixture.`);
    const prices=parcel.compensation;
    check(prices&&cents(prices.upfrontPerTileCents)&&cents(prices.monthlyPerTileCents),`parcel ${parcelId} has invalid compensation rates.`);
    check(typeof owner.alias==='string'&&owner.alias.length>0,`parcel ${parcelId} has no owner alias.`);
    rows.set(parcelId,{
      parcelId,name:parcel.name,ownerId:owner.id,ownerAlias:owner.alias,
      contactRef:owner.contactRef,email:owner.email,phoneDisplay:owner.phoneDisplay,
      landUse:parcel.landUse,areaTiles:parcel.areaTiles,sourceMode:'fixture',synthetic:true,
      lineLengthTiles:0,towerCount:0,towerIds:[],foundationAreaTiles:0,
      upfrontCents:0,rentTotalCents:0,monthlyRentCents:0,monthlyRentIsApproximate:false,
      lineCompensationCents:0,foundationCompensationCents:0,
      recommendedOfferCents:0,offerCapCents:0,withinOfferCap:true,
      accessConsent:parcel.accessConsent,negotiationStatus:parcel.negotiationStatus,
      affectReasons:[],corridorOnly:false,
    });
  }
  const nodeIds=new Set(),affected=new Set(),corridor=new Set();
  let uniqueTowerCount=0;
  function rowFor(parcelId){const row=rows.get(parcelId);check(row,`route metadata omits affected parcel ${parcelId}.`);affected.add(parcelId);return row;}
  for(let index=0;index<route.nodes.length;index++){
    const node=route.nodes[index];
    check(node&&typeof node.id==='string'&&!nodeIds.has(node.id)&&[node.x,node.z,node.groundY,node.height].every(Number.isFinite),'support IDs or coordinates are invalid.');
    nodeIds.add(node.id);
    const terminal=index===0||index===route.nodes.length-1;
    check(node.kind===(terminal?'terminal':'tower'),'the route must have two end terminals and interior towers.');
    check(near(node.height,assumptions.supportHeightTiles),'support heights do not match the route assumptions.');
    if(terminal)continue;
    const evaluated=evaluateTowerSite(world,node.x,node.z,{},assumptions);
    check(evaluated,`tower ${node.id} is no longer feasible; recalculate the route.`);
    check(near(node.groundY,evaluated.groundY)&&node.foundation&&['x0','x1','z0','z1'].every(key=>near(node.foundation[key],evaluated.foundation[key])),`tower ${node.id} has stale foundation geometry.`);
    check(sameIds(node.parcelIds,evaluated.parcelIds),`tower ${node.id} has stale affected parcels.`);
    // The routing graph uses integer-centered 2x2 pads, each priced cell is one tile.
    const f=evaluated.foundation;
    check([f.x0,f.x1,f.z0,f.z1].every(Number.isInteger),'foundation edges must align with the demo tile grid.');
    uniqueTowerCount++;
    for(let z=f.z0;z<f.z1;z++)for(let x=f.x0;x<f.x1;x++){
      const tile=world.tileAt(x+.5,z+.5),row=rowFor(tile.parcelId),prices=world.parcelById.get(tile.parcelId).compensation;
      row.foundationAreaTiles++;row.foundationCompensationCents+=prices.upfrontPerTileCents;row.rentTotalCents+=prices.monthlyPerTileCents*months;
      if(!row.towerIds.includes(node.id))row.towerIds.push(node.id);
    }
  }
  for(let index=0;index<route.spans.length;index++){
    const span=route.spans[index],a=route.nodes[index],b=route.nodes[index+1];
    check(span&&span.from===a.id&&span.to===b.id,'span order does not match its supports.');
    check(near(span.sag,assumptions.sagTiles),'span sag does not match the route assumptions.');
    const evaluated=evaluateTransmissionSpan(world,a,b,{},assumptions);
    check(evaluated,'a span is no longer feasible; recalculate the route.');
    check(near(span.lengthTiles,evaluated.lengthTiles)&&sameIds(span.parcelIds,evaluated.parcelIds),'span geometry or affected parcels are stale.');
    for(const parcelId of evaluated.parcelIds){rowFor(parcelId);corridor.add(parcelId);}
    const upfront=new Map(),rent=new Map();
    for(const {tile,length} of traceSpanCells(world,a,b)){
      check(tile,'the centerline leaves the parcel fixture.');
      const row=rowFor(tile.parcelId),prices=world.parcelById.get(tile.parcelId).compensation;
      row.lineLengthTiles+=length;
      upfront.set(tile.parcelId,(upfront.get(tile.parcelId)??0)+length*prices.upfrontPerTileCents);
      rent.set(tile.parcelId,(rent.get(tile.parcelId)??0)+length*prices.monthlyPerTileCents*months);
    }
    allocateSpanCents(upfront,evaluated.costs.compensationCents,rows,'lineCompensationCents');
    allocateSpanCents(rent,evaluated.costs.rentCents,rows,'rentTotalCents');
  }
  check(sameIds([...affected],route.parcelIds),'the route contains parcels that its geometry does not affect.');
  const parcels=[...rows.values()].sort((a,b)=>a.parcelId.localeCompare(b.parcelId));
  for(const row of parcels){
    row.towerCount=row.towerIds.length;
    row.upfrontCents=row.lineCompensationCents+row.foundationCompensationCents;
    row.recommendedOfferCents=row.upfrontCents;
    row.offerCapCents=negotiationLimitCents(row.recommendedOfferCents);
    row.offerPolicy=createOfferPolicy(row.recommendedOfferCents);
    row.compensationBreakdown={lineCents:row.lineCompensationCents,foundationCents:row.foundationCompensationCents};
    row.monthlyRentCents=months===0?0:Math.round(row.rentTotalCents/months);
    row.monthlyRentIsApproximate=row.monthlyRentCents*months!==row.rentTotalCents;
    row.withinOfferCap=row.upfrontCents<=row.offerCapCents;
    row.corridorOnly=isCorridorOverlapOnly(row);
    // Excluded from this demo's compensation/approval scope, not an accepted $0 agreement.
    row.recommendationStatus=row.corridorOnly?'excluded-corridor-overlap':'estimated';
    if(corridor.has(row.parcelId))row.affectReasons.push('line-corridor');
    if(row.lineLengthTiles>EPSILON)row.affectReasons.push('line-centerline');
    if(row.towerCount>0)row.affectReasons.push('tower-foundation');
    check(cents(row.upfrontCents)&&cents(row.rentTotalCents)&&cents(row.monthlyRentCents),'parcel costs exceed safe integer cents.');
  }
  const totals={parcelCount:parcels.length,lineLengthTiles:sum(parcels.map(p=>p.lineLengthTiles)),
    towerCount:uniqueTowerCount,parcelTowerTouches:sum(parcels.map(p=>p.towerCount)),
    foundationAreaTiles:sum(parcels.map(p=>p.foundationAreaTiles)),
    upfrontCents:sum(parcels.map(p=>p.upfrontCents)),rentTotalCents:sum(parcels.map(p=>p.rentTotalCents))};
  check(cents(totals.upfrontCents)&&cents(totals.rentTotalCents),'total costs exceed safe integer cents.');
  check(totals.upfrontCents===route.costBreakdown.compensationCents&&totals.rentTotalCents===route.costBreakdown.rentCents,'land costs changed or assumptions do not match; recalculate the route.');
  check(near(totals.lineLengthTiles,route.lengthTiles)&&uniqueTowerCount===route.metrics?.towerCount,'route totals do not match its geometry.');
  return {routeId:route.id,sourceMode:'fixture',coordinateSystem:'local-demo-grid',rentHorizonMonths:months,parcels,totals};
}

/** Keep the user role on an affected parcel; every valid nonempty route gets one. */
export function chooseUserParcel(analysis,previousParcelId=null){
  const parcels=analysis?.parcels?.filter(row=>!isCorridorOverlapOnly(row));
  if(!Array.isArray(parcels)||parcels.length===0)return null;
  if(parcels.some(parcel=>parcel.parcelId===previousParcelId))return previousParcelId;
  return [...parcels].sort((a,b)=>Number(b.towerCount>0)-Number(a.towerCount>0)||b.lineLengthTiles-a.lineLengthTiles||a.parcelId.localeCompare(b.parcelId))[0].parcelId;
}
