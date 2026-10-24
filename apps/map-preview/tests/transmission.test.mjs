import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.cjs';
import { createWorld } from '../src/world.js';
import { createPlacement } from '../src/placement.js';
import { computeTransmissionRoutes } from '../src/routing.js';
import { createTransmissionLayer } from '../src/transmission-models.js';

const world=createWorld();
const substation=createPlacement(world,'substation',-43,-17);
const datacenter=createPlacement(world,'datacenter',43,17,{substation});
const routes=computeTransmissionRoutes(world,{substation,datacenter});
const selected=routes.candidates.find(route=>route.id===routes.recommendedId);
assert(selected,'the reference A/B fixture must have a route');

test('a selected engine route produces physical pylons and continuous three-phase conductors',()=>{
  const layer=createTransmissionLayer(THREE,world);
  const diagnostics=layer.showRoute(selected);
  assert.equal(layer.group.name,'Transmission network');
  assert.equal(layer.group.userData.routeId,selected.id);
  assert.equal(diagnostics.pylonCount,selected.nodes.filter(node=>node.kind==='tower').length);
  assert(diagnostics.pylonCount>0);
  assert.equal(diagnostics.terminalCount,2);
  assert.equal(diagnostics.spanCount,selected.nodes.length-1);
  assert(diagnostics.minimumClearance>=2);
  const conductors=layer.group.getObjectByName('Three-phase conductors');
  assert(conductors?.isMesh,'conductors must have 3D tube geometry');
  const paths=conductors.userData.phasePaths;
  assert.equal(paths.length,diagnostics.spanCount*3);
  for(let phase=0;phase<3;phase++) {
    const ordered=paths.filter(path=>path.phase===phase).sort((a,b)=>a.spanIndex-b.spanIndex);
    for(let index=1;index<ordered.length;index++) {
      const from=ordered[index-1].points.at(-1),to=ordered[index].points[0];
      assert(Math.hypot(from.x-to.x,from.y-to.y,from.z-to.z)<1e-8,'a phase must connect at each support');
    }
    for(const path of ordered) {
      assert(path.points.length>=13);
      assert(path.sag>=0 && path.sag<=1.1);
    }
  }
  layer.group.updateMatrixWorld(true);
  const bounds=new THREE.Box3().setFromObject(layer.group);
  assert([...bounds.min.toArray(),...bounds.max.toArray()].every(Number.isFinite));
  assert(bounds.max.y>10,'the physical line must rise above its foundations');
  layer.group.traverse(object=>{
    const positions=object.geometry?.getAttribute('position');
    if(positions)assert([...positions.array].every(Number.isFinite));
    if(object.instanceMatrix)assert([...object.instanceMatrix.array].every(Number.isFinite));
  });
  layer.dispose();
});

test('switching and clearing routes removes old geometry and disposes conductor buffers',()=>{
  const layer=createTransmissionLayer(THREE,world);
  layer.showRoute(selected);
  const previous=layer.group.getObjectByName('Three-phase conductors');
  let previousDisposed=0;
  previous.geometry.addEventListener('dispose',()=>previousDisposed++);
  const next=routes.candidates.find(route=>route.id!==selected.id)??selected;
  layer.showRoute(next);
  assert.equal(previousDisposed,1);
  assert.equal(layer.group.userData.routeId,next.id);
  assert(!layer.group.children.includes(previous));
  const current=layer.group.getObjectByName('Three-phase conductors');
  let currentDisposed=0;
  current.geometry.addEventListener('dispose',()=>currentDisposed++);
  layer.clear();
  assert.equal(currentDisposed,1);
  assert.equal(layer.group.children.length,0);
  assert.equal(layer.group.userData.routeId,null);
  assert.equal(layer.diagnostics.pylonCount,0);
  layer.dispose();
  assert.throws(()=>layer.showRoute(selected),/disposed/);
});

test('empty or unsafe route data cannot leave a partial physical network',()=>{
  const layer=createTransmissionLayer(THREE,world);
  layer.showRoute(selected);layer.showRoute(null);
  assert.equal(layer.group.children.length,0);
  assert.throws(()=>layer.showRoute({id:'bad-height',nodes:selected.nodes.map(node=>({...node,height:0}))}),/positive heights/);
  assert.equal(layer.group.children.length,0);
  layer.dispose();
});
