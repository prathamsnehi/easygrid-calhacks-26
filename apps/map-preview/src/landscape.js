import { createWorld, riverCenter } from './world.js';

/** Build an entirely geometric voxel landscape. No remote assets or private data. */
export function createLandscape(THREE) {
  const world = createWorld();
  const group = new THREE.Group();
  group.name = 'California voxel valley';
  const boxes = new Map();
  const clearableInstances = [];
  const materials = new Set();
  const geometries = new Set();
  const cube = new THREE.BoxGeometry(1, 1, 1);
  geometries.add(cube);
  const oakColors = [0x66874d, 0x789652, 0x8b9f58, 0x52774a];
  const grassColors = [0x9ca96a, 0xa5b174, 0xadb879, 0x94a267];
  const hillColors = [0xc7b477, 0xd2be80, 0xbdaa70, 0xc3b078];
  const waterColors = [0x3a9b9b, 0x369293, 0x42a1a0, 0x379b9d];
  const dummy = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);

  function box(color, x, y, z, w = 1, h = 1, d = 1, rotation = null) {
    const key = color.toString(16);
    if (!boxes.has(key)) boxes.set(key, { color, transforms: [] });
    const transform = { x, y, z, w, h, d, rotation };
    boxes.get(key).transforms.push(transform);
    return transform;
  }
  function coverBox(kind, tile, ...args) {
    const transform = box(...args);
    transform.cover = {
      kind,
      cellBounds: { x0: tile.x-0.5, x1: tile.x+0.5, z0: tile.z-0.5, z1: tile.z+0.5 },
      bounds: {
        x0: transform.x-transform.w/2, x1: transform.x+transform.w/2,
        z0: transform.z-transform.d/2, z1: transform.z+transform.d/2,
      },
    };
  }
  function beam(color, a, b, width = 0.2) {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
    const direction = end.clone().sub(start);
    const rotation = new THREE.Quaternion().setFromUnitVectors(up, direction.clone().normalize());
    const mid = start.add(end).multiplyScalar(0.5);
    box(color, mid.x, mid.y, mid.z, width, direction.length(), width, rotation);
  }
  function surfaceAt(x, z) { return world.tileAt(x, z)?.height ?? 1.5; }

  // Continuous soil slabs avoid multiplying invisible geometry as the map grows.
  // The exposed top remains a one-unit voxel grid; the river cuts through it.
  const rows = new Map();
  for (const tile of world.tiles) {
    if (!rows.has(tile.iz)) rows.set(tile.iz, []);
    rows.get(tile.iz).push(tile);
  }
  for (const row of rows.values()) {
    const midX = (row[0].x + row[row.length-1].x) / 2;
    const width = row.length + 0.005;
    box(0x5e6451,midX,-3.65,row[0].z,width,0.5,1.005);
    box(0x8c7458,midX,-2.7,row[0].z,width,1.4,1.005);
    box(0xb29469,midX,-1.55,row[0].z,width,0.9,1.005);
    let start = 0;
    for (let end = 1; end <= row.length; end++) {
      const first = row[start], next = row[end];
      if (next && next.height === first.height && (next.terrain === 'hill') === (first.terrain === 'hill')) continue;
      const earthTop = first.height - 0.22;
      box(first.terrain === 'hill' ? 0xb29b6a : 0xbfa77b,
        (first.x+row[end-1].x)/2,(earthTop-1.1)/2,first.z,end-start+0.003,earthTop+1.1,1.003);
      start = end;
    }
  }
  for (const t of world.tiles) {
    let color;
    if (t.terrain === 'river') color = 0xb4b48b;
    else if (t.terrain === 'shore') color = 0xd3c599;
    else if (t.terrain === 'road') color = t.variation > 0.5 ? 0xcbbc91 : 0xc4b38a;
    else if (t.terrain === 'farmyard') color = 0xb9ad86;
    else if (t.terrain === 'field') {
      color = t.crop === 'wheat' ? 0xa99055 : t.crop === 'vegetables' ? 0x718253 : t.crop === 'orchard' ? 0x829457 : 0x89945e;
    } else if (t.terrain === 'hill') color = hillColors[Math.floor(t.variation * hillColors.length)];
    else color = grassColors[Math.floor(t.variation * grassColors.length)];
    box(color, t.x, t.height - 0.11, t.z, 1.006, 0.22, 1.006);
    if (t.terrain === 'river') {
      box(waterColors[Math.floor(t.variation * waterColors.length)], t.x, 0.66, t.z, 1.008, 0.26, 1.008);
    }
    const inFarmyard = t.x >= world.farmyard.x0 && t.x < world.farmyard.x1 &&
      t.z >= world.farmyard.z0 && t.z < world.farmyard.z1;
    if (t.terrain === 'field' && !inFarmyard) {
      if (t.crop === 'wheat') {
        if (t.ix % 2 === 0) {
          coverBox('crop', t, 0xc9ad56, t.x, t.height + 0.3, t.z, 0.62, 0.6, 0.87);
          coverBox('crop', t, t.variation > 0.5 ? 0xdfc573 : 0xd5bb65, t.x, t.height + 0.62, t.z, 0.65, 0.1, 0.88);
        } else coverBox('crop', t, 0x9b824e, t.x, t.height + 0.015, t.z, 0.38, 0.03, 1);
      } else if (t.crop === 'vineyard') {
        if (t.ix % 3 === 0) {
          coverBox('crop', t, 0x526e43, t.x, t.height + 0.48, t.z, 0.7, 0.85, 0.94);
          coverBox('crop', t, 0x6f8949, t.x, t.height + 0.93, t.z, 0.65, 0.12, 0.94);
          if (t.iz % 3 === 0) coverBox('crop', t, 0x8d7655, t.x, t.height + 0.65, t.z, 0.12, 1.3, 0.12);
        }
      } else if (t.crop === 'vegetables') {
        coverBox('crop', t, 0x627b45, t.x, t.height + 0.05, t.z, 0.65, 0.1, 0.94);
        for (const dz of [-0.28, 0.28]) {
          coverBox('crop', t, t.variation > 0.4 ? 0x88a45c : 0x78954e, t.x, t.height + 0.25, t.z + dz, 0.55, 0.4, 0.39);
          coverBox('crop', t, 0x9db66a, t.x - 0.04, t.height + 0.48, t.z + dz, 0.3, 0.08, 0.27);
        }
      }
    }
    // Tall grass clusters are sparse, so the agricultural shapes stay legible.
    if (t.grass) {
      coverBox('grass', t, 0xb8b878, t.x, t.height + 0.21, t.z, 0.15, 0.42, 0.22);
      coverBox('grass', t, 0xa5aa68, t.x + 0.2, t.height + 0.15, t.z + 0.1, 0.13, 0.3, 0.15);
    }
  }

  function oak(x, z, scale = 1, variety = 0) {
    const tile = world.tileAt(x, z);
    if (!tile || ['river', 'shore', 'road'].includes(tile.terrain) || world.isReserved(x,z,2)) return;
    const y = tile.height;
    box(0x76634b, x, y + 1.05 * scale, z, 0.38 * scale, 2.1 * scale, 0.38 * scale);
    box(0x8e7955, x - 0.22 * scale, y + 1.6 * scale, z, 0.7 * scale, 0.22 * scale, 0.25 * scale);
    box(oakColors[variety % 4], x, y + 2.35 * scale, z, 2.25 * scale, 1.3 * scale, 1.8 * scale);
    box(oakColors[(variety + 1) % 4], x + 0.3 * scale, y + 3.12 * scale, z - 0.15 * scale, 1.75 * scale, 0.5 * scale, 1.48 * scale);
    box(oakColors[(variety + 2) % 4], x - 0.8 * scale, y + 2.55 * scale, z + 0.35 * scale, 0.8 * scale, 0.75 * scale, 1.3 * scale);
  }
  function cypress(x, z, scale = 1) {
    const tile = world.tileAt(x, z); if (!tile || tile.terrain === 'river' || world.isReserved(x,z,2)) return;
    const y = tile.height;
    box(0x776a4c, x, y + 0.8 * scale, z, 0.3 * scale, 1.6 * scale, 0.3 * scale);
    for (let i = 0; i < 5; i++) {
      const w = (1.6 - i * 0.23) * scale;
      box(i % 2 ? 0x476b46 : 0x52774a, x, y + (1.2 + i * 0.57) * scale, z, w, 0.7 * scale, w);
    }
  }
  // Decoration positions come from the same model as buildability metadata.
  for (const tree of world.trees) {
    const {x,z,scale,kind,variety,orchard} = tree;
    if (kind === 'cypress') cypress(x,z,scale); else oak(x,z,scale,variety);
    if (orchard) {
      const y=surfaceAt(x,z)+1.45;
      box(0xcf8950,x+0.45,y,z+0.45,0.18,0.18,0.18);
      box(0xe0a65c,x-0.45,y+0.1,z+0.4,0.17,0.17,0.17);
    }
  }

  // Small farmstead: a weathered red barn, pale silo, fences and a wind pump.
  const bx=-20.5,bz=-3.6,by=surfaceAt(bx,bz);
  box(0xb9ad86,-20,by+0.025,-3.5,10,0.05,7);
  box(0x9d6150,bx,by+1.55,bz,5.2,3.1,3.6);
  box(0xb37359,bx-2.63,by+1.55,bz,0.08,3.1,3.6);
  box(0xc59770,bx,by+0.17,bz+1.84,5.3,0.34,0.12);
  for(let i=0;i<6;i++)box(i%2?0x59625a:0x515c56,bx,by+3.15+i*0.27,bz,5.8,0.31,4.2-i*0.66);
  box(0x5b5144,bx,by+1.2,bz+1.83,1.7,2.4,0.1);
  box(0xdecdae,bx-0.95,by+1.3,bz+1.91,0.14,2.6,0.14);
  box(0xdecdae,bx+0.95,by+1.3,bz+1.91,0.14,2.6,0.14);
  box(0xdecdae,bx,by+2.65,bz+1.91,2.04,0.14,0.14);
  beam(0xc9b596,[bx-0.74,by+0.2,bz+1.93],[bx+0.74,by+2.35,bz+1.93],0.1);
  for(const side of [-1,1]){
    box(0xe0d2b5,bx+side*1.9,by+1.8,bz+1.83,0.65,0.75,0.12);
    box(0x596e68,bx+side*1.9,by+1.8,bz+1.91,0.43,0.52,0.08);
  }
  const sx=-16.5,sz=-4,sy=surfaceAt(sx,sz);
  box(0xd3cbb2,sx,sy+2.2,sz,2.15,4.4,2.15);
  for(let i=0;i<4;i++)box(0xa7ad9e,sx,sy+4.45+i*0.2,sz,2.5-i*0.5,0.23,2.5-i*0.5);
  for(const h of [0.45,1.5,2.55,3.6])box(0xa8ad9e,sx,sy+h,sz+1.09,2.22,0.1,0.08);
  for(let x=-27;x<=-14;x+=2.2){
    const y=surfaceAt(x,6.2);box(0x9c8b60,x,y+0.55,6.2,0.14,1.1,0.14);
    if(x<-15)box(0xb3a079,x+1.1,y+0.7,6.2,2.2,0.1,0.1);
  }
  // A few hay bales make the harvested parcel feel worked rather than decorative.
  for(const [x,z] of [[-24,19],[-22.8,19],[-24,17.8]])box(0xc6a968,x,surfaceAt(x,z)+0.45,z,0.85,0.9,0.85);

  // The dirt road crosses on one modest wooden bridge; the river remains visible beneath it.
  const bridgeZ=4.5,bridgeX=riverCenter(bridgeZ);
  for(let i=0;i<14;i++)box(i%3?0x9b8057:0xa78b60,bridgeX-5.2+i*0.8,1.75,bridgeZ,0.77,0.26,2.65);
  for(const side of [-1,1]){
    for(let i=0;i<5;i++)box(0x82724f,bridgeX-5+i*2.5,2.2,bridgeZ+side*1.32,0.18,1.2,0.18);
    box(0xa48b61,bridgeX,2.7,bridgeZ+side*1.32,10.3,0.12,0.12);
  }

  const wx=-12.5,wz=-2,wy=surfaceAt(wx,wz);
  for(const dx of [-0.7,0.7])for(const dz of [-0.7,0.7])beam(0x8c8165,[wx+dx,wy,wz+dz],[wx+dx*0.35,wy+5,wz+dz*0.35],0.14);
  for(const h of [1.5,3])box(0x93876b,wx,wy+h,wz,1.2-h*0.15,0.13,1.2-h*0.15);
  const mill=new THREE.Group();mill.position.set(wx,wy+5,wz+0.4);group.add(mill);
  const millMaterial=new THREE.MeshLambertMaterial({color:0xc5bba0});materials.add(millMaterial);
  for(let i=0;i<8;i++){
    const blade=new THREE.Mesh(cube,millMaterial);const a=i*Math.PI/4;
    blade.position.set(Math.cos(a)*0.84,Math.sin(a)*0.84,0);
    blade.scale.set(1.18,0.3,0.09);blade.rotation.z=a+0.12;blade.castShadow=true;mill.add(blade);
  }
  const hub=new THREE.Mesh(cube,millMaterial);hub.scale.set(0.38,0.38,0.2);hub.position.z=0.1;mill.add(hub);

  // Broken, square-edged rock outcrops, kept away from farmland and the water channel.
  for(const {x,z,scale:s} of world.rocks){
    const y=surfaceAt(x,z);box(0xa59e80,x,y+s*0.3,z,s,s*0.6,s*0.8);
    box(0xb9ae8b,x-s*0.15,y+s*0.7,z,s*0.66,s*0.35,s*0.6);
  }

  for (const { color, transforms } of boxes.values()) {
    const material = new THREE.MeshLambertMaterial({ color, flatShading:true });materials.add(material);
    const mesh = new THREE.InstancedMesh(cube, material, transforms.length);
    mesh.name='Voxels '+color.toString(16);
    transforms.forEach((v,i)=>{
      dummy.position.set(v.x,v.y,v.z);dummy.scale.set(v.w,v.h,v.d);
      if(v.rotation)dummy.quaternion.copy(v.rotation);else dummy.quaternion.identity();
      dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix);
      if(v.cover) clearableInstances.push({
        ...v.cover, mesh, index:i, originalMatrix:dummy.matrix.clone(), hidden:false,
      });
    });
    mesh.instanceMatrix.needsUpdate=true;
    mesh.castShadow=true;mesh.receiveShadow=true;mesh.computeBoundingSphere();group.add(mesh);
  }

  const hiddenMatrix = new THREE.Matrix4();
  const zeroScale = new THREE.Vector3(0,0,0);
  /** Replace temporary tower clearings; an empty list restores every crop and grass instance. */
  function setFoundationClearings(foundations = []) {
    const rectangles = foundations.filter(f => f &&
      [f.x0,f.x1,f.z0,f.z1].every(Number.isFinite) && f.x0 < f.x1 && f.z0 < f.z1);
    const changedMeshes = new Set();
    let cropInstances = 0, grassInstances = 0;
    for (const instance of clearableInstances) {
      const b = instance.bounds;
      const hidden = rectangles.some(f => b.x0 < f.x1 && b.x1 > f.x0 && b.z0 < f.z1 && b.z1 > f.z0);
      if (hidden) {
        if(instance.kind === 'crop') cropInstances++; else grassInstances++;
      }
      if (hidden === instance.hidden) continue;
      instance.mesh.setMatrixAt(instance.index, hidden ?
        hiddenMatrix.copy(instance.originalMatrix).scale(zeroScale) : instance.originalMatrix);
      instance.hidden = hidden;
      changedMeshes.add(instance.mesh);
    }
    for (const mesh of changedMeshes) mesh.instanceMatrix.needsUpdate = true;
    // Original full-size bounding spheres remain conservative during hiding and restoration.
    return { hiddenInstances:cropInstances+grassInstances, cropInstances, grassInstances };
  }

  // A handful of pale glints drift gently along the channel.
  const glintMaterial=new THREE.MeshBasicMaterial({color:0xb0d2bb,transparent:true,opacity:0.45});materials.add(glintMaterial);
  const glintCount=48;
  const glints=new THREE.InstancedMesh(cube,glintMaterial,glintCount);glints.name='River glints';group.add(glints);
  function update(time=0){
    mill.rotation.z=-time*0.14;
    for(let i=0;i<glintCount;i++){
      const z=((i*world.depth/glintCount+time*0.28)%world.depth)-world.depth/2;
      const x=riverCenter(z)+Math.sin(i*7.2)*1.35;
      dummy.position.set(x,0.797+Math.sin(time+i)*0.005,z);dummy.quaternion.identity();
      dummy.scale.set(0.25+(i%3)*0.15,0.015,0.09);dummy.updateMatrix();glints.setMatrixAt(i,dummy.matrix);
    }
    glints.instanceMatrix.needsUpdate=true;
  }
  update(0);
  return {
    group, world,
    bounds:{width:world.width,depth:world.depth,minY:-3.9,maxY:Math.max(...world.tiles.map(t=>t.height))+4,center:[0,3,0]},
    update, setFoundationClearings,
    dispose(){geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());},
  };
}
