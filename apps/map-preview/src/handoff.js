import { chooseJudgeParcel } from './parcel-analysis.js';

/** Synthetic coordinates exist only to exercise the team's GeoJSON API contract. */
export const DEMO_COORDINATE_TRANSFORM = Object.freeze({
  id:'california-valley-synthetic-wgs84-v1',sourceMode:'fixture',
  localCoordinateSystem:'local-demo-grid',outputCoordinateSystem:'WGS84',
  originLongitude:-120.5,originLatitude:37,metersPerTile:100,earthRadiusMeters:6371008.8,
  xAxis:'east',zAxis:'south',
  method:'Local equirectangular approximation at the declared origin latitude.',
  note:'Invented location and scale for API interoperability. Not surveyed land, measured distances or construction dimensions.',
});

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COST_KEYS=['lineCents','towerCents','terminalCents','terrainCents','waterCents','agricultureCents','vegetationCents','roadCents','compensationCents','rentCents'];
const ACCESS=new Set(['unknown','allowed','refused']);
const NEGOTIATION=new Set(['pending','accepted','refused','counteroffer','review_required']);
function requireId(value,label,max=128){if(typeof value!=='string'||value.length>max||!ID.test(value))throw new Error(`${label} must be a valid identifier.`);return value;}
function integer(value,label,min=0){if(!Number.isSafeInteger(value)||value<min)throw new Error(`${label} must be a safe integer of at least ${min}.`);return value;}
function finite(value,label,min=0){if(!Number.isFinite(value)||value<min)throw new Error(`${label} must be a finite number of at least ${min}.`);return value;}
function total(values,label){return integer(values.reduce((sum,value)=>sum+integer(value,label),0),label);}
function equalIds(a,b){return a.length===b.length&&[...a].sort().every((id,index)=>id===[...b].sort()[index]);}

/** No network, persistence or logging. The normalized participant is private adapter input. */
export function validateDemoParticipant({alias='',phone='',consent=false}={}) {
  const errors=[];
  const name=typeof alias==='string'?alias.trim():'';
  if(typeof alias!=='string'||name.length>80||/[\u0000-\u001f\u007f]/.test(name))errors.push('Use a participant alias of up to 80 characters on one line.');
  const entered=typeof phone==='string'?phone.trim():'';
  const phoneE164=entered.replace(/[\s().-]/g,'');
  if(!/^\+[1-9]\d{7,14}$/.test(phoneE164))errors.push('Enter an international phone number, including + and country code.');
  if(consent!==true)errors.push('Confirm that this participant agreed to receive the AI roleplay demo call.');
  return {valid:errors.length===0,errors,
    participant:errors.length?null:{alias:name||'Judge participant',phoneE164,consent:true}};
}

export function localPointToGeoJSON(x,z) {
  if(!Number.isFinite(x)||!Number.isFinite(z))throw new Error('Local coordinates must be finite.');
  const t=DEMO_COORDINATE_TRANSFORM,radians=Math.PI/180;
  const longitude=t.originLongitude+x*t.metersPerTile/(t.earthRadiusMeters*Math.cos(t.originLatitude*radians))/radians;
  const latitude=t.originLatitude-z*t.metersPerTile/t.earthRadiusMeters/radians;
  if(Math.abs(longitude)>180||Math.abs(latitude)>90)throw new Error('Synthetic coordinates exceed WGS84 bounds.');
  return {type:'Point',coordinates:[longitude,latitude]};
}

/**
 * A shareable, contact-redacted fixture snapshot. This does not import a project,
 * register a phone number, grant land access or start a call.
 */
export function createHandoff({world,route,analysis,placements,participant=null,judgeParcelId=null,
  sessionId,routeVersion,budgetCents=100000000}={}) {
  requireId(sessionId,'Demo session ID',96);integer(routeVersion,'Route version',1);integer(budgetCents,'Demo budget');
  if(!world?.parcelById||!world?.ownerById||!route||!analysis)throw new Error('A selected route and its parcel analysis are required.');
  requireId(route.id,'Route ID');
  if(route.sourceMode!=='fixture'||route.coordinateSystem!=='local-demo-grid'||analysis.sourceMode!=='fixture'||analysis.coordinateSystem!=='local-demo-grid')throw new Error('Only the declared local demo fixture can use this coordinate adapter.');
  if(analysis.routeId!==route.id||!Array.isArray(route.parcelIds)||!route.parcelIds.length||new Set(route.parcelIds).size!==route.parcelIds.length||!Array.isArray(analysis.parcels)||!equalIds(route.parcelIds,analysis.parcels.map(p=>p.parcelId)))throw new Error('Parcel analysis does not match the selected route.');
  if(!Array.isArray(route.nodes)||route.nodes.length<2||!placements?.substation||!placements?.datacenter)throw new Error('Both placed facilities and a connected route are required.');
  const first=route.nodes[0],last=route.nodes[route.nodes.length-1];
  for(const [node,placement] of [[first,placements.substation],[last,placements.datacenter]]){
    if(node.kind!=='terminal'||node.x!==placement.connectionPoint?.x||node.z!==placement.connectionPoint?.z)throw new Error('Route terminals do not match the current facilities.');
  }
  const rentHorizonMonths=integer(analysis.rentHorizonMonths,'Rent horizon',1);
  if(rentHorizonMonths>1200)throw new Error('Rent horizon exceeds the shared contract limit.');
  const costs=route.costBreakdown??{};
  const modeledTotal=total(COST_KEYS.map(key=>costs[key]),'Route cost');
  if(modeledTotal!==route.totalCostCents)throw new Error('Route cost components do not reconcile.');
  if(total(analysis.parcels.map(p=>p.upfrontCents),'Parcel compensation')!==costs.compensationCents||
    total(analysis.parcels.map(p=>p.rentTotalCents),'Parcel rent')!==costs.rentCents||
    analysis.totals?.upfrontCents!==costs.compensationCents||analysis.totals?.rentTotalCents!==costs.rentCents)throw new Error('Parcel costs do not reconcile with the selected route.');
  finite(route.lengthTiles,'Route length',Number.MIN_VALUE);
  if(Math.abs(analysis.parcels.reduce((sum,p)=>sum+finite(p.lineLengthTiles,'Parcel crossed length'),0)-route.lengthTiles)>1e-6)throw new Error('Parcel lengths do not reconcile with the selected route.');
  const selectedJudgeParcel=chooseJudgeParcel(analysis,judgeParcelId);
  if(!selectedJudgeParcel||!route.parcelIds.includes(selectedJudgeParcel))throw new Error('The judge role must belong to an affected route parcel.');
  const validation=validateDemoParticipant({alias:participant?.alias??'',phone:participant?.phoneE164??participant?.phone??'',consent:participant?.consent??false});
  const projectId=`demo-${sessionId}`,contactRef=`${sessionId}:judge`;
  const meta={schemaVersion:1,sourceMode:'fixture',evidenceRefs:[`fixture:${world.parcelFixtureVersion}`,`fixture:${DEMO_COORDINATE_TRANSFORM.id}`]};
  const owners=new Map();
  const parcels=analysis.parcels.map(row=>{
    const parcel=world.parcelById.get(row.parcelId),owner=parcel&&world.ownerById.get(parcel.ownerId);
    if(!parcel?.synthetic||!owner?.synthetic||row.ownerId!==owner.id||!ACCESS.has(row.accessConsent)||!NEGOTIATION.has(row.negotiationStatus))throw new Error('Parcel ownership or status is inconsistent with the fixture.');
    const cap=integer(row.offerCapCents,'Parcel offer cap');
    if(cap!==parcel.compensation?.offerCapCents||row.withinOfferCap!==(row.upfrontCents<=cap))throw new Error('Parcel offer-cap analysis is inconsistent.');
    if(row.accessConsent!==parcel.accessConsent||row.negotiationStatus!==parcel.negotiationStatus)throw new Error('Parcel consent analysis is stale.');
    const area=finite(parcel.areaTiles,'Parcel area',Number.MIN_VALUE);
    if(parcel.geometry?.coordinateSystem!=='local-demo-grid'||parcel.geometry?.type!=='Polygon'||!Array.isArray(parcel.geometry.rings))throw new Error('Parcel geometry must use the local demo grid.');
    const coordinates=parcel.geometry.rings.map(ring=>{
      if(ring.length<4||ring[0][0]!==ring[ring.length-1][0]||ring[0][1]!==ring[ring.length-1][1])throw new Error('Parcel rings must be closed.');
      return ring.map(([x,z])=>localPointToGeoJSON(x,z).coordinates);
    });
    owners.set(owner.id,{...meta,id:owner.id,alias:owner.alias,synthetic:true});
    return {...meta,id:parcel.id,projectId,geometry:{type:'Polygon',coordinates},ownerId:owner.id,ownerAlias:owner.alias,
      synthetic:true,landUse:parcel.landUse,areaSqM:area*DEMO_COORDINATE_TRANSFORM.metersPerTile**2,
      offerCapCents:cap,accessConsent:row.accessConsent,negotiationStatus:row.negotiationStatus};
  });
  const eligible=analysis.parcels.every(row=>row.withinOfferCap&&row.accessConsent!=='refused'&&row.negotiationStatus!=='refused')&&modeledTotal<=budgetCents;
  const reasons=['Synthetic geometry and pricing; owner consent and regulatory checks are not complete.'];
  if(analysis.parcels.some(row=>!row.withinOfferCap))reasons.push('An affected parcel exceeds its fictional upfront offer cap.');
  if(analysis.parcels.some(row=>row.accessConsent==='refused'||row.negotiationStatus==='refused'))reasons.push('An affected parcel has refused access.');
  if(modeledTotal>budgetCents)reasons.push('The selected route exceeds the fictional handoff budget.');
  const candidate={...meta,id:route.id,projectId,version:routeVersion,
    geometry:{type:'LineString',coordinates:route.nodes.map(node=>localPointToGeoJSON(node.x,node.z).coordinates)},
    parcelIds:[...route.parcelIds],lengthMeters:route.lengthTiles*DEMO_COORDINATE_TRANSFORM.metersPerTile,
    constructionCents:modeledTotal-costs.compensationCents-costs.rentCents,
    upfrontCompensationCents:costs.compensationCents,recurringRentTotalCents:costs.rentCents,
    separateDepositTotalCents:0,totalCostCents:modeledTotal,eligible,readyToApprove:false,reasons,regulatoryChecks:[]};
  const project={...meta,id:projectId,revision:0,
    endpointA:localPointToGeoJSON(first.x,first.z),endpointB:localPointToGeoJSON(last.x,last.z),
    budgetCents,rentHorizonMonths,selectedRouteId:route.id,approvedRouteVersion:null,status:'draft'};
  const judgeRow=analysis.parcels.find(row=>row.parcelId===selectedJudgeParcel);
  const parcelAnalysis=analysis.parcels.map(row=>({
    parcelId:row.parcelId,name:row.name,ownerId:row.ownerId,ownerAlias:row.ownerAlias,
    displayOwnerAlias:row.parcelId===selectedJudgeParcel?'Judge participant':row.ownerAlias,
    judgeRole:row.parcelId===selectedJudgeParcel,synthetic:true,
    contactRef:row.parcelId===selectedJudgeParcel?contactRef:row.contactRef,
    email:row.parcelId===selectedJudgeParcel?null:row.email,
    phoneDisplay:row.parcelId===selectedJudgeParcel?'Private demo participant':row.phoneDisplay,
    landUse:row.landUse,areaTiles:row.areaTiles,lineLengthTiles:row.lineLengthTiles,
    towerCount:row.towerCount,towerIds:[...row.towerIds],foundationAreaTiles:row.foundationAreaTiles,
    upfrontCents:row.upfrontCents,rentTotalCents:row.rentTotalCents,
    monthlyRentEquivalentCents:row.monthlyRentCents,monthlyRentIsApproximate:row.monthlyRentIsApproximate,
    offerCapCents:row.offerCapCents,withinOfferCap:row.withinOfferCap,
    accessConsent:row.accessConsent,negotiationStatus:row.negotiationStatus,
    affectReasons:[...row.affectReasons],corridorOnly:row.corridorOnly,
  }));
  return {
    schemaVersion:1,kind:'easygrid-map-handoff',sourceMode:'fixture',sessionId,routeVersion,
    coordinateTransform:{...DEMO_COORDINATE_TRANSFORM},
    snapshot:{project,owners:[...owners.values()],parcels,routes:[candidate],negotiations:[],easements:[],approvals:[],payments:[],reconciliations:[],events:[]},
    parcelAnalysis,
    judgeRole:{parcelId:selectedJudgeParcel,ownerId:judgeRow.ownerId,originalOwnerAlias:judgeRow.ownerAlias,
      displayAlias:'Judge participant',participantContactRef:contactRef,
      participantReady:validation.valid,participantConsent:validation.valid,
      assignmentMode:'demo-roleplay-overlay',note:'A consenting participant plays this fictional owner. The base parcel and owner are unchanged.'},
    callPreparation:{status:!eligible?'review-required':validation.valid?'ready-for-host-adapter':'participant-required',
      canStartCall:false,backendBindingRequired:true,contactRegistered:false,
      proposedTerms:{upfrontCents:judgeRow.upfrontCents,offerCapCents:judgeRow.offerCapCents,
        rentTotalCents:judgeRow.rentTotalCents,monthlyRentEquivalentCents:judgeRow.monthlyRentCents,
        monthlyRentIsApproximate:judgeRow.monthlyRentIsApproximate,termMonths:rentHorizonMonths,depositCents:0},
      note:'This is an offline fixture handoff. The host must import it, bind canonical backend IDs and revisions, privately register the consented participant, and confirm any call action. Call consent does not grant land access. Monthly rent is a rounded equivalent, not negotiated terms.',
      budgetNote:'The default USD 1,000,000 budget is fictional and is not an approved project budget.'},
  };
}

/** Build only after the host has supplied canonical backend IDs and registered a contact. */
export function buildCallSessionRequest({projectId,expectedRevision,parcelId,routeVersion,
  registeredContactRef,participantConsent,idempotencyKey}={}) {
  requireId(projectId,'Backend project ID');requireId(parcelId,'Backend parcel ID');
  requireId(registeredContactRef,'Registered participant contact reference');requireId(idempotencyKey,'Call idempotency key');
  integer(expectedRevision,'Backend project revision');integer(routeVersion,'Backend route version',1);
  if(participantConsent!==true)throw new Error('Explicit demo participant consent is required.');
  return {schemaVersion:1,projectId,expectedRevision,parcelId,routeVersion,
    participantContactRef:registeredContactRef,participantConsent:true,idempotencyKey};
}
