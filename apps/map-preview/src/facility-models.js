/** Compact, entirely geometric demo facilities. Coordinates are local map units. */
export function createFacilityModel(THREE, kind, { preview = false } = {}) {
  if (!['substation', 'datacenter'].includes(kind)) throw new Error(`Unknown facility kind: ${kind}`);
  const footprint = kind === 'substation' ? { width: 12, depth: 10 } : { width: 20, depth: 14 };
  const connectionOffset = { x: 0, y: 0.3, z: footprint.depth / 2 - 0.5 };
  const group = new THREE.Group();
  group.name = `${preview ? 'Preview ' : ''}${kind}`;
  group.userData = { kind, preview, footprint: { ...footprint }, connectionOffset: { ...connectionOffset } };
  const batches = new Map();
  const materials = [];
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const transform = new THREE.Object3D();
  const palette = {
    pad: 0xb7b7a4, pale: 0xe2deca, wall: 0xd2d1bf, dark: 0x47565a,
    steel: 0x8c9c98, steelLight: 0xb3beb3, blue: 0x426bc1, blueLight: 0x6e94cf,
    window: 0x496b78, ceramic: 0xd4d4b9, copper: 0xb19a6d, asphalt: 0x8e948a,
  };
  function box(color, x, y, z, width, height, depth) {
    const key = preview ? 'ghost' : color;
    if (!batches.has(key)) batches.set(key, { color, boxes: [] });
    batches.get(key).boxes.push({ x, y, z, width, height, depth });
  }

  if (kind === 'substation') {
    box(palette.pad, 0, 0.12, 0, 11.7, 0.24, 9.7);
    // Two transformers with segmented cooling fins and ceramic bushings.
    for (const x of [-2.15, 2.15]) {
      box(palette.steelLight, x, 0.37, -0.2, 2.9, 0.26, 3.1);
      box(palette.steel, x, 1.25, -0.2, 1.8, 1.5, 2.15);
      box(palette.dark, x, 2.03, -0.2, 1.95, 0.16, 2.3);
      box(palette.blue, x, 1.1, 0.9, 1.2, 0.7, 0.18);
      for (const side of [-1, 1]) {
        for (let i = 0; i < 6; i++) {
          box(i % 2 ? palette.steelLight : palette.steel, x + side * 1.09, 1.22,
            -1.05 + i * 0.34, 0.32, 1.35, 0.2);
        }
      }
      for (const z of [-0.85, -0.2, 0.45]) {
        box(palette.dark, x, 2.28, z, 0.22, 0.38, 0.22);
        for (let ring = 0; ring < 3; ring++) {
          box(palette.ceramic, x, 2.38 + ring * 0.21, z, 0.44 - ring * 0.06, 0.11, 0.44 - ring * 0.06);
        }
        box(palette.copper, x, 2.91, z, 0.15, 0.22, 0.15);
      }
    }
    // Squared steel gantries frame the open electrical yard.
    for (const z of [-2.8, 2.25]) {
      for (const x of [-4.6, 4.6]) {
        box(palette.steelLight, x, 0.4, z, 0.75, 0.32, 0.75);
        box(palette.steel, x, 2.1, z, 0.26, 3.7, 0.26);
        box(palette.steelLight, x, 2.1, z + 0.13, 0.1, 3.7, 0.1);
      }
      box(palette.steel, 0, 3.9, z, 9.46, 0.24, 0.32);
      box(palette.steelLight, 0, 4.13, z, 9.46, 0.12, 0.2);
      for (const x of [-2.8, 0, 2.8]) {
        box(palette.ceramic, x, 3.5, z, 0.26, 0.58, 0.26);
      }
    }
    for (const x of [-2.8, 0, 2.8]) box(palette.copper, x, 3.2, -0.27, 0.12, 0.12, 5.05);
    // A small control cabinet leaves the equipment yard visibly open.
    box(palette.wall, -3.5, 0.95, -3.8, 1.5, 1.4, 1.1);
    box(palette.blue, -3.5, 1.7, -3.8, 1.65, 0.12, 1.25);
    box(palette.window, -3.5, 1.0, -3.22, 0.85, 0.9, 0.08);
    // Low perimeter fence, with a clear gate at the front connection pad.
    for (let x = -5.5; x <= 5.5; x += 1.1) {
      box(palette.steel, x, 0.9, -4.5, 0.1, 1.3, 0.1);
      if (Math.abs(x) > 1.2) box(palette.steel, x, 0.9, 4.5, 0.1, 1.3, 0.1);
    }
    for (const x of [-5.5, 5.5]) {
      for (let z = -3.4; z < 4.5; z += 1.1) box(palette.steel, x, 0.9, z, 0.1, 1.3, 0.1);
      for (const y of [0.65, 1.38]) box(palette.steelLight, x, y, 0, 0.08, 0.08, 9);
    }
    for (const y of [0.65, 1.38]) {
      box(palette.steelLight, 0, y, -4.5, 11, 0.08, 0.08);
      for (const x of [-3.35, 3.35]) box(palette.steelLight, x, y, 4.5, 4.3, 0.08, 0.08);
    }
    box(palette.blue, 0, 0.3, 4.5, 1.4, 0.12, 0.75);
    box(palette.blueLight, 0, 0.4, 4.5, 0.65, 0.08, 0.4);
  } else {
    box(palette.pad, 0, 0.13, 0, 19.7, 0.26, 13.7);
    box(palette.asphalt, 0, 0.28, 5.65, 17.6, 0.06, 1.65);
    // A low, broad building with a stepped parapet and a blue service entrance.
    box(palette.wall, 0, 1.93, -0.55, 17.2, 3.3, 10.2);
    box(palette.pale, 0, 3.66, -0.55, 17.7, 0.2, 10.7);
    box(palette.dark, 0, 3.79, -0.55, 16.9, 0.12, 9.9);
    for (const x of [-8.5, 8.5]) box(palette.pale, x, 1.95, -0.55, 0.23, 3.35, 10.2);
    for (let x = -6.8; x <= 6.8; x += 3.4) {
      box(palette.pale, x, 1.93, 4.58, 0.16, 3.3, 0.13);
      if (Math.abs(x) > 1) {
        box(palette.dark, x - 0.65, 0.98, 4.62, 1.55, 1.4, 0.14);
        for (let row = 0; row < 4; row++) box(palette.steel, x - 0.65, 0.5 + row * 0.3, 4.72, 1.35, 0.08, 0.06);
      }
    }
    box(palette.blue, 0, 1.65, 4.75, 3.5, 2.7, 0.5);
    box(palette.window, 0, 1.35, 5.04, 2.2, 2.1, 0.12);
    box(palette.steelLight, 0, 1.35, 5.12, 0.1, 2.1, 0.08);
    box(palette.blueLight, 0, 3.0, 5.15, 4.0, 0.18, 1.4);
    // Six roof cooling units, each with four dark voxel fans.
    for (const x of [-5.4, 0, 5.4]) {
      for (const z of [-3.1, 1.35]) {
        box(palette.steelLight, x, 4.22, z, 3.35, 0.75, 2.35);
        box(palette.pale, x, 4.65, z, 3.5, 0.12, 2.5);
        for (const dx of [-0.84, 0.84]) for (const dz of [-0.6, 0.6]) {
          box(palette.dark, x + dx, 4.75, z + dz, 1.12, 0.1, 0.8);
          box(palette.steel, x + dx, 4.82, z + dz, 0.15, 0.08, 0.68);
        }
        for (let slat = 0; slat < 4; slat++) box(palette.dark, x - 1.1 + slat * 0.72, 4.22, z + 1.2, 0.42, 0.44, 0.08);
      }
    }
    // A rear utility strip and front service bollards complete the silhouette.
    for (const x of [-5.7, -2.8, 2.8, 5.7]) {
      box(palette.steel, x, 0.9, -6.2, 1.9, 1.25, 0.95);
      box(palette.blue, x, 1.57, -6.2, 2.0, 0.1, 1.05);
    }
    for (const x of [-2.5, 2.5]) box(palette.blue, x, 0.7, 5.8, 0.2, 0.8, 0.2);
    box(palette.blue, 0, 0.32, 6.5, 1.8, 0.12, 0.7);
    box(palette.blueLight, 0, 0.42, 6.5, 0.8, 0.08, 0.36);
  }

  let boxCount = 0;
  for (const batch of batches.values()) {
    const material = preview
      ? new THREE.MeshBasicMaterial({ color: 0x49bf86, transparent: true, opacity: 0.38, depthWrite: false })
      : new THREE.MeshLambertMaterial({ color: batch.color, flatShading: true });
    materials.push(material);
    const mesh = new THREE.InstancedMesh(cube, material, batch.boxes.length);
    mesh.name = `${kind} ${preview ? 'ghost' : batch.color.toString(16)}`;
    for (const [index, item] of batch.boxes.entries()) {
      transform.position.set(item.x, item.y, item.z);
      transform.scale.set(item.width, item.height, item.depth);
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = !preview;
    mesh.receiveShadow = !preview;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    group.add(mesh);
    boxCount += batch.boxes.length;
  }
  group.userData.boxCount = boxCount;
  return {
    group, footprint, connectionOffset,
    setPreviewState(valid) {
      if (preview) materials.forEach(material => material.color.setHex(valid ? 0x49bf86 : 0xe75e59));
    },
    dispose() {
      group.children.forEach(mesh => mesh.dispose());
      cube.dispose(); materials.forEach(material => material.dispose()); group.clear();
    },
  };
}
