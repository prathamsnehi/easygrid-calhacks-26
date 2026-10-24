import * as THREE from 'three';
import { createLandscape } from './landscape.js';
import { createPlanner } from './planner.js';
import { createRouteController } from './route-controller.js';
import { createAnalysisController } from './analysis-controller.js';

const canvas = document.querySelector('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.28;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe4e6d8);

const hemi = new THREE.HemisphereLight(0xf1f6e5, 0x7c7259, 2.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffefd4, 3.0);
sun.position.set(-32, 60, 26);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -48, right: 48, top: 48, bottom: -48, near: 1, far: 145 });
sun.shadow.bias = -0.00045;
sun.shadow.normalBias = 0.12;
sun.shadow.radius = 2;
scene.add(sun);
const fill = new THREE.DirectionalLight(0xd6e7ed, 0.6);
fill.position.set(38, 26, -30);
scene.add(fill);

const landscape = createLandscape(THREE);
scene.add(landscape.group);
const bounds = landscape.bounds;
const worldRadius = Math.hypot(bounds.width, bounds.depth) / 2;
// Match the lighting volume to the whole valley, including its far corners.
sun.position.set(-worldRadius * 1.25, worldRadius * 2.3, worldRadius);
Object.assign(sun.shadow.camera, {
  left: -worldRadius * 1.2, right: worldRadius * 1.2,
  top: worldRadius * 1.2, bottom: -worldRadius * 1.2,
  near: 1, far: worldRadius * 5,
});
sun.shadow.camera.updateProjectionMatrix();
const floor = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshLambertMaterial({ color: 0xe4e6d8 }));
floor.rotation.x = -Math.PI / 2;
floor.position.y = -4.04;
floor.receiveShadow = true;
scene.add(floor);

const camera = new THREE.OrthographicCamera(-50, 50, 40, -40, 0.1, worldRadius * 6);
const homeTarget = new THREE.Vector3(0, (bounds.minY + bounds.maxY) / 2, 0);
const target = homeTarget.clone();
const corners = [];
function rebuildViewBounds(maxY=bounds.maxY) {
  corners.length=0;
  for (const x of [-bounds.width / 2, bounds.width / 2]) {
    for (const y of [bounds.minY,Math.max(bounds.maxY,maxY)]) {
      for (const z of [-bounds.depth / 2, bounds.depth / 2]) corners.push(new THREE.Vector3(x,y,z).sub(homeTarget));
    }
  }
}
rebuildViewBounds();
const initialYaw = Math.atan2(58, 70);
let yaw = initialYaw, pitch = 0.62, zoom = 1;
let width = 1, height = 1, raf = 0;
let planner = null;
let routing = null;
let analysis = null;
let demoReady = false;
const pointers = new Map();
let pinchDistance = 0;
const minZoom = 0.75, maxZoom = 5;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

function fitCamera() {
  const radius = worldRadius * 2.6;
  camera.position.set(target.x + Math.sin(yaw) * Math.cos(pitch) * radius, target.y + Math.sin(pitch) * radius, target.z + Math.cos(yaw) * Math.cos(pitch) * radius);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  let halfX = 0, halfY = 0;
  for (const corner of corners) {
    halfX = Math.max(halfX, Math.abs(corner.dot(right)));
    halfY = Math.max(halfY, Math.abs(corner.dot(up)));
  }
  const aspect = width / height;
  const halfH = Math.max(halfY, halfX / aspect) * 1.09 / zoom;
  const halfW = halfH * aspect;
  camera.left = -halfW; camera.right = halfW;
  camera.top = halfH; camera.bottom = -halfH;
  camera.updateProjectionMatrix();
}
function pan(dx, dy) {
  const scale = (camera.top - camera.bottom) / height;
  const groundDy = dy * scale / Math.sin(pitch);
  target.x -= dx * scale * Math.cos(yaw) + groundDy * Math.sin(yaw);
  target.z += dx * scale * Math.sin(yaw) - groundDy * Math.cos(yaw);
  target.x = THREE.MathUtils.clamp(target.x, -bounds.width * 0.48, bounds.width * 0.48);
  target.z = THREE.MathUtils.clamp(target.z, -bounds.depth * 0.48, bounds.depth * 0.48);
}
function resetCamera() { planner?.clearPreview();yaw=initialYaw;pitch=.62;zoom=1;target.copy(homeTarget);fitCamera();draw(performance.now()); }
function resize() {
  planner?.clearPreview();
  const rect = canvas.getBoundingClientRect();
  width = Math.max(1, rect.width); height = Math.max(1, rect.height);
  renderer.setSize(width, height, false);
  fitCamera(); draw(performance.now());
}
function draw(time = 0) {
  if (!reduceMotion.matches) landscape.update(time / 1000);
  renderer.render(scene, camera);
  planner?.updateLabels();
  routing?.updateVisibility();
  canvas.dataset.zoom = zoom.toFixed(2);
  canvas.dataset.focus = `${target.x.toFixed(2)},${target.z.toFixed(2)}`;
}
function frame(time) { raf = 0; draw(time); if (!document.hidden && !reduceMotion.matches) raf = requestAnimationFrame(frame); }
function resume() { if (!raf && !document.hidden) { if (reduceMotion.matches) draw(performance.now()); else raf = requestAnimationFrame(frame); } }

planner=createPlanner({THREE,scene,camera,canvas,world:landscape.world,
  canInteract:()=>demoReady,
  getParcelRole:parcelId=>analysis?.getParcelRole(parcelId)??null,
  onChange:()=>draw(performance.now()),onResetView:resetCamera,
  onFocus:(x,z)=>{target.x=x;target.z=z;zoom=Math.max(zoom,1.9);fitCamera();draw(performance.now());},
  onPlanChange:()=>{rebuildViewBounds();routing?.invalidate();},
});
analysis=createAnalysisController({world:landscape.world,canvas,
  getPlacements:()=>planner.getPlacements(),
  onDemoReadyChange:ready=>{
    demoReady=ready;pointers.clear();pinchDistance=0;canvas.classList.remove('dragging');
    planner.clearPreview();routing?.invalidate();
  },
  onFocusParcel:parcelId=>{
    planner.focusAnalysisParcel(parcelId);
    if(!parcelId||width<=900)return;
    const exposedWidth=document.querySelector('#analysis-panel').getBoundingClientRect().left-canvas.getBoundingClientRect().left;
    if(exposedWidth<=160)return;
    // Put the selected land in the visible strip beside the analysis panel.
    const shift=(width-exposedWidth)/2*(camera.right-camera.left)/width;
    target.x+=shift*Math.cos(yaw);target.z-=shift*Math.sin(yaw);
    fitCamera();draw(performance.now());
  },
  onJudgeRoleChange:()=>planner.refreshParcelRoles(),
});
// Host integrations opt in explicitly. Public snapshots never contain entered contacts.
window.easygridDemo=Object.freeze({getHandoff:()=>analysis.getHandoff(),setHandoffHandler:handler=>analysis.setHandoffHandler(handler)});
routing=createRouteController({THREE,scene,world:landscape.world,landscape,canvas,
  canRoute:()=>demoReady,
  getPlacements:()=>planner.getPlacements(),onOverview:()=>planner.showOverview(),onDraw:()=>draw(performance.now()),
  onRouteChange:snapshot=>analysis.setRoute(snapshot),
  onFitRoute:(_route,diagnostics)=>{
    rebuildViewBounds(diagnostics.maxY+1);resetCamera();
    if(width>900)pan(-Math.min(width*.12,160),0);
    else pan(0,-Math.min(height*.22,150));
    fitCamera();draw(performance.now());
  },
});
canvas.addEventListener('pointerdown', e => {
  if(!demoReady)return;
  if (![0, 1, 2].includes(e.button)) return;
  canvas.focus({preventScroll:true});
  pointers.set(e.pointerId, { x:e.clientX, y:e.clientY,startX:e.clientX,startY:e.clientY,moved:false,pan:e.shiftKey || e.button !== 0 });
  canvas.setPointerCapture(e.pointerId);
  if (pointers.size > 1) {
    for(const pointer of pointers.values())pointer.moved=true;
    const [a,b] = [...pointers.values()]; pinchDistance = Math.hypot(a.x-b.x,a.y-b.y);
    planner.clearPreview();
  }
});
canvas.addEventListener('pointermove', e => {
  if(!demoReady)return;
  const old = pointers.get(e.pointerId);
  if (!old) {planner.hover(e.clientX,e.clientY);return;}
  const dx=e.clientX-old.x,dy=e.clientY-old.y;
  const moved=old.moved||Math.hypot(e.clientX-old.startX,e.clientY-old.startY)>5;
  pointers.set(e.pointerId,{...old,x:e.clientX,y:e.clientY,moved});
  if(!moved)return;
  canvas.classList.add('dragging');planner.clearPreview();
  if (pointers.size === 2) {
    const [a,b]=[...pointers.values()], next=Math.hypot(a.x-b.x,a.y-b.y);
    pan(dx / 2, dy / 2);
    if (pinchDistance) zoom=THREE.MathUtils.clamp(zoom*next/pinchDistance,minZoom,maxZoom);
    pinchDistance=next;
  } else if (old.pan || e.shiftKey) {
    pan(dx,dy);
  } else {
    yaw -= dx*0.004; pitch=Math.max(0.35,Math.min(1.15,pitch+dy*0.003));
  }
  fitCamera(); draw(performance.now());
});
function release(e) { pointers.delete(e.pointerId); if (!pointers.size) canvas.classList.remove('dragging'); pinchDistance=0; }
canvas.addEventListener('pointerup',e=>{
  if(!demoReady){release(e);return;}
  const pointer=pointers.get(e.pointerId);
  const isTap=pointer&&!pointer.moved&&!pointer.pan&&!e.shiftKey&&e.button===0&&pointers.size===1&&Math.hypot(e.clientX-pointer.startX,e.clientY-pointer.startY)<=5;
  release(e);
  if(isTap)planner.tap(e.clientX,e.clientY);
  else if(!pointers.size)planner.hover(e.clientX,e.clientY);
});
canvas.addEventListener('pointercancel',release);
canvas.addEventListener('lostpointercapture',release);
canvas.addEventListener('contextmenu',e=>e.preventDefault());
canvas.addEventListener('wheel',e=>{ e.preventDefault();if(!demoReady)return;const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?height:1);zoom=THREE.MathUtils.clamp(zoom*Math.exp(-delta*0.001),minZoom,maxZoom);fitCamera();planner.hover(e.clientX,e.clientY);draw(performance.now()); },{passive:false});
canvas.addEventListener('keydown',e=>{
  if(!demoReady){e.preventDefault();return;}
  if(['1','2'].includes(e.key)&&canvas.dataset.analysisOpen==='true')analysis.close({restoreFocus:false});
  if(planner.keydown(e)){e.preventDefault();return;}
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','0','Home'].includes(e.key))return;
  e.preventDefault();
  if(e.shiftKey && e.key.startsWith('Arrow')) {
    pan(e.key==='ArrowLeft'?48:e.key==='ArrowRight'?-48:0,e.key==='ArrowUp'?48:e.key==='ArrowDown'?-48:0);
  } else {
    if(e.key==='ArrowLeft')yaw+=.12;if(e.key==='ArrowRight')yaw-=.12;
    if(e.key==='ArrowUp')pitch=Math.min(1.15,pitch+.08);if(e.key==='ArrowDown')pitch=Math.max(.35,pitch-.08);
  }
  if(['+','='].includes(e.key))zoom=Math.min(maxZoom,zoom*1.1);if(e.key==='-')zoom=Math.max(minZoom,zoom/1.1);
  if(['0','Home'].includes(e.key)){resetCamera();return;}
  planner.clearPreview();
  fitCamera();draw(performance.now());
});
window.addEventListener('resize',resize);
document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;}else resume();});
reduceMotion.addEventListener('change',()=>{cancelAnimationFrame(raf);raf=0;resume();});
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();cancelAnimationFrame(raf);raf=0;});
canvas.addEventListener('webglcontextrestored',resume);
resize();routing.initialize();resume();
document.documentElement.dataset.mapReady='true';
canvas.dataset.tiles=String(landscape.world.tiles.length);
canvas.dataset.drawCalls=String(renderer.info.render.calls);
canvas.dataset.triangles=String(renderer.info.render.triangles);
canvas.dataset.engine='three-webgl';
