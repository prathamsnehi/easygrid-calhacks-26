import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.cjs';
import { createWorld } from '../src/world.js';
import {
  FACILITY_SPECS, createPlacement, footprintAt, validatePlacement,
  serializePlan, restorePlan, pickTerrain,
} from '../src/placement.js';

const world = createWorld();
const areaOfRing = ring => Math.abs(ring.slice(0,-1).reduce((area,p,i) =>
  area + p[0]*ring[i+1][1] - ring[i+1][0]*p[1], 0) / 2);
const validA = () => createPlacement(world,'substation',-43,-17);
const validB = a => createPlacement(world,'datacenter',43,17,{substation:a});
const stored = values => JSON.stringify({schemaVersion:1,
  fixtureVersion:world.parcelFixtureVersion,coordinateSystem:'local-demo-grid',...values});

test('every rendered tile belongs to one parcel with a synthetic owner', () => {
  assert.equal(world.parcels.length,24);
  assert.equal(world.owners.length,24);
  assert.equal(new Set(world.tiles.map(t=>`${t.x},${t.z}`)).size,world.tiles.length);
  const counts = new Map();
  for(const tile of world.tiles) {
    assert(world.parcelById.has(tile.parcelId));
    counts.set(tile.parcelId,(counts.get(tile.parcelId)??0)+1);
    if(tile.terrain==='field') assert.match(tile.fieldId,/^P[1-6]$/);
    assert.equal(tile.facilityAllowed,tile.buildable);
  }
  for(const parcel of world.parcels) {
    assert.equal(counts.get(parcel.id),parcel.tileCount);
    assert.equal(parcel.areaTiles,parcel.tileCount);
    assert.equal(parcel.coordinateSystem,'local-demo-grid');
    const owner=world.ownerById.get(parcel.ownerId);
    assert(owner?.synthetic);
    assert.equal(owner.dialTarget,null);
    assert.match(owner.email,/@example\.com$/);
    assert.equal(parcel.contactRef,owner.contactRef);
    assert.equal(parcel.accessConsent,'unknown');
  }
  assert.equal(world.parcels.reduce((sum,p)=>sum+p.tileCount,0),world.tiles.length);
});

test('local parcel polygons preserve clipped corners and exact tile area', () => {
  for(const parcel of world.parcels) {
    const ring=parcel.geometry.rings[0];
    assert.deepEqual(ring[0],ring.at(-1));
    assert(ring.every(point=>point.length===2 && point.every(Number.isFinite)));
    assert.equal(areaOfRing(ring),parcel.tileCount);
  }
  assert(world.parcels.some(p=>p.tileCount<20*24),'corner parcels must be clipped');
});

test('facility placement and transmission passage have separate policies', () => {
  const field=world.tiles.find(t=>t.terrain==='field' && !t.occupiedBy.includes('orchard-tree'));
  assert.equal(field.facilityAllowed,false);
  assert.equal(field.routingPolicy.linePassage,'review');
  assert(field.routingPolicy.reasons.includes('agricultural-impact'));
  const water=world.tiles.find(t=>t.terrain==='river');
  assert.equal(water.routingPolicy.towerPlacement,'blocked');
  assert.equal(water.routingPolicy.linePassage,'review');
});

test('all six clearings fit both full-size facility footprints', () => {
  assert.equal(world.clearings.length,6);
  for(const clearing of world.clearings) {
    for(const kind of Object.keys(FACILITY_SPECS)) {
      const x=(clearing.x0+clearing.x1)/2,z=(clearing.z0+clearing.z1)/2;
      const result=validatePlacement(world,kind,x,z);
      assert.equal(result.valid,true,`${clearing.id}/${kind}: ${result.reason}`);
      let count=0;
      const f=result.footprint;
      for(let tz=f.z0;tz<f.z1;tz++)for(let tx=f.x0;tx<f.x1;tx++) {
        assert.equal(world.tileAt(tx+.5,tz+.5).facilityAllowed,true);
        count++;
      }
      assert.equal(count,kind==='substation'?120:280);
    }
  }
});

test('a clear center does not permit a footprint that reaches farmland', () => {
  assert.equal(world.tileAt(-31,16).facilityAllowed,true);
  const result=validatePlacement(world,'substation',-31,16);
  assert.equal(result.valid,false);
  assert(result.codes.includes('agriculture'));
});

test('water, hills, crops, existing objects and map edges reject placement', () => {
  const cases=[
    [4,0,'water'],[-36,-39,'uneven'],[-20,-18,'agriculture'],
    [-20,-4,'occupied'],[59,47,'outside-map'],
  ];
  for(const [x,z,code] of cases) {
    const result=validatePlacement(world,'substation',x,z);
    assert.equal(result.valid,false,`${x},${z}`);
    assert(result.codes.includes(code),`${code}: ${result.codes}`);
    assert.equal(createPlacement(world,'substation',x,z),null);
  }
  for(const x of [NaN,Infinity,-Infinity,1e100,-1e100])
    assert.equal(validatePlacement(world,'datacenter',x,0).valid,false);
  assert.equal(footprintAt('unknown',0,0),null);
});

test('touching footprints are valid; overlap is not; an edit ignores its old site', () => {
  const a=createPlacement(world,'substation',43,14);
  assert(a);
  const b=createPlacement(world,'datacenter',43,26,{substation:a});
  assert(b);
  assert.equal(a.footprint.z1,b.footprint.z0);
  const overlap=validatePlacement(world,'datacenter',43,25,{substation:a});
  assert.equal(overlap.valid,false);
  assert(overlap.codes.includes('overlap'));
  assert.equal(validatePlacement(world,'substation',a.x,a.z,{substation:a,datacenter:b}).valid,true);
});

test('placement records derive every crossed parcel and their connection point', () => {
  const b=validB(validA());
  assert(b);
  assert(b.parcelIds.length>1,'fixture facility spans more than one parcel');
  const ids=new Set();
  for(const tile of world.tiles) {
    if(tile.x>b.footprint.x0 && tile.x<b.footprint.x1 && tile.z>b.footprint.z0 && tile.z<b.footprint.z1)
      ids.add(tile.parcelId);
  }
  assert.deepEqual(b.parcelIds,[...ids].sort());
  assert.equal(b.y,1.5);
  assert.equal(b.connectionPoint.x,b.x);
  assert.equal(b.connectionPoint.z,b.footprint.z1-.5);
});

test('saved plans round-trip and rebuild derived state from trusted fixtures', () => {
  const a=validA(),b=validB(a),placements={substation:a,datacenter:b};
  const serialized=serializePlan(world,placements);
  const parsed=JSON.parse(serialized);
  assert.deepEqual(Object.keys(parsed.substation).sort(),['x','z']);
  assert.deepEqual(restorePlan(world,serialized),{placements,discarded:false});
  parsed.substation={...parsed.substation,y:999,parcelIds:['fake'],footprint:{width:1},key:'B'};
  assert.deepEqual(restorePlan(world,JSON.stringify(parsed)),{placements,discarded:false});
});

test('stale, malformed and impossible saved plans cannot restore invalid facilities', () => {
  for(const raw of ['{','null',stored({fixtureVersion:'old'}),stored({schemaVersion:99}),
    stored({substation:{x:4,z:0}}),stored({substation:{x:1e100,z:1e100}}),
    stored({substation:{x:-43.5,z:-17}}),stored({datacenter:{x:43,z:17}})]) {
    const restored=restorePlan(world,raw);
    assert.equal(restored.discarded,true,raw);
    assert.equal(restored.placements.substation,null);
    assert.equal(restored.placements.datacenter,null);
  }
  const overlap=restorePlan(world,stored({substation:{x:43,z:14},datacenter:{x:43,z:14}}));
  assert.equal(overlap.discarded,true);
  assert(overlap.placements.substation);
  assert.equal(overlap.placements.datacenter,null);
});

test('terrain picking matches actual Three voxel intersections at varied heights', () => {
  const geometry=new THREE.BoxGeometry(1,1,1);
  const material=new THREE.MeshBasicMaterial();
  const voxels=new THREE.InstancedMesh(geometry,material,world.tiles.length);
  const transform=new THREE.Object3D();
  world.tiles.forEach((tile,i)=>{
    const top=tile.terrain==='river'?.79:tile.height;
    transform.position.set(tile.x,(top-3.9)/2,tile.z);
    transform.scale.set(1,top+3.9,1);transform.updateMatrix();
    voxels.setMatrixAt(i,transform.matrix);
  });
  voxels.computeBoundingSphere();voxels.updateMatrixWorld(true);
  const rays=[];
  for(const terrain of ['river','hill','meadow']) {
    const tile=world.tiles.find(t=>t.terrain===terrain);
    rays.push(new THREE.Ray(new THREE.Vector3(tile.x,60,tile.z),new THREE.Vector3(0,-1,0)));
  }
  for(const point of [[-36,12,-39],[4,.79,0],[43,1.5,17]]) {
    const origin=new THREE.Vector3(78,80,90);
    rays.push(new THREE.Ray(origin,new THREE.Vector3(...point).sub(origin).normalize()));
  }
  for(const ray of rays) {
    const actual=new THREE.Raycaster(ray.origin,ray.direction).intersectObject(voxels)[0];
    const picked=pickTerrain(world,ray);
    assert(actual && picked);
    assert(actual.point.distanceTo(new THREE.Vector3(picked.x,picked.y,picked.z))<1e-5);
  }
  const miss=new THREE.Ray(new THREE.Vector3(200,60,200),new THREE.Vector3(0,-1,0));
  assert.equal(pickTerrain(world,miss),null);
  geometry.dispose();material.dispose();
});
