import { computeTransmissionRoutes } from './routing.js';
import { createTransmissionLayer } from './transmission-models.js';
import { DEMO_METERS_PER_TILE, DEMO_BUDGET_CENTS } from './cost-model.js';
import { analyzeRouteParcels } from './parcel-analysis.js';

// Keep the analysis transition readable; this is presentation time, not extra model reasoning.
export const ROUTE_REVEAL_DELAY_MS = 1600;

/** Connect the computed route, its physical geometry and its explanation to one state. */
export function createRouteController({THREE,scene,world,landscape,canvas,getPlacements,onOverview,onDraw,onFitRoute,onRouteChange=()=>{},onNoRoute=()=>{},getRoutingOptions=()=>({}),canRoute=()=>true}) {
  const ids=['step-route','route-status','route-panel','route-summary','route-title','route-status-note','route-badge',
    'route-length','route-towers','route-owners','cost-line','cost-structures','cost-impact','cost-engineering','cost-contingency','cost-land','cost-rent','cost-rent-label','cost-total',
    'route-parcels','route-no-results','route-loading','recalculate-route'];
  for(let i=0;i<3;i++)ids.push(`route-choice-${i}`,`route-name-${i}`,`route-detail-${i}`,`route-price-${i}`);
  const elements=Object.fromEntries(ids.map(id=>[id,document.querySelector(`#${id}`)]));
  const write=(id,value)=>{if(elements[id].textContent!==String(value))elements[id].textContent=String(value);};
  const money=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2});
  const compactMoney=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
  const moneyOf=cents=>money.format(cents/100);
  const layer=createTransmissionLayer(THREE,world);scene.add(layer.group);
  const previousLayer=new THREE.Group();previousLayer.name='Previous route';scene.add(previousLayer);
  const comparisonLayer=new THREE.Group();comparisonLayer.name='Updated route highlight';scene.add(comparisonLayer);
  let generation=0,timer=null,result=null,selectedId=null,state='incomplete',routeVersion=0,pendingRouteId=null;

  function hasEndpoints(){const p=getPlacements();return canRoute()&&Boolean(p.substation&&p.datacenter);}
  function clearPrevious(){
    for(const line of [...previousLayer.children]){line.traverse(object=>{object.geometry?.dispose();if(object.material)object.material.dispose();});previousLayer.remove(line);}
    canvas.dataset.previousRouteVisible='false';
  }
  function clearHighlight(){
    for(const mesh of [...comparisonLayer.children]){mesh.geometry.dispose();mesh.material.dispose();comparisonLayer.remove(mesh);}
  }
  // Presentation overlay follows the already-validated center conductor, not a new physical span.
  function highlight(network,target,{color,opacity,radius}){
    const paths=network.getObjectByName('Three-phase conductors')?.userData.phasePaths??[];
    for(const path of paths.filter(path=>path.phase===1)){
      const points=path.points.map(point=>new THREE.Vector3(point.x,point.y,point.z));
      class SampledPath extends THREE.Curve {
        getPoint(t,result=new THREE.Vector3()){
          const index=t*(points.length-1),lo=Math.min(Math.floor(index),points.length-2);
          return result.lerpVectors(points[lo],points[lo+1],index-lo);
        }
      }
      const mesh=new THREE.Mesh(new THREE.TubeGeometry(new SampledPath(),points.length-1,radius,6,false),
        new THREE.MeshBasicMaterial({color,transparent:opacity<1,opacity,depthWrite:false}));
      mesh.name='Route comparison line';target.add(mesh);
    }
  }
  function rememberPrevious(){
    clearPrevious();const route=result?.candidates.find(candidate=>candidate.id===selectedId);if(!route)return;
    const ghost=layer.group.clone(true);
    ghost.name='Faded previous transmission network';
    ghost.traverse(object=>{
      if(object.geometry)object.geometry=object.geometry.clone();
      if(object.material){object.material=object.material.clone();object.material.transparent=true;object.material.opacity=.2;object.material.depthWrite=false;}
      object.castShadow=false;
    });
    highlight(ghost,ghost,{color:0x9c775c,opacity:.4,radius:.22});
    previousLayer.add(ghost);canvas.dataset.previousRouteVisible='true';
  }
  function clearGeometry(){
    clearHighlight();layer.clear();landscape.setFoundationClearings([]);
    canvas.dataset.routeId='';canvas.dataset.routeTowerCount='0';canvas.dataset.routeParcelIds='';
    canvas.dataset.routeTotalCents='';canvas.dataset.routeMinClearance='';
  }
  function updateVisibility(){
    const complete=hasEndpoints(),inOverview=canvas.dataset.plannerMode==='overview';
    elements['route-panel'].hidden=!complete||!inOverview;
    elements['step-route'].disabled=!complete;
    elements['step-route'].setAttribute('aria-pressed',String(complete&&inOverview));
  }
  function renderState(){
    updateVisibility();
    const ok=state==='ok';
    elements['route-summary'].hidden=!ok;
    elements['route-status-note'].hidden=!ok;
    elements['route-loading'].hidden=state!=='calculating';
    elements['route-panel'].setAttribute('aria-busy',String(state==='calculating'));
    canvas.setAttribute('aria-busy',String(state==='calculating'));
    elements['route-no-results'].hidden=state!=='no-route'&&state!=='error';
    elements['recalculate-route'].disabled=!hasEndpoints()||state==='calculating';
    elements['step-route'].classList.toggle('done',ok);
    write('route-status',state==='calculating'?'Calculating…':ok?'Connected · compare':state==='no-route'?'No connection':state==='error'?'Try again':'Place both sites');
    canvas.dataset.routeState=state;
    canvas.dataset.routeCandidateCount=String(result?.candidates?.length??0);
    if(state==='calculating'){
      write('route-title','Calculating route');write('route-badge','CALCULATING');
    }else if(state==='no-route'||state==='error'){
      write('route-title',state==='error'?'Connection unavailable':'No feasible connection');write('route-badge','REVIEW SITES');
      write('route-no-results',result?.reasons?.join(' ')??'The route could not be calculated. Try another site or recalculate.');
    }
  }
  function showCandidate(id,{verifiedVersion}={}){
    if(!canRoute())return;
    const route=result?.candidates.find(candidate=>candidate.id===id);if(!route)return;
    clearGeometry();
    try{
      const diagnostics=layer.showRoute(route);
      if(previousLayer.children.length)highlight(layer.group,comparisonLayer,{color:0x126748,opacity:1,radius:.16});
      landscape.setFoundationClearings(route.nodes.filter(node=>node.kind==='tower').map(node=>node.foundation));
      selectedId=id;state='ok';
      const isRecommended=id===result.recommendedId;
      write('route-title',isRecommended?'Recommended connection':'Alternative connection');
      write('route-badge',isRecommended?'LOWEST MODELED COST':'COMPARING');
      write('route-status-note',`${route.pendingConsentParcelIds.length} parcels awaiting consent`);
      write('route-length',`${(route.lengthTiles*DEMO_METERS_PER_TILE/1000).toFixed(2)} km`);write('route-towers',route.metrics.towerCount);
      const owners=new Set(route.parcelIds.map(parcelId=>world.parcelById.get(parcelId)?.ownerId).filter(Boolean));write('route-owners',owners.size);
      for(let i=0;i<3;i++){
        const candidate=result.candidates[i],button=elements[`route-choice-${i}`];button.hidden=!candidate;if(!candidate)continue;
        button.setAttribute('aria-pressed',String(candidate.id===id));
        write(`route-name-${i}`,candidate.label);
        const difference=candidate.totalCostCents-result.candidates[0].totalCostCents;
        write(`route-detail-${i}`,`${(candidate.lengthTiles*DEMO_METERS_PER_TILE/1000).toFixed(2)} km · ${candidate.metrics.towerCount} towers${difference>0?` · +${compactMoney.format(difference/100)}`:''}`);
        write(`route-price-${i}`,`≈${compactMoney.format(candidate.totalCostCents/100)}`);
      }
      const c=route.costBreakdown;
      write('cost-line',moneyOf(c.lineCents));write('cost-structures',moneyOf(c.towerCents+c.terminalCents));
      write('cost-impact',moneyOf(c.terrainCents+c.waterCents+c.agricultureCents+c.vegetationCents+c.roadCents));
      write('cost-engineering',moneyOf(c.engineeringCents));write('cost-contingency',moneyOf(c.contingencyCents));
      write('cost-land',moneyOf(c.compensationCents));write('cost-rent',moneyOf(c.rentCents));
      write('cost-rent-label',`Rent · ${result.assumptions.rentHorizonMonths} months`);write('cost-total',moneyOf(route.totalCostCents));
      write('route-parcels',route.parcelIds.join(' · '));
      canvas.dataset.routeId=route.id;canvas.dataset.routeTowerCount=String(route.metrics.towerCount);
      canvas.dataset.routeParcelIds=route.parcelIds.join(',');canvas.dataset.routeTotalCents=String(route.totalCostCents);
      canvas.dataset.routeMinClearance=String(diagnostics.minClearance);
      routeVersion=verifiedVersion??routeVersion+1;
      renderState();onRouteChange({route,assumptions:result.assumptions,routeVersion});onDraw();return diagnostics;
    }catch(error){
      clearGeometry();selectedId=null;state='error';result={candidates:[],reasons:['The computed connection did not pass its geometry checks. Move a site or recalculate.']};
      onRouteChange(null);onNoRoute();console.error(error);renderState();onDraw();return null;
    }
  }
  function schedule({keepPrevious=false}={}){
    const ticket=++generation;
    if(timer!==null)clearTimeout(timer);timer=null;
    if(!keepPrevious)clearPrevious();
    clearGeometry();result=null;selectedId=null;onRouteChange(null);
    if(!hasEndpoints()){state='incomplete';renderState();onDraw();return;}
    const snapshot=getPlacements(),startedAt=performance.now();state='calculating';renderState();onDraw();
    const reveal=computed=>{
      if(ticket!==generation||!canRoute())return;
      timer=null;result=computed;state=computed.status;
      if(result.status==='ok'){
        const preferred=pendingRouteId&&result.candidates.some(candidate=>candidate.id===pendingRouteId)?pendingRouteId:result.recommendedId;
        pendingRouteId=null;
        const diagnostics=showCandidate(preferred);
        if(diagnostics)onFitRoute(result.candidates.find(c=>c.id===selectedId),diagnostics);
      }else{clearGeometry();renderState();onNoRoute();onDraw();}
    };
    const revealWhenReady=computed=>{
      if(ticket!==generation||!canRoute())return;
      const remaining=Math.max(0,ROUTE_REVEAL_DELAY_MS-(performance.now()-startedAt));
      if(remaining>0)timer=setTimeout(()=>reveal(computed),remaining);
      else reveal(computed);
    };
    // Yield for the loading UI, compute promptly, then reveal after the minimum visible interval.
    timer=setTimeout(()=>{
      if(ticket!==generation||!canRoute())return;timer=null;
      try{
        const options=getRoutingOptions(),computed=computeTransmissionRoutes(world,snapshot,options);if(ticket!==generation)return;
        const constrained=options.blockedParcelIds?.length||options.blockedTowerParcelIds?.length||options.exclusionZones?.length;
        if(constrained&&computed.status==='ok'){
          const candidate=computed.candidates.find(route=>{
            if(route.totalCostCents>DEMO_BUDGET_CENTS)return false;
            const analysis=analyzeRouteParcels(world,route,computed.assumptions);
            return analysis.parcels.every(parcel=>parcel.recommendationStatus==='estimated'&&parcel.withinOfferCap&&parcel.accessConsent!=='refused'&&parcel.negotiationStatus!=='refused');
          });
          computed.candidates=candidate?[candidate]:[];computed.recommendedId=candidate?.id??null;
          if(!candidate){computed.status='no-route';computed.reasons=['No eligible route within the current budget and parcel constraints.'];}
        }
        revealWhenReady(computed);
      }catch(error){
        if(ticket!==generation)return;
        console.error(error);
        revealWhenReady({status:'error',candidates:[],reasons:['The connection could not be calculated. Try moving a facility and calculate again.']});
      }
    },16);
  }
  for(let i=0;i<3;i++)elements[`route-choice-${i}`].addEventListener('click',()=>{
    const route=result?.candidates[i];
    if(route&&state==='ok'&&route.id!==selectedId){const diagnostics=showCandidate(route.id);if(diagnostics)onFitRoute(route,diagnostics);}
  });
  elements['step-route'].addEventListener('click',()=>{if(!canRoute())return;onOverview();if(state==='calculating')updateVisibility();else if(!result||state==='error'||state==='no-route')schedule();else updateVisibility();});
  elements['recalculate-route'].addEventListener('click',schedule);
  function adoptRegisteredRoute({routeId,routeVersion:version}){
    if(state==='calculating'||routeVersion!==0||selectedId)throw new Error('The map already published a route version.');
    if(typeof routeId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(routeId))throw new Error('A saved route id is required.');
    if(!Number.isSafeInteger(version)||version<1)throw new Error('A saved route version is required.');
    pendingRouteId=routeId;routeVersion=version-1;
  }
  renderState();
  function installVerifiedRoute(snapshot,expectedVersion){
    const current=result?.candidates.find(candidate=>candidate.id===selectedId);
    if(!hasEndpoints()||state!=='ok'||expectedVersion!==routeVersion||snapshot?.routeVersion!==routeVersion+1||
      snapshot.route?.id!==current?.id||!snapshot.assumptions||!Array.isArray(snapshot.route.parcelIds)||
      [...snapshot.route.parcelIds].sort().join('|')!==[...current.parcelIds].sort().join('|'))throw new Error('The verified relocation does not match the current route.');
    generation++;if(timer!==null)clearTimeout(timer);timer=null;rememberPrevious();
    result={status:'ok',candidates:[snapshot.route],recommendedId:snapshot.route.id,assumptions:snapshot.assumptions};
    const diagnostics=showCandidate(snapshot.route.id,{verifiedVersion:snapshot.routeVersion});
    if(!diagnostics)throw new Error('The verified relocation could not be rendered.');
    write('route-title','Owner condition applied');write('route-badge','CONDITION MET');
    write('route-status-note','Tower locations verified within the original parcel.');write('route-name-0','Verified owner condition');
    onFitRoute(snapshot.route,diagnostics);return true;
  }
  return {invalidate:schedule,updateVisibility,initialize:schedule,adoptRegisteredRoute,installVerifiedRoute,replan:()=>{rememberPrevious();schedule({keepPrevious:true});}};
}
