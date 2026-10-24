import { createFacilityModel } from './facility-models.js';
import { FACILITY_SPECS, PLAN_STORAGE_KEY, validatePlacement, createPlacement, serializePlan, restorePlan, pickTerrain } from './placement.js';

export function createPlanner({ THREE, scene, camera, canvas, world, onChange, onFocus, onResetView, onPlanChange=()=>{}, getParcelRole=()=>null }) {
  const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map(el=>[el.id,el]));
  const write = (id,value) => {const node=elements[id];if(node.textContent!==String(value))node.textContent=String(value);};
  const note = message => {write('save-note',message);elements['save-note'].hidden=!message;};
  const money = new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
  let restored;
  try {restored=restorePlan(world,window.localStorage.getItem(PLAN_STORAGE_KEY));}
  catch {restored={placements:{substation:null,datacenter:null},discarded:false};note('Placements could not be saved or restored in this browser.');}
  const placements=restored.placements;
  let mode=placements.datacenter?'overview':placements.substation?'datacenter':'substation';
  let candidate=null,selectedParcelId=null,analysisParcelId=null,lastCommit=0;
  const siteIndex={substation:0,datacenter:0};
  const solids={},ghosts={};
  for (const kind of Object.keys(FACILITY_SPECS)) {
    solids[kind]=createFacilityModel(THREE,kind);
    ghosts[kind]=createFacilityModel(THREE,kind,{preview:true});
    scene.add(solids[kind].group,ghosts[kind].group);
    solids[kind].group.visible=false;ghosts[kind].group.visible=false;
  }
  const guide=new THREE.Group();guide.name='Facility footprint preview';scene.add(guide);guide.visible=false;
  const guideMaterial=new THREE.MeshBasicMaterial({color:0x6ca574,transparent:true,opacity:.16,depthWrite:false,side:THREE.DoubleSide});
  const guidePlane=new THREE.Mesh(new THREE.PlaneGeometry(1,1).rotateX(-Math.PI/2),guideMaterial);
  const guideLineMaterial=new THREE.LineBasicMaterial({color:0x447a52,depthTest:false});
  const guideLine=new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-.5,0,-.5),new THREE.Vector3(.5,0,-.5),new THREE.Vector3(.5,0,.5),new THREE.Vector3(-.5,0,.5),
  ]),guideLineMaterial);
  guidePlane.renderOrder=4;guideLine.renderOrder=5;guide.add(guidePlane,guideLine);

  const edges=[];
  for (const t of world.tiles) {
    const x0=t.x-.5,z0=t.z-.5;
    for (const [dx,dz,ax,az,bx,bz] of [[1,0,x0+1,z0,x0+1,z0+1],[0,1,x0,z0+1,x0+1,z0+1],[-1,0,x0,z0,x0,z0+1],[0,-1,x0,z0,x0+1,z0]]) {
      const other=world.tileAt(t.x+dx,t.z+dz);
      if (other?.parcelId===t.parcelId || (other && (dx<0 || dz<0))) continue;
      const y=Math.max(t.terrain==='river'?.79:t.height,other?.terrain==='river'?.79:other?.height??-4)+.065;
      edges.push(ax,y,az,bx,y,bz);
    }
  }
  const parcelLines=new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(edges,3)),new THREE.LineBasicMaterial({color:0x405744,transparent:true,opacity:.52}));
  parcelLines.name='Fictional property boundaries';parcelLines.visible=false;scene.add(parcelLines);
  const highlight=new THREE.InstancedMesh(new THREE.PlaneGeometry(1,1).rotateX(-Math.PI/2),
    new THREE.MeshBasicMaterial({color:0xf4f7c7,transparent:true,opacity:.30,depthWrite:false}),Math.max(...world.parcels.map(p=>p.tileCount)));
  highlight.name='Selected fictional parcel';highlight.count=0;highlight.visible=false;highlight.renderOrder=2;scene.add(highlight);
  let highlightedId=null;
  const matrix=new THREE.Object3D(),raycaster=new THREE.Raycaster(),ndc=new THREE.Vector2(),labelPoint=new THREE.Vector3();

  function persist() {
    try {window.localStorage.setItem(PLAN_STORAGE_KEY,serializePlan(world,placements));}
    catch {note('The placement was applied, but could not be saved in this browser.');}
  }
  if(restored.discarded){persist();note('Saved placements that no longer fit this map were not restored.');}
  function syncModels() {
    for (const kind of Object.keys(FACILITY_SPECS)) {
      const p=placements[kind],group=solids[kind].group;
      group.visible=Boolean(p);
      if(p)group.position.set(p.x,p.y,p.z);
    }
  }
  function refreshHighlight() {
    const activeParcelId=analysisParcelId??(mode==='inspect'?selectedParcelId:null);
    highlight.visible=Boolean(activeParcelId);
    parcelLines.visible=mode==='inspect'||Boolean(analysisParcelId);
    if(!highlight.visible || highlightedId===activeParcelId)return;
    let i=0;
    for(const tile of world.tiles)if(tile.parcelId===activeParcelId){
      matrix.position.set(tile.x,(tile.terrain==='river'?.79:tile.height)+.045,tile.z);matrix.updateMatrix();highlight.setMatrixAt(i++,matrix.matrix);
    }
    highlight.count=i;highlight.instanceMatrix.needsUpdate=true;highlight.computeBoundingSphere();highlightedId=activeParcelId;
  }
  function hideGhosts() {for(const model of Object.values(ghosts))model.group.visible=false;guide.visible=false;}
  function showCandidate(x,z) {
    if(!FACILITY_SPECS[mode])return;
    const validation=validatePlacement(world,mode,x,z,placements);
    candidate={kind:mode,validation,x:validation.footprint?.x,z:validation.footprint?.z};
    hideGhosts();
    if(validation.footprint){
      const f=validation.footprint,y=world.tileAt(f.x,f.z)?.height??validation.height??1.5;
      const ghost=ghosts[mode];ghost.group.position.set(f.x,y+.03,f.z);ghost.group.visible=true;ghost.setPreviewState(validation.valid);
      guide.position.set(f.x,y+.08,f.z);guidePlane.scale.set(f.width,1,f.depth);guideLine.scale.set(f.width,1,f.depth);
      guideMaterial.color.setHex(validation.valid?0x72a974:0xcf8066);guideLineMaterial.color.setHex(validation.valid?0x447a52:0xac5643);guide.visible=true;
      selectedParcelId=world.tileAt(f.x,f.z)?.parcelId??null;
    }
    refreshUI();
  }
  function refreshUI() {
    for(const [kind,suffix] of [['substation','a'],['datacenter','b']]){
      const button=elements[`step-${suffix}`],p=placements[kind];
      button.setAttribute('aria-pressed',String(mode===kind));button.classList.toggle('done',Boolean(p));
      write(`${suffix}-status`,p?'Placed · click to move':kind==='datacenter'&&!placements.substation?'Next step':'Choose a site');
    }
    elements['step-b'].disabled=!placements.substation;
    elements['reset-plan'].disabled=!placements.substation&&!placements.datacenter;
    elements['inspect-parcels'].setAttribute('aria-pressed',String(mode==='inspect'));
    canvas.classList.toggle('inspecting',mode==='inspect');parcelLines.visible=mode==='inspect';
    write('parcel-count',world.parcels.length);
    elements['placement-info'].hidden=!FACILITY_SPECS[mode];
    elements['size-badge'].hidden=!FACILITY_SPECS[mode];
    elements['parcel-details'].hidden=mode!=='inspect'||!selectedParcelId;
    elements['fixture-note'].hidden=mode!=='inspect';
    if(FACILITY_SPECS[mode]){
      const spec=FACILITY_SPECS[mode],v=candidate?.validation;
      write('card-kicker',mode==='substation'?'STEP 01 / 03':'STEP 02 / 03');
      write('card-title',`${placements[mode]?'Move the':'Choose a site for the'} ${spec.label.toLowerCase()}`);
      write('card-copy',placements[mode]?'Your existing facility stays in place until you confirm a new site.':'Click open land, or use Find open site to preview a suitable footprint.');
      write('size-badge',`${spec.width} × ${spec.depth}`);
      write('validation-text',v?.reason??'Hover over the map to check the full footprint.');
      elements.validation.className=`validation ${v?(v.valid?'valid':'invalid'):'neutral'}`;
      write('footprint-meta',`Footprint: ${spec.width*spec.depth} tiles`);
      write('parcel-meta',v?.parcelIds.length?`Parcels ${v.parcelIds.join(' · ')}`:'Parcels —');
      elements['confirm-placement'].disabled=!v?.valid;
      write('confirm-placement',placements[mode]?'Move here':'Place here');
    }else if(mode==='inspect'){
      const parcel=world.parcelById.get(selectedParcelId);
      write('card-kicker','FICTIONAL PARCELS');write('card-title',parcel?`${parcel.id} · Property details`:'Explore the parcels');
      write('card-copy',parcel?'The highlighted land belongs to one fictional owner.':'Hover or tap the map to see ownership and land details.');
      if(parcel){
        const owner=world.ownerById.get(parcel.ownerId),role=getParcelRole(parcel.id);
        write('owner-name',role?`${role.ownerAlias} · judge roleplay`:owner.alias);
        write('owner-phone',role?.phoneDisplay??owner.phoneDisplay);write('owner-email',role?.email??owner.email);
        if(role)write('card-copy',`Judge roleplay parcel. Fictional owner role: ${owner.alias}. This is not a real ownership record.`);
        const names={meadow:'Open land',hill:'Hills',field:'Farmland',river:'River',shore:'Riverbank',road:'Road',farmyard:'Farmstead'};
        const composition=Object.entries(parcel.terrainCounts).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([name])=>names[name]??name).join(' · ');
        write('parcel-use',composition);write('parcel-area',`${parcel.tileCount} tiles`);write('parcel-offer',money.format(parcel.compensation.initialOfferCents/100));
      }
    }else{
      write('card-kicker','SITE PLAN READY');write('card-title','Both facilities are placed');
      write('card-copy','Use Transmission to compare connections, A or B to move a facility, or Parcels to explore the land.');
    }
    refreshHighlight();
    elements['context-card'].classList.toggle('overview',mode==='overview');
    canvas.dataset.plannerMode=mode;canvas.dataset.placementCount=String(Object.values(placements).filter(Boolean).length);
    canvas.dataset.selectedParcel=selectedParcelId??'';
    canvas.dataset.previewValid=String(Boolean(candidate?.validation.valid));
  }
  function setMode(next) {
    if(next==='datacenter'&&!placements.substation)return;
    mode=next;candidate=null;hideGhosts();refreshUI();onChange();
  }
  function commit() {
    if(!candidate?.validation.valid || candidate.kind!==mode)return false;
    const placement=createPlacement(world,mode,candidate.x,candidate.z,placements);
    if(!placement)return false;
    const committedKind=mode;placements[committedKind]=placement;lastCommit=Date.now();persist();syncModels();
    setMode(committedKind==='substation'&&!placements.datacenter?'datacenter':'overview');
    onPlanChange();
    return true;
  }
  function hover(clientX,clientY) {
    if(mode==='overview')return;
    const rect=canvas.getBoundingClientRect();
    if(rect.width<=0||rect.height<=0)return;
    if(!Number.isFinite(clientX)||!Number.isFinite(clientY)||clientX<rect.left||clientY<rect.top||clientX>=rect.left+rect.width||clientY>=rect.top+rect.height){
      candidate=null;hideGhosts();refreshUI();onChange();return;
    }
    ndc.set((clientX-rect.left)/rect.width*2-1,-(clientY-rect.top)/rect.height*2+1);
    raycaster.setFromCamera(ndc,camera);
    const hit=pickTerrain(world,raycaster.ray);
    if(!hit){candidate=null;hideGhosts();refreshUI();onChange();return;}
    if(FACILITY_SPECS[mode])showCandidate(hit.x,hit.z);
    else if(mode==='inspect'){selectedParcelId=hit.tile.parcelId;refreshUI();}
    onChange();
  }
  function tap(clientX,clientY) {
    if(Date.now()-lastCommit<350)return;
    hover(clientX,clientY);
    if(FACILITY_SPECS[mode])commit();
  }
  function nextSite() {
    if(!FACILITY_SPECS[mode])return;
    const choices=world.clearings.map(c=>({x:(c.x0+c.x1)/2,z:(c.z0+c.z1)/2})).filter(p=>validatePlacement(world,mode,p.x,p.z,placements).valid);
    if(mode==='datacenter' && placements.substation){
      const bank=Math.sign(placements.substation.x);choices.sort((a,b)=>(Math.sign(a.x)===bank?1:0)-(Math.sign(b.x)===bank?1:0));
    }
    if(!choices.length){note('No open site was found. Try moving an existing facility.');return;}
    const next=choices[siteIndex[mode]++%choices.length];showCandidate(next.x,next.z);onFocus(next.x,next.z);onChange();
  }
  elements['step-a'].addEventListener('click',()=>setMode('substation'));
  elements['step-b'].addEventListener('click',()=>setMode('datacenter'));
  elements['label-a'].addEventListener('click',()=>setMode('substation'));
  elements['label-b'].addEventListener('click',()=>setMode('datacenter'));
  elements['inspect-parcels'].addEventListener('click',()=>setMode(mode==='inspect'?(placements.datacenter?'overview':placements.substation?'datacenter':'substation'):'inspect'));
  elements['next-site'].addEventListener('click',nextSite);elements['confirm-placement'].addEventListener('click',commit);
  elements['reset-view'].addEventListener('click',onResetView);
  elements['reset-plan'].addEventListener('click',()=>{
    placements.substation=null;placements.datacenter=null;selectedParcelId=null;siteIndex.substation=0;siteIndex.datacenter=0;
    persist();syncModels();setMode('substation');onResetView();
    onPlanChange();
  });
  syncModels();refreshUI();
  return {
    hover,tap,
    refreshParcelRoles(){refreshUI();onChange();},
    focusAnalysisParcel(parcelId){
      const parcel=world.parcelById.get(parcelId);
      analysisParcelId=parcel?.id??null;refreshHighlight();
      canvas.dataset.analysisParcel=analysisParcelId??'';
      if(parcel)onFocus((parcel.bounds.x0+parcel.bounds.x1)/2,(parcel.bounds.z0+parcel.bounds.z1)/2);
      else onChange();
    },
    getPlacements(){return JSON.parse(JSON.stringify(placements));},
    showOverview(){if(placements.substation&&placements.datacenter)setMode('overview');},
    clearPreview(){candidate=null;hideGhosts();refreshUI();},
    updateLabels(){
      for(const [kind,suffix] of [['substation','a'],['datacenter','b']]){
        const p=placements[kind],label=elements[`label-${suffix}`];
        if(!p){label.hidden=true;continue;}
        labelPoint.set(p.x,p.y+6.4,p.z).project(camera);
        label.hidden=Math.abs(labelPoint.x)>.96||Math.abs(labelPoint.y)>.96||labelPoint.z<-1||labelPoint.z>1;
        if(!label.hidden){label.style.left=`${(labelPoint.x+1)*canvas.clientWidth/2}px`;label.style.top=`${(1-labelPoint.y)*canvas.clientHeight/2}px`;}
      }
    },
    keydown(event){
      if(event.key==='Escape'){setMode(placements.datacenter?'overview':'inspect');return true;}
      if(event.key==='1'){setMode('substation');return true;}
      if(event.key==='2'){setMode('datacenter');return true;}
      if(event.key==='Enter' && candidate){commit();return true;}
      return false;
    },
  };
}
