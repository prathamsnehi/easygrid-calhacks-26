import { createParcelFixtures } from './parcels.js';

/** Fictional California valley. One tile model drives the scene and future routing. */
export const WORLD_WIDTH = 120;
export const WORLD_DEPTH = 96;

export function riverCenter(z) {
  return 4 + 7 * Math.sin(z * 0.06) + 1.65 * Math.sin(z * 0.16);
}

function noise(x, z, salt = 0) {
  const n = Math.sin(x * 127.1 + z * 311.7 + salt * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

function contains(bounds, x, z, padding = 0) {
  return x >= bounds.x0 - padding && x < bounds.x1 + padding &&
    z >= bounds.z0 - padding && z < bounds.z1 + padding;
}

export function createWorld() {
  // Unmarked meadows reserve room for a future 20 × 14 facility and a one-tile border.
  const clearings = [];
  for (const [bank, x0] of [['west', -54], ['east', 32]]) {
    for (const [index, z0] of [-25, 9, 27].entries()) {
      clearings.push({
        id: `${bank}-${index + 1}`, bank, x0, x1: x0 + 22, z0, z1: z0 + 16,
        height: 1.5,
        interior: { x0: x0 + 1, x1: x0 + 21, z0: z0 + 1, z1: z0 + 15 },
      });
    }
  }
  const isReserved = (x, z, padding = 0) => clearings.some(c => contains(c, x, z, padding));
  const fields = [
    { id: 'P1', crop: 'vineyard', x0: -28, x1: -12, z0: -25, z1: -11 },
    { id: 'P2', crop: 'wheat', x0: -28, x1: -12, z0: 8, z1: 22 },
    { id: 'P3', crop: 'vegetables', x0: -28, x1: -12, z0: 27, z1: 41 },
    { id: 'P4', crop: 'wheat', x0: 13, x1: 29, z0: -25, z1: -11 },
    { id: 'P5', crop: 'orchard', x0: 13, x1: 29, z0: 8, z1: 22 },
    { id: 'P6', crop: 'vineyard', x0: 13, x1: 29, z0: 27, z1: 41 },
  ];
  const farmyard = { x0: -25, x1: -15, z0: -7, z1: 0 };
  const bridgeX = riverCenter(4.5);
  const fixedOccupancy = [
    { ...farmyard, kind: 'farmstead' },
    { x0: bridgeX - 5.6, x1: bridgeX + 5.6, z0: 3, z1: 6, kind: 'bridge' },
    { x0: -14, x1: -11, z0: -3, z1: -1, kind: 'wind-pump' },
    { x0: -28, x1: -13, z0: 6, z1: 7, kind: 'fence' },
    { x0: -25, x1: -22, z0: 17, z1: 20, kind: 'hay-bales' },
  ];
  const tiles = [];
  const lookup = new Map();
  for (let iz = 0; iz < WORLD_DEPTH; iz++) {
    for (let ix = 0; ix < WORLD_WIDTH; ix++) {
      const x = ix - WORLD_WIDTH / 2 + 0.5;
      const z = iz - WORLD_DEPTH / 2 + 0.5;
      // The clipped corners retain the cutaway-diorama silhouette.
      if (Math.abs(x) + Math.abs(z) > 99) continue;
      const riverDistance = Math.abs(x - riverCenter(z));
      const water = riverDistance < 2.7 + 0.35 * Math.sin(z * 0.25);
      const shore = !water && riverDistance < 4;
      const inFarmyard = contains(farmyard, x, z);
      const field = fields.find(f => contains(f, x, z));
      const road = !water && (Math.abs(z - 4.5) < 1 || (Math.abs(x + 20.5) < 1 && z > -4 && z < 5));
      const hillA = 12 * Math.exp(-((x + 36) ** 2 / 270 + (z + 39) ** 2 / 85));
      const hillB = 10 * Math.exp(-((x - 35) ** 2 / 240 + (z + 39) ** 2 / 100));
      const hillC = 5 * Math.exp(-((x + 11) ** 2 / 80 + (z + 44) ** 2 / 40));
      const backEdge = Math.max(0, Math.min(1, (-z - 27) / 7));
      const hills = (hillA + hillB + hillC) * backEdge * Math.max(0, Math.min(1, (riverDistance - 4) / 9));
      let height = Math.round((1.5 + hills) * 2) / 2;
      if (field || road || inFarmyard || isReserved(x, z, 2)) height = 1.5;
      if (shore) height = 1;
      if (water) height = 0.2;
      const terrain = water ? 'river' : shore ? 'shore' : road ? 'road' :
        inFarmyard ? 'farmyard' : field ? 'field' : height > 2 ? 'hill' : 'meadow';
      const variation = noise(ix, iz);
      const clearing = clearings.find(c => contains(c, x, z));
      const grass = terrain === 'meadow' && !isReserved(x, z, 2) &&
        variation > 0.982 && Math.abs(z - 4.5) > 3;
      const occupiedBy = fixedOccupancy.filter(f => contains(f, x, z)).map(f => f.kind);
      if (road) occupiedBy.push('road');
      if (terrain === 'field') occupiedBy.push('agriculture');
      if (grass) occupiedBy.push('grass');
      const tile = {
        ix, iz, x, z, height, terrain, variation, grass,
        parcelId: null,
        fieldId: terrain === 'field' ? field.id : null,
        crop: terrain === 'field' ? field.crop : null,
        clearingId: clearing?.id ?? null,
        occupiedBy, occupied: occupiedBy.length > 0, buildable: false,
      };
      tiles.push(tile);
      lookup.set(`${Math.floor(x)},${Math.floor(z)}`, tile);
    }
  }
  const tileAt = (x, z) => lookup.get(`${Math.floor(x)},${Math.floor(z)}`);
  const trees = [];
  function addTree(x, z, scale, kind = 'oak', variety = 0, orchard = false) {
    const tile = tileAt(x, z);
    if (!tile || ['river', 'shore', 'road', 'farmyard'].includes(tile.terrain) ||
      (!orchard && tile.terrain === 'field') || isReserved(x, z, 2)) return;
    trees.push({ x, z, scale, kind, variety, orchard });
  }
  [
    [-49,-38,1],[-44,-31,0.85],[-33,-43,1],[-25,-36,0.9],[-12,-35,0.85],[-6,-29,1.1],
    [18,-36,0.9],[27,-43,0.85],[42,-35,1],[52,-31,0.95],
    [-57,-21,0.8],[-57,-12,0.9],[-57,15,0.85],[-57,33,0.8],[-57,41,0.75],
    [57,-19,0.85],[57,-11,0.85],[57,14,0.8],[57,34,0.9],[57,41,0.75],
    [-47,-4,0.95],[-36,-3,0.8],[-30,1,0.85],[-9,-4,0.85],[-8,1,0.85],
    [20,-3,0.9],[29,0,0.8],[43,-3,0.85],[52,0,0.8],
    [-30,45,0.85],[-10,25,0.8],[-7,40,0.85],[25,45,0.8],[9,-12,0.7],
  ].forEach(([x,z,s],i) => addTree(x,z,s,'oak',i));
  [[-45,-43],[-39,-44],[-29,-39],[-20,-42],[-14,-31],[20,-42],[25,-37],[40,-44],[47,-39],[9,-8],[17,1]]
    .forEach(([x,z],i) => addTree(x,z,0.8+(i%3)*0.1,'cypress',i));
  const orchard = fields.find(f => f.crop === 'orchard');
  for (let x = orchard.x0 + 1.7; x < orchard.x1 - 1; x += 3.2) {
    for (let z = orchard.z0 + 1; z < orchard.z1 - 1; z += 3.2) {
      if (tileAt(x,z)?.crop === 'orchard') addTree(x,z,0.6,'oak',Math.floor(x+z),true);
    }
  }
  const rocks = [
    [-37,-38,2],[-31,-40,1.5],[35,-39,1.8],[43,-41,1.2],[-51,-31,0.8],[53,-36,1],
    [-10,-28,1], [24,-6,0.8],
  ].filter(([x,z]) => !isReserved(x,z,2)).map(([x,z,scale]) => ({x,z,scale}));
  // Occupancy includes the overhead tree crowns, not just their narrow trunks.
  for (const tree of trees) {
    const radius = (tree.kind === 'oak' ? 1.3 : 0.8) * tree.scale;
    for (const tile of tiles) {
      if (Math.abs(tile.x-tree.x) < radius+0.5 && Math.abs(tile.z-tree.z) < radius+0.5)
        tile.occupiedBy.push(tree.orchard ? 'orchard-tree' : 'tree');
    }
  }
  for (const rock of rocks) {
    for (const tile of tiles) {
      if (Math.abs(tile.x-rock.x) < rock.scale/2+0.5 && Math.abs(tile.z-rock.z) < rock.scale/2+0.5)
        tile.occupiedBy.push('rock');
    }
  }
  for (const tile of tiles) {
    tile.occupied = tile.occupiedBy.length > 0;
    tile.buildable = tile.terrain === 'meadow' && tile.height === 1.5 && !tile.occupied;
  }
  const parcelFixtures = createParcelFixtures({ tiles, width: WORLD_WIDTH, depth: WORLD_DEPTH });
  return {
    width: WORLD_WIDTH, depth: WORLD_DEPTH, tileSize: 1, fields, tiles, clearings,
    farmyard, trees, rocks, sourceMode: 'fixture', tileAt, isReserved, noise,
    ...parcelFixtures,
  };
}
