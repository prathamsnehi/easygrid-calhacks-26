/** Placement rules for the fictional voxel valley; independent of rendering. */
export const FACILITY_SPECS = Object.freeze({
  substation: Object.freeze({ key: 'A', label: 'Substation', width: 12, depth: 10 }),
  datacenter: Object.freeze({ key: 'B', label: 'Data center', width: 20, depth: 14 }),
});
export const PLAN_STORAGE_KEY = 'easygrid-valley-site-plan-v1';

export function footprintAt(kind, x, z) {
  const spec = FACILITY_SPECS[kind];
  if (!spec || !Number.isFinite(x) || !Number.isFinite(z)) return null;
  const cx = Math.round(x), cz = Math.round(z);
  return { x: cx, z: cz, x0: cx-spec.width/2, x1: cx+spec.width/2,
    z0: cz-spec.depth/2, z1: cz+spec.depth/2, width: spec.width, depth: spec.depth };
}

export function validatePlacement(world, kind, x, z, placements = {}) {
  const footprint = footprintAt(kind,x,z);
  if (!footprint) return { valid:false, reason:'Choose a facility location.', codes:['invalid-coordinate'], footprint:null, parcelIds:[] };
  if (footprint.x0 < -world.width/2 || footprint.x1 > world.width/2 || footprint.z0 < -world.depth/2 || footprint.z1 > world.depth/2) {
    return {valid:false,reason:'The entire footprint must be inside the map.',codes:['outside-map'],footprint,height:1.5,parcelIds:[]};
  }
  const codes = new Set(), parcelIds = new Set();
  let height = null, blockedCells = 0;
  for (let tz=footprint.z0;tz<footprint.z1;tz++) {
    for (let tx=footprint.x0;tx<footprint.x1;tx++) {
      const tile=world.tileAt(tx+.5,tz+.5);
      if (!tile) { codes.add('outside-map'); blockedCells++; continue; }
      if (tile.parcelId) parcelIds.add(tile.parcelId);
      if (height === null) height=tile.height;
      if (tile.height !== height) codes.add('uneven');
      if (!tile.facilityAllowed) {
        blockedCells++;
        if (tile.terrain==='river' || tile.terrain==='shore') codes.add('water');
        else if (tile.terrain==='hill' || tile.height!==1.5) codes.add('uneven');
        else if (tile.terrain==='field') codes.add('agriculture');
        else codes.add('occupied');
      }
    }
  }
  for (const [otherKind,other] of Object.entries(placements)) {
    if (!other || otherKind===kind) continue;
    const area=footprintAt(otherKind,other.x,other.z);
    if (area && footprint.x0<area.x1 && footprint.x1>area.x0 && footprint.z0<area.z1 && footprint.z1>area.z0) codes.add('overlap');
  }
  const messages = {
    'outside-map':'The entire footprint must be inside the map.',
    overlap:'This footprint overlaps another facility. Move it farther away.',
    water:'The footprint includes river or riverbank tiles.',
    uneven:'The entire footprint must be on level ground.',
    agriculture:'The footprint includes farmland. Choose open land.',
    occupied:'Choose open land without roads, trees or existing structures.',
  };
  const priority=['outside-map','overlap','water','uneven','agriculture','occupied'];
  const first=priority.find(code=>codes.has(code));
  return { valid:codes.size===0, reason:first?messages[first]:'The full facility footprint fits on this open, level site.',
    codes:[...codes],footprint,height:height??1.5,blockedCells,parcelIds:[...parcelIds].sort() };
}

export function createPlacement(world, kind, x, z, placements = {}) {
  const validation=validatePlacement(world,kind,x,z,placements);
  if (!validation.valid) return null;
  const f=validation.footprint,spec=FACILITY_SPECS[kind];
  return { kind,key:spec.key,x:f.x,z:f.z,y:validation.height,footprint:f,
    parcelIds:validation.parcelIds,sourceMode:'fixture',coordinateSystem:'local-demo-grid',
    connectionPoint:{x:f.x,y:validation.height+.3,z:f.z+spec.depth/2-.5} };
}

export function serializePlan(world,placements) {
  const compact = kind => placements[kind]?{x:placements[kind].x,z:placements[kind].z}:null;
  return JSON.stringify({schemaVersion:1,fixtureVersion:world.parcelFixtureVersion,
    coordinateSystem:'local-demo-grid',substation:compact('substation'),datacenter:compact('datacenter')});
}

export function restorePlan(world,serialized) {
  const placements={substation:null,datacenter:null};
  if (!serialized) return {placements,discarded:false};
  let saved;
  try { saved=JSON.parse(serialized); } catch { return {placements,discarded:true}; }
  if (!saved || saved.schemaVersion!==1 || saved.fixtureVersion!==world.parcelFixtureVersion || saved.coordinateSystem!=='local-demo-grid') return {placements,discarded:true};
  let discarded=false;
  for (const kind of ['substation','datacenter']) {
    const item=saved[kind];
    if (!item) continue;
    if (kind==='datacenter' && !placements.substation) {discarded=true;continue;}
    if (!Number.isInteger(item.x) || !Number.isInteger(item.z)) {discarded=true;continue;}
    const placement=createPlacement(world,kind,item.x,item.z,placements);
    if (placement) placements[kind]=placement; else discarded=true;
  }
  return {placements,discarded};
}

/** Ray/voxel slab intersections pick the visible terrain, including hills and water. */
export function pickTerrain(world,ray) {
  let nearest=Infinity,hit=null;
  const origin=ray.origin,direction=ray.direction;
  for (const tile of world.tiles) {
    const upper=tile.terrain==='river'?.79:tile.height;
    let near=0,far=nearest;
    for (const [axis,min,max] of [['x',tile.x-.5,tile.x+.5],['y',-3.9,upper],['z',tile.z-.5,tile.z+.5]]) {
      const o=origin[axis],d=direction[axis];
      if (Math.abs(d)<1e-10) {if(o<min || o>max){far=-1;break;}continue;}
      let a=(min-o)/d,b=(max-o)/d;
      if(a>b)[a,b]=[b,a];
      near=Math.max(near,a);far=Math.min(far,b);
      if(near>far)break;
    }
    if (near<=far && far>=0 && near<nearest) {
      nearest=near;
      hit={x:origin.x+direction.x*near,y:origin.y+direction.y*near,z:origin.z+direction.z*near,tile};
    }
  }
  return hit;
}
