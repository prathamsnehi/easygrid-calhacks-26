/** Display-only transmission geometry. Dimensions and clearances are demo units. */
export function createTransmissionLayer(THREE, world) {
  const group = new THREE.Group();
  group.name = 'Transmission network';
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const palette = {
    concrete: 0xc9cbb7, steel: 0x526b67, steelLight: 0x7a8e83,
    ceramic: 0xe2e5cc, connector: 0x548bba, wire: 0x385d71,
  };
  const materials = new Map(Object.entries(palette).map(([name,color]) => [name,
    new THREE.MeshLambertMaterial({ color, flatShading: true })]));
  const axis = new THREE.Vector3(0, 1, 0);
  const transform = new THREE.Object3D();
  const wireRadius = 0.045;
  let disposed = false;
  let diagnostics = emptyDiagnostics();

  function emptyDiagnostics() {
    return { routeId: null, spanCount: 0, pylonCount: 0, terminalCount: 0,
      conductorCount: 0, boxInstances: 0, drawCalls: 0, sampleCount: 0,
      minimumClearance: null, minClearance: null, maxY: null };
  }
  function clear() {
    for (const object of [...group.children]) {
      if (object.geometry && object.geometry !== cube) object.geometry.dispose();
      if (object.isInstancedMesh) object.dispose();
      group.remove(object);
    }
    diagnostics = emptyDiagnostics();
    group.userData = { routeId: null, supportCount: 0 };
  }

  // The engine uses the same conservative canopy envelope. This is not an
  // electrical clearance standard or a substitute for an engineered line model.
  function obstacleTop(x,z) {
    const tile = world.tileAt(x,z);
    if (!tile) return null;
    let top = tile.terrain === 'river' ? 0.79 : tile.height;
    const occupied = tile.occupiedBy ?? [];
    if (occupied.some(kind => kind === 'tree' || kind === 'orchard-tree')) top += 4.5;
    else if (tile.terrain === 'field') top += 1.3;
    else if (occupied.includes('grass')) top += 0.5;
    if (occupied.includes('bridge')) top = Math.max(top, 2.8);
    if (occupied.includes('rock')) top = Math.max(top, tile.height + 2);
    if (occupied.some(kind => kind === 'farmstead' || kind === 'wind-pump')) top = Math.max(top, tile.height + 6.3);
    return top;
  }

  function showRoute(candidate) {
    if (disposed) throw new Error('Transmission layer has been disposed.');
    if (!candidate || !Array.isArray(candidate.nodes) || candidate.nodes.length < 2) {
      clear();
      return diagnostics;
    }
    const nodes = candidate.nodes.map((node,index) => {
      const groundY = node.groundY ?? world.tileAt(node.x,node.z)?.height;
      const height = node.height ?? 10;
      if (![node.x,node.z,groundY,height].every(Number.isFinite) || height <= 0) {
        throw new Error('Transmission supports require finite coordinates and positive heights.');
      }
      if (!['tower','terminal'].includes(node.kind)) throw new Error('Unknown transmission support type.');
      const previous = candidate.nodes[Math.max(0,index-1)];
      const next = candidate.nodes[Math.min(candidate.nodes.length-1,index+1)];
      let dx = next.x-previous.x,dz = next.z-previous.z;
      const distance = Math.hypot(dx,dz);
      if (distance < 1e-8) { dx=0;dz=1; } else { dx/=distance;dz/=distance; }
      return { ...node,groundY,height,tangent:{x:dx,z:dz},normal:{x:-dz,z:dx} };
    });
    const batches = new Map();
    function point(node,x,y,z=0) {
      return new THREE.Vector3(node.x+node.normal.x*x+node.tangent.x*z,
        node.groundY+y,node.z+node.normal.z*x+node.tangent.z*z);
    }
    function beam(material,from,to,width=0.09,depth=width) {
      const delta = to.clone().sub(from),length = delta.length();
      if (length < 1e-8) return;
      if (!batches.has(material)) batches.set(material,[]);
      batches.get(material).push({ position:from.clone().add(to).multiplyScalar(0.5),
        scale:new THREE.Vector3(width,length,depth),
        rotation:new THREE.Quaternion().setFromUnitVectors(axis,delta.normalize()) });
    }
    function block(material,node,x,y,z,width,height,depth) {
      if (!batches.has(material)) batches.set(material,[]);
      // Rotate local x/z axes with the crossarm, while keeping all foundations
      // within the engine's axis-aligned 2 × 2 reserved square.
      const rotation = new THREE.Quaternion().setFromAxisAngle(axis,Math.atan2(-node.normal.z,node.normal.x));
      batches.get(material).push({ position:point(node,x,y,z),
        scale:new THREE.Vector3(width,height,depth),rotation });
    }
    function support(node) {
      const height = node.height;
      if (node.kind === 'terminal') {
        block('concrete',node,0,.22,0,.72,.44,.72);
        block('connector',node,0,.48,0,.47,.12,.47);
        beam('steel',point(node,0,.46),point(node,0,height+.24),.18);
        // A narrow terminal gantry stands over the existing blue connection pad.
        for (const side of [-1,1]) {
          beam('steelLight',point(node,side*.24,.5),point(node,0,height*.66),.07);
        }
      } else {
        const levels = [0.3,height*.22,height*.43,height*.64,height*.82,height+.20];
        const radius = y => .48-(.35*Math.min(1,y/height));
        for (const sx of [-1,1]) for (const sz of [-1,1]) {
          block('concrete',node,sx*.48,.13,sz*.48,.36,.26,.36);
          beam('steel',point(node,sx*.48,.26,sz*.48),point(node,sx*.13,height+.20,sz*.13),.105);
        }
        for (let i=0;i<levels.length-1;i++) {
          const low=levels[i],high=levels[i+1],r0=radius(low),r1=radius(high);
          for (const side of [-1,1]) {
            beam('steelLight',point(node,-r0,low,side*r0),point(node,r0,low,side*r0),.065);
            beam('steelLight',point(node,side*r0,low,-r0),point(node,side*r0,low,r0),.065);
            beam('steel',point(node,-r0,low,side*r0),point(node,r1,high,side*r1),.065);
            beam('steel',point(node,r0,low,side*r0),point(node,-r1,high,side*r1),.065);
            beam('steel',point(node,side*r0,low,-r0),point(node,side*r1,high,r1),.065);
            beam('steel',point(node,side*r0,low,r0),point(node,side*r1,high,-r1),.065);
          }
        }
        block('steelLight',node,0,height+.20,0,.36,.12,.36);
      }
      // Two low phases hang from the crossarm; the central phase sits above it.
      // This avoids rendering a conductor through the steel mast itself.
      beam('steelLight',point(node,-.93,height+.32),point(node,.93,height+.32),.13);
      for (const side of [-1,1]) {
        beam('steel',point(node,0,height-.72),point(node,side*.86,height+.30),.07);
        beam('ceramic',point(node,side*.7,height+.30),point(node,side*.7,height+.04),.10);
        for (const y of [height+.08,height+.17,height+.26]) block('ceramic',node,side*.7,y,0,.19,.05,.19);
        block('connector',node,side*.7,height,0,.15,.10,.15);
      }
      beam('ceramic',point(node,0,height+.27),point(node,0,height+.60),.11);
      for (const y of [height+.35,height+.46,height+.57]) block('ceramic',node,0,y,0,.21,.055,.21);
      block('connector',node,0,height+.65,0,.16,.10,.16);
    }
    nodes.forEach(support);

    const phaseOffsets = [-.7,0,.7];
    const anchor = (node,phase) => point(node,phaseOffsets[phase],node.height+(phase===1?.65:0));
    const phasePaths = [],positions=[],normals=[],indices=[];
    let vertexOffset=0,minimumClearance=Infinity,sampleCount=0;
    for (let spanIndex=0;spanIndex<nodes.length-1;spanIndex++) {
      const from=nodes[spanIndex],to=nodes[spanIndex+1];
      const distance=Math.hypot(to.x-from.x,to.z-from.z);
      if (distance < 1e-8) throw new Error('Consecutive transmission supports cannot coincide.');
      const sag=Math.min(1.1,Math.max(0,candidate.spans?.[spanIndex]?.sag??Math.min(1.1,distance*.09)));
      const segments=Math.max(12,Math.ceil(distance*4));
      for (let phase=0;phase<3;phase++) {
        const start=anchor(from,phase),end=anchor(to,phase);
        class SaggingConductor extends THREE.Curve {
          getPoint(t,target=new THREE.Vector3()) {
            target.lerpVectors(start,end,t);
            target.y-=4*sag*t*(1-t);
            return target;
          }
        }
        const curve=new SaggingConductor(),points=[];
        for(let i=0;i<=segments;i++) {
          const p=curve.getPoint(i/segments),top=obstacleTop(p.x,p.z);
          if(top===null)throw new Error('A rendered conductor leaves the map.');
          // Measure from the bottom of the rendered cable volume, not its axis.
          const clearance=p.y-top-wireRadius;
          if(clearance<minimumClearance)minimumClearance=clearance;
          points.push({x:p.x,y:p.y,z:p.z});sampleCount++;
        }
        phasePaths.push({spanIndex,phase,from:from.id??spanIndex,to:to.id??spanIndex+1,sag,points});
        const tube=new THREE.TubeGeometry(curve,segments,wireRadius,4,false);
        const tubePositions=tube.getAttribute('position'),tubeNormals=tube.getAttribute('normal');
        for(let i=0;i<tubePositions.count;i++) {
          positions.push(tubePositions.getX(i),tubePositions.getY(i),tubePositions.getZ(i));
          normals.push(tubeNormals.getX(i),tubeNormals.getY(i),tubeNormals.getZ(i));
        }
        for(const index of tube.index.array)indices.push(index+vertexOffset);
        vertexOffset+=tubePositions.count;tube.dispose();
      }
    }
    if(minimumClearance<2-1e-6)throw new Error('Route geometry fails the demo conductor clearance check.');
    clear();
    let boxInstances=0;
    for(const [name,items] of batches) {
      const mesh=new THREE.InstancedMesh(cube,materials.get(name),items.length);
      mesh.name=`Transmission ${name}`;
      items.forEach((item,index)=>{
        transform.position.copy(item.position);transform.scale.copy(item.scale);transform.quaternion.copy(item.rotation);
        transform.updateMatrix();mesh.setMatrixAt(index,transform.matrix);
      });
      mesh.instanceMatrix.needsUpdate=true;mesh.castShadow=true;mesh.receiveShadow=true;
      mesh.computeBoundingBox();mesh.computeBoundingSphere();group.add(mesh);boxInstances+=items.length;
    }
    const wireGeometry=new THREE.BufferGeometry();
    wireGeometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    wireGeometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));wireGeometry.setIndex(indices);
    wireGeometry.computeBoundingBox();wireGeometry.computeBoundingSphere();
    const conductors=new THREE.Mesh(wireGeometry,materials.get('wire'));
    conductors.name='Three-phase conductors';conductors.castShadow=true;
    conductors.userData={phasePaths,radius:wireRadius};group.add(conductors);
    group.updateMatrixWorld(true);
    const bounds=new THREE.Box3().setFromObject(group);
    diagnostics={routeId:candidate.id??null,spanCount:nodes.length-1,
      pylonCount:nodes.filter(node=>node.kind==='tower').length,
      terminalCount:nodes.filter(node=>node.kind==='terminal').length,
      conductorCount:3,boxInstances,drawCalls:group.children.length,sampleCount,
      minimumClearance,minClearance:minimumClearance,maxY:bounds.max.y};
    group.userData={routeId:diagnostics.routeId,supportCount:nodes.length,
      nodes:nodes.map(({id,x,z,groundY,height,kind})=>({id,x,z,groundY,height,kind})),diagnostics};
    return diagnostics;
  }
  return {
    group,showRoute,clear,
    get diagnostics(){return diagnostics;},
    dispose(){if(disposed)return;clear();cube.dispose();for(const material of materials.values())material.dispose();disposed=true;},
  };
}
