/** Synthetic property fixtures. These coordinates and prices are demo data only. */
export const PARCEL_FIXTURE_VERSION = 'california-valley-parcels-v1';

const PARCEL_OWNER_ALIASES = [
  'Elena Brooks', 'Mateo Ruiz', 'Nora Bennett', 'Daniel Park',
  'Sofia Hayes', 'Owen Chen', 'Maya Foster', 'Lucas Rivera',
  'Grace Sullivan', 'Ethan Kim', 'Isabel Morgan', 'Noah Patel',
  'Leah Collins', 'Adrian Flores', 'Claire Jensen', 'Julian Reed',
  'Amelia Shaw', 'Leo Navarro', 'Hannah Ellis', 'Miles Tan',
  'Audrey Lane', 'Gabriel Ross', 'Stella Warren', 'Caleb Stone',
];

function parcelCellKey(x, z) { return `${x},${z}`; }

// Trace actual one-tile cell edges, preserving the valley's clipped corners.
// These rings are local x/z values, deliberately not GeoJSON/WGS84.
function parcelRing(tiles) {
  const cells = new Set(tiles.map(t => parcelCellKey(Math.floor(t.x), Math.floor(t.z))));
  const edges = new Map();
  function edge(x0, z0, x1, z1) { edges.set(parcelCellKey(x0,z0), [x1,z1]); }
  for (const tile of tiles) {
    const x = Math.floor(tile.x), z = Math.floor(tile.z);
    if (!cells.has(parcelCellKey(x,z-1))) edge(x,z,x+1,z);
    if (!cells.has(parcelCellKey(x+1,z))) edge(x+1,z,x+1,z+1);
    if (!cells.has(parcelCellKey(x,z+1))) edge(x+1,z+1,x,z+1);
    if (!cells.has(parcelCellKey(x-1,z))) edge(x,z+1,x,z);
  }
  const first = [...edges.keys()].sort((a,b) => {
    const [ax,az] = a.split(',').map(Number), [bx,bz] = b.split(',').map(Number);
    return ax-bx || az-bz;
  })[0];
  const ring = [first.split(',').map(Number)];
  let cursor = first;
  for (let i = 0; i < edges.size; i++) {
    const next = edges.get(cursor);
    if (!next) throw new Error('Parcel boundary is not closed');
    ring.push(next);
    cursor = parcelCellKey(...next);
    if (cursor === first) return ring;
  }
  throw new Error('Parcel boundary did not close');
}

function demoTerrainRouting(tile) {
  const reasons = [];
  const structure = tile.occupiedBy.some(kind => ['farmstead','wind-pump','fence','hay-bales'].includes(kind));
  const transport = tile.terrain === 'road' || tile.occupiedBy.includes('bridge');
  const water = tile.terrain === 'river' || tile.terrain === 'shore';
  const trees = tile.occupiedBy.some(kind => kind === 'tree' || kind === 'orchard-tree');
  const uneven = tile.height !== 1.5 || tile.terrain === 'hill';
  if (structure) reasons.push('existing-structure');
  if (transport) reasons.push('road-crossing');
  if (water) reasons.push('water-crossing');
  if (tile.fieldId) reasons.push('agricultural-impact');
  if (trees) reasons.push('vegetation-clearing');
  if (uneven && !water) reasons.push('uneven-ground');
  if (tile.occupiedBy.includes('rock')) reasons.push('rock');
  return {
    sourceMode: 'fixture',
    // Physical demo screening only. Owner consent and approvals remain unknown.
    linePassage: structure ? 'blocked' : reasons.length ? 'review' : 'possible',
    towerPlacement: structure || transport || water ? 'blocked' : reasons.length ? 'review' : 'possible',
    reasons,
  };
}

/** Assign all rendered cells exactly once and return reusable parcel/owner records. */
export function createParcelFixtures({ tiles, width, depth }) {
  if (width !== 120 || depth !== 96) throw new Error('Parcel fixture expects the 120 × 96 valley');
  const columns = 6, rows = 4, blockWidth = width / columns, blockDepth = depth / rows;
  const owners = PARCEL_OWNER_ALIASES.map((alias,index) => {
    const suffix = String(index+1).padStart(3,'0');
    return {
      id: `O${suffix}`, alias, synthetic: true, sourceMode: 'fixture',
      contactRef: `demo-owner-O${suffix}`,
      email: `${alias.toLowerCase().replaceAll(' ','.')}@example.com`,
      phoneDisplay: `555-${String(101+index).padStart(4,'0')} · demo`,
      dialTarget: null,
      contactConsent: 'unknown',
    };
  });
  const groups = Array.from({length:columns*rows},() => []);
  for (const tile of tiles) {
    const column = Math.floor((tile.x+width/2)/blockWidth);
    const row = Math.floor((tile.z+depth/2)/blockDepth);
    if (column < 0 || column >= columns || row < 0 || row >= rows) throw new Error('Tile outside parcel fixture');
    const index = row*columns+column;
    tile.parcelId = `L${String(index+1).padStart(3,'0')}`;
    tile.facilityAllowed = tile.buildable;
    tile.routingPolicy = demoTerrainRouting(tile);
    groups[index].push(tile);
  }
  const parcels = groups.map((cells,index) => {
    const column=index%columns,row=Math.floor(index/columns),owner=owners[index];
    const terrainCounts = {};
    for (const tile of cells) terrainCounts[tile.terrain]=(terrainCounts[tile.terrain]??0)+1;
    const terrainOrder=Object.entries(terrainCounts).sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]));
    const fieldIds=[...new Set(cells.map(t=>t.fieldId).filter(Boolean))].sort();
    const dominantTerrain=terrainOrder[0][0];
    const landUse=fieldIds.length ? 'mixed-agriculture' : dominantTerrain==='hill' ? 'hillside' :
      dominantTerrain==='river' || dominantTerrain==='shore' ? 'river-corridor' : 'open-land';
    const upfrontPerTileCents=1800+(index%6)*350+(fieldIds.length?1200:0);
    const initialOfferCents=50000+cells.length*upfrontPerTileCents;
    return {
      id:`L${String(index+1).padStart(3,'0')}`, name:`Valley parcel ${String(index+1).padStart(2,'0')}`,
      synthetic:true,sourceMode:'fixture',fixtureVersion:PARCEL_FIXTURE_VERSION,
      coordinateSystem:'local-demo-grid', ownerId:owner.id,ownerAlias:owner.alias,contactRef:owner.contactRef,
      landUse, dominantTerrain, terrainCounts,fieldIds,
      tileCount:cells.length,areaTiles:cells.length,
      bounds:{x0:-width/2+column*blockWidth,x1:-width/2+(column+1)*blockWidth,
        z0:-depth/2+row*blockDepth,z1:-depth/2+(row+1)*blockDepth},
      geometry:{coordinateSystem:'local-demo-grid',type:'Polygon',rings:[parcelRing(cells)]},
      buildableTileCount:cells.filter(t=>t.facilityAllowed).length,
      accessConsent:'unknown',negotiationStatus:'pending',
      compensation:{sourceMode:'fixture',currency:'USD',basis:'demo-grid-tile',
        upfrontPerTileCents,monthlyPerTileCents:25+(index%5)*10,
        initialOfferCents,offerCapCents:Math.ceil(initialOfferCents*1.4),
        note:'Fictional whole-parcel starting offer; no appraisal or route-specific estimate.'},
    };
  });
  return {
    parcels,owners,
    parcelById:new Map(parcels.map(p=>[p.id,p])),
    ownerById:new Map(owners.map(o=>[o.id,o])),
    parcelFixtureVersion:PARCEL_FIXTURE_VERSION,
  };
}
