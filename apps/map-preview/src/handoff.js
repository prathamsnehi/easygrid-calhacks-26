import { chooseUserParcel } from './parcel-analysis.js';
import { DEMO_METERS_PER_TILE, DEMO_BUDGET_CENTS, COST_KEYS, DEMO_COST_MODEL } from './cost-model.js';

/** Synthetic coordinates exist only to exercise the team's GeoJSON API contract. */
export const DEMO_COORDINATE_TRANSFORM = Object.freeze({
  id:'california-valley-synthetic-wgs84-v2',sourceMode:'fixture',
  localCoordinateSystem:'local-demo-grid',outputCoordinateSystem:'WGS84',
  originLongitude:-120.5,originLatitude:37,metersPerTile:DEMO_METERS_PER_TILE,earthRadiusMeters:6371008.8,
  xAxis:'east',zAxis:'south',
  method:'Local equirectangular approximation at the declared origin latitude.',
  note:'Invented location and scale for API interoperability. Not surveyed land, measured distances or construction dimensions.',
});

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACCESS=new Set(['unknown','allowed','refused']);
const NEGOTIATION=new Set(['pending','accepted','refused','counteroffer','review_required']);
function requireId(value,label,max=128){if(typeof value!=='string'||value.length>max||!ID.test(value))throw new Error(`${label} must be a valid identifier.`);return value;}
function integer(value,label,min=0){if(!Number.isSafeInteger(value)||value<min)throw new Error(`${label} must be a safe integer of at least ${min}.`);return value;}
function finite(value,label,min=0){if(!Number.isFinite(value)||value<min)throw new Error(`${label} must be a finite number of at least ${min}.`);return value;}
function total(values,label){return integer(values.reduce((sum,value)=>sum+integer(value,label),0),label);}
function equalIds(a,b){return a.length===b.length&&[...a].sort().every((id,index)=>id===[...b].sort()[index]);}

/** Default national-format numbers to +1; explicit international prefixes are preserved. */
export function normalizeDemoPhone(phone) {
  if(typeof phone!=='string')return null;
  let normalized=phone.trim().replace(/[\s().-]/g,'');
  if(/^\d{10}$/.test(normalized))normalized=`+1${normalized}`;
  else if(/^1\d{10}$/.test(normalized))normalized=`+${normalized}`;
  return /^\+[1-9]\d{7,14}$/.test(normalized)?normalized:null;
}

/** No network, persistence or logging. The normalized participant is private adapter input. */
export function validateDemoParticipant({alias='',phone='',consent=false}={}) {
  const errors=[];
  const name=typeof alias==='string'?alias.trim():'';
  if(typeof alias!=='string'||name.length===0||name.length>80||/[\u0000-\u001f\u007f]/.test(name))errors.push('Enter a participant name of 1 to 80 characters on one line.');
  const phoneE164=normalizeDemoPhone(phone);
  if(!phoneE164)errors.push('Enter a 10-digit US number or an international number with + and country code.');
  if(consent!==true)errors.push('Confirm that this participant agreed to receive the AI roleplay demo call.');
  return {valid:errors.length===0,errors,
    participant:errors.length?null:{alias:name,phoneE164,consent:true}};
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
export function createHandoff({world,route,analysis,placements,participant=null,userParcelId=null,
  sessionId,routeVersion,budgetCents=DEMO_BUDGET_CENTS}={}) {
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
  const selectedUserParcel=chooseUserParcel(analysis,userParcelId);
  if(!selectedUserParcel||!route.parcelIds.includes(selectedUserParcel))throw new Error('The user role must belong to an affected route parcel.');
  const validation=validateDemoParticipant({alias:participant?.alias??'',phone:participant?.phoneE164??participant?.phone??'',consent:participant?.consent??false});
  const projectId=`demo-${sessionId}`,contactRef=`${sessionId}:user`;
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
  const userRow=analysis.parcels.find(row=>row.parcelId===selectedUserParcel);
  const parcelAnalysis=analysis.parcels.map(row=>({
    parcelId:row.parcelId,name:row.name,ownerId:row.ownerId,ownerAlias:row.ownerAlias,
    displayOwnerAlias:row.parcelId===selectedUserParcel?'User participant':row.ownerAlias,
    userRole:row.parcelId===selectedUserParcel,synthetic:true,
    contactRef:row.parcelId===selectedUserParcel?contactRef:row.contactRef,
    email:row.parcelId===selectedUserParcel?null:row.email,
    phoneDisplay:row.parcelId===selectedUserParcel?'Private demo participant':row.phoneDisplay,
    landUse:row.landUse,areaTiles:row.areaTiles,lineLengthTiles:row.lineLengthTiles,
    towerCount:row.towerCount,towerIds:[...row.towerIds],foundationAreaTiles:row.foundationAreaTiles,
    upfrontCents:row.upfrontCents,rentTotalCents:row.rentTotalCents,
    monthlyRentEquivalentCents:row.monthlyRentCents,monthlyRentIsApproximate:row.monthlyRentIsApproximate,
    offerCapCents:row.offerCapCents,withinOfferCap:row.withinOfferCap,
    accessConsent:row.accessConsent,negotiationStatus:row.negotiationStatus,
    affectReasons:[...row.affectReasons],corridorOnly:row.corridorOnly,
  }));
  // Additive shared handoff: the frozen API v1 snapshot above stays compatible.
  // Contact references are local correlation IDs, never registered dial targets.
  // Copy banking by original owner, so the participant overlay cannot redirect it.
  const ownerHandoff={
    schemaVersion:1,kind:'easygrid-owner-handoff',sourceMode:'fixture',
    sessionId,projectId,routeId:route.id,routeVersion,revision:0,referenceBinding:'local-fixture',
    currency:'USD',routeStatus:'selected_for_negotiation',rentHorizonMonths,
    constructionCents:candidate.constructionCents,budgetCents,simulationChecksPassed:true,
    owners:[...owners.values()].map(owner=>{
      const original=world.ownerById.get(owner.id),banking=original.banking;
      if(!banking||banking.ownerId!==owner.id||banking.mode!=='simulated'||
        typeof banking.paymentRecipientRef!=='string'||!banking.paymentRecipientRef.startsWith('mock-')||
        !/^\*{4}\d{4}$/.test(banking.accountDisplay)||banking.accountHolderAlias!==owner.alias||
        typeof banking.bankDisplay!=='string'||!banking.bankDisplay.trim()){
        throw new Error('A matching simulated banking profile is required for each affected owner.');
      }
      requireId(banking.paymentRecipientRef,'Mock payment recipient reference');
      const isUser=owner.id===userRow.ownerId;
      const ownerContactRef=isUser?contactRef:original.contactRef;
      requireId(ownerContactRef,'Owner contact reference');
      return {ownerId:owner.id,alias:owner.alias,synthetic:true,
        contact:{contactRef:ownerContactRef,registration:'unregistered',callConsent:false},
        banking:{ownerId:banking.ownerId,paymentRecipientRef:banking.paymentRecipientRef,
          mode:'simulated',accountHolderAlias:banking.accountHolderAlias,
          bankDisplay:banking.bankDisplay,accountDisplay:banking.accountDisplay}};
    }),
    parcels:analysis.parcels.map(row=>{
      const parcel=parcels.find(item=>item.id===row.parcelId);
      return {parcelId:row.parcelId,ownerId:row.ownerId,landUse:row.landUse,
        geometry:{type:'Polygon',coordinates:parcel.geometry.coordinates.map(ring=>ring.map(point=>[...point]))},areaSqM:parcel.areaSqM,
        impact:{towerCount:row.towerCount,wireLengthMeters:row.lineLengthTiles*DEMO_COORDINATE_TRANSFORM.metersPerTile},
        offerCapCents:row.offerCapCents,
        terms:{termsVersion:1,
          // Fixture status alone is not an explicit negotiated acceptance.
          outcome:row.negotiationStatus==='accepted'?'pending':row.negotiationStatus,
          accessConsent:row.accessConsent,explicitConfirmation:false,confirmationRef:null,
          compensationCents:row.upfrontCents,monthlyRentCents:row.monthlyRentCents,
          comparisonRentTotalCents:row.rentTotalCents,monthlyRentIsApproximate:row.monthlyRentIsApproximate}};
    }),
    userRole:{ownerId:userRow.ownerId,parcelId:selectedUserParcel},
  };
  if(new Set(ownerHandoff.owners.map(owner=>owner.banking.paymentRecipientRef)).size!==ownerHandoff.owners.length){
    throw new Error('Each affected owner must have a distinct mock payment recipient reference.');
  }
  return {
    schemaVersion:2,kind:'easygrid-map-handoff',sourceMode:'fixture',sessionId,routeVersion,
    coordinateTransform:{...DEMO_COORDINATE_TRANSFORM},
    costModel:JSON.parse(JSON.stringify(route.costModel??DEMO_COST_MODEL)),
    snapshot:{project,owners:[...owners.values()],parcels,routes:[candidate],negotiations:[],easements:[],approvals:[],payments:[],reconciliations:[],events:[]},
    parcelAnalysis,ownerHandoff,
    userRole:{parcelId:selectedUserParcel,ownerId:userRow.ownerId,originalOwnerAlias:userRow.ownerAlias,
      displayAlias:'User participant',participantContactRef:contactRef,
      participantReady:validation.valid,participantConsent:validation.valid,
      assignmentMode:'demo-roleplay-overlay',note:'A consenting participant plays this fictional owner. The base parcel and owner are unchanged.'},
    callPreparation:{status:!eligible?'review-required':validation.valid?'ready-for-host-adapter':'participant-required',
      canStartCall:false,backendBindingRequired:true,contactRegistered:false,
      proposedTerms:{upfrontCents:userRow.upfrontCents,offerCapCents:userRow.offerCapCents,
        rentTotalCents:userRow.rentTotalCents,monthlyRentEquivalentCents:userRow.monthlyRentCents,
        monthlyRentIsApproximate:userRow.monthlyRentIsApproximate,termMonths:rentHorizonMonths,depositCents:0},
      note:'This is an offline fixture handoff. The host must import it, bind canonical backend IDs and revisions, privately register the consented participant, and confirm any call action. Call consent does not grant land access. Monthly rent is a rounded equivalent, not negotiated terms.',
      budgetNote:'The default USD 5,000,000 budget is fictional and is not an approved project budget.'},
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
