import { computeTransmissionRoutes } from './routing.js';
import { createTransmissionLayer } from './transmission-models.js';
import { DEMO_METERS_PER_TILE } from './cost-model.js';

// Keep the analysis transition readable; this is presentation time, not extra model reasoning.
export const ROUTE_REVEAL_DELAY_MS = 1600;

/** Connect the computed route, its physical geometry and its explanation to one state. */
export function createRouteController({THREE,scene,world,landscape,canvas,getPlacements,onOverview,onDraw,onFitRoute,onRouteChange=()=>{},canRoute=()=>true}) {
  const ids=['step-route','route-status','route-panel','route-summary','route-title','route-status-note','route-badge',
    'route-length','route-towers','route-owners','cost-line','cost-structures','cost-impact','cost-engineering','cost-contingency','cost-land','cost-rent','cost-rent-label','cost-total',
    'route-reason','route-parcels','route-method-copy','route-rates','route-assumptions','route-no-results','route-loading','recalculate-route'];
  for(let i=0;i<3;i++)ids.push(`route-choice-${i}`,`route-name-${i}`,`route-detail-${i}`,`route-price-${i}`);
  const elements=Object.fromEntries(ids.map(id=>[id,document.querySelector(`#${id}`)]));
  const write=(id,value)=>{if(elements[id].textContent!==String(value))elements[id].textContent=String(value);};
  const money=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2});
  const compactMoney=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
  const moneyOf=cents=>money.format(cents/100);
  const layer=createTransmissionLayer(THREE,world);scene.add(layer.group);
  let generation=0,timer=null,result=null,selectedId=null,state='incomplete',routeVersion=0;

  function hasEndpoints(){const p=getPlacements();return canRoute()&&Boolean(p.substation&&p.datacenter);}
  function clearGeometry(){
    layer.clear();landscape.setFoundationClearings([]);
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
      write('route-title','Finding the best connection');write('route-badge','CALCULATING');
      write('route-status-note','Checking tower foundations, span clearance, terrain and land costs.');
    }else if(state==='no-route'||state==='error'){
      write('route-title',state==='error'?'Connection unavailable':'No feasible connection');write('route-badge','REVIEW SITES');
      write('route-status-note','The constraints have not been relaxed.');
      write('route-no-results',result?.reasons?.join(' ')??'The route could not be calculated. Try another site or recalculate.');
    }
  }
  function showCandidate(id){
    if(!canRoute())return;
    const route=result?.candidates.find(candidate=>candidate.id===id);if(!route)return;
    clearGeometry();
    try{
      const diagnostics=layer.showRoute(route);
      landscape.setFoundationClearings(route.nodes.filter(node=>node.kind==='tower').map(node=>node.foundation));
      selectedId=id;state='ok';
      const isRecommended=id===result.recommendedId;
      write('route-title',isRecommended?'Recommended connection':'Alternative connection');
      write('route-badge',isRecommended?'LOWEST MODELED COST':'COMPARING');
      write('route-status-note',`${route.pendingConsentParcelIds.length} affected parcels still require owner consent. This route is not an approval.`);
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
      const reasons=[isRecommended?'Lowest total cost across all feasible paths in this demo tower network.':'This alternative uses a different routing objective and is priced with the same cost model.',
        `${route.metrics.waterSpans} water / bank spans; ${route.metrics.agricultureLengthTiles.toFixed(1)} tiles of farmland crossed.`,
        'Every pylon has a checked foundation; conductors stay above the modeled terrain.'];
      write('route-reason',reasons.join(' '));write('route-parcels',route.parcelIds.join(' · '));
      const assumptions=result.assumptions,r=assumptions.rates;
      write('route-method-copy',`The recommendation minimizes line, structure, terrain, crossing and land costs on a validated network of ${assumptions.graphNodeCount} support sites. Shortest and lower-impact paths are compared using that same total. ${result.candidates.length<3?'Identical alternatives are shown only once.':''}`);
      write('route-rates',`230 kV single circuit · MISO MTEP24 benchmark. Installed tower allowance ${moneyOf(r.towerCents)} each; endpoint support ${moneyOf(r.terminalCents)} each; installed wire bundle ≈${compactMoney.format(r.linePerTileCents*1000/DEMO_METERS_PER_TILE/100)}/route km. Wire includes three phase conductors, OPGW, shield wire and 4% sag/waste. Planning allowances: 10% engineering and 30% contingency on construction plus engineering. Land compensation and ${assumptions.rentHorizonMonths}-month rent use fictional parcel rates.`);
      write('route-assumptions',`Synthetic horizontal scale: ${DEMO_METERS_PER_TILE} m/tile; spans up to ${assumptions.maxSpanTiles*DEMO_METERS_PER_TILE} m. Heights and foundations are stylized. Estimate covers the connection only; excludes substation equipment, data center construction, financing and taxes. Source benchmarks are not a current California quote. This is the least-cost path in the modeled network, not a construction-ready engineering design.`);
      canvas.dataset.routeId=route.id;canvas.dataset.routeTowerCount=String(route.metrics.towerCount);
      canvas.dataset.routeParcelIds=route.parcelIds.join(',');canvas.dataset.routeTotalCents=String(route.totalCostCents);
      canvas.dataset.routeMinClearance=String(diagnostics.minClearance);
      renderState();onRouteChange({route,assumptions:result.assumptions,routeVersion:++routeVersion});onDraw();return diagnostics;
    }catch(error){
      clearGeometry();selectedId=null;state='error';result={candidates:[],reasons:['The computed connection did not pass its geometry checks. Move a site or recalculate.']};
      onRouteChange(null);console.error(error);renderState();onDraw();return null;
    }
  }
  function schedule(){
    const ticket=++generation;
    if(timer!==null)clearTimeout(timer);timer=null;
    clearGeometry();result=null;selectedId=null;onRouteChange(null);
    if(!hasEndpoints()){state='incomplete';renderState();onDraw();return;}
    const snapshot=getPlacements(),startedAt=performance.now();state='calculating';renderState();onDraw();
    const reveal=computed=>{
      if(ticket!==generation||!canRoute())return;
      timer=null;result=computed;state=computed.status;
      if(result.status==='ok'){
        const diagnostics=showCandidate(result.recommendedId);
        if(diagnostics)onFitRoute(result.candidates.find(c=>c.id===selectedId),diagnostics);
      }else{clearGeometry();renderState();onDraw();}
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
        const computed=computeTransmissionRoutes(world,snapshot);if(ticket!==generation)return;
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
  renderState();
  return {invalidate:schedule,updateVisibility,initialize:schedule};
}
