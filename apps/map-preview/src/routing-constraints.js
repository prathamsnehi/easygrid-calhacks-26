// Geometry-only routing restrictions. The host is responsible for confirming
// owner intent and binding these restrictions to the current session/route.
const EPS=1e-7;
const MAX_VERTICES=256,MAX_ZONES=64;
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const same=(a,b)=>Math.abs(a[0]-b[0])<=EPS&&Math.abs(a[1]-b[1])<=EPS;
const onSegment=(p,a,b)=>Math.abs(cross(a,b,p))<=EPS&&p[0]>=Math.min(a[0],b[0])-EPS&&p[0]<=Math.max(a[0],b[0])+EPS&&p[1]>=Math.min(a[1],b[1])-EPS&&p[1]<=Math.max(a[1],b[1])+EPS;

function segmentsTouch(a,b,c,d){
  const abC=cross(a,b,c),abD=cross(a,b,d),cdA=cross(c,d,a),cdB=cross(c,d,b);
  if(((abC>EPS&&abD<-EPS)||(abC<-EPS&&abD>EPS))&&((cdA>EPS&&cdB<-EPS)||(cdA<-EPS&&cdB>EPS)))return true;
  return onSegment(c,a,b)||onSegment(d,a,b)||onSegment(a,c,d)||onSegment(b,c,d);
}

function insideOrBoundary(point,ring){
  let inside=false;
  for(let i=1;i<ring.length;i++){
    const a=ring[i-1],b=ring[i];
    if(onSegment(point,a,b))return true;
    if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside;
}

function bounds(ring){
  return {x0:Math.min(...ring.map(p=>p[0])),x1:Math.max(...ring.map(p=>p[0])),z0:Math.min(...ring.map(p=>p[1])),z1:Math.max(...ring.map(p=>p[1]))};
}
const disjoint=(a,b)=>a.x1<b.x0-EPS||a.x0>b.x1+EPS||a.z1<b.z0-EPS||a.z0>b.z1+EPS;

function polygonsTouch(a,b){
  if(disjoint(bounds(a),bounds(b)))return false;
  for(let i=1;i<a.length;i++)for(let j=1;j<b.length;j++)if(segmentsTouch(a[i-1],a[i],b[j-1],b[j]))return true;
  return insideOrBoundary(a[0],b)||insideOrBoundary(b[0],a);
}

function validateRing(input){
  if(!Array.isArray(input)||input.length<4||input.length>MAX_VERTICES||input.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>!Number.isFinite(v))))throw new Error('Exclusion zones require a finite, closed local polygon.');
  const ring=input.map(p=>[...p]),last=ring.length-1;
  if(!same(ring[0],ring[last]))throw new Error('Exclusion polygon must be closed.');
  ring[last]=[...ring[0]];
  let area=0;
  for(let i=0;i<last;i++){
    if(same(ring[i],ring[i+1]))throw new Error('Exclusion polygon has an empty edge.');
    area+=ring[i][0]*ring[i+1][1]-ring[i+1][0]*ring[i][1];
    const previous=ring[(i+last-1)%last],current=ring[i],next=ring[i+1];
    if(Math.abs(cross(previous,current,next))<=EPS&&
      (previous[0]-current[0])*(next[0]-current[0])+(previous[1]-current[1])*(next[1]-current[1])>EPS)throw new Error('Exclusion polygon cannot backtrack.');
    for(let j=i+1;j<last;j++){
      if(j===i+1||(i===0&&j===last-1))continue;
      if(segmentsTouch(ring[i],ring[i+1],ring[j],ring[j+1]))throw new Error('Exclusion polygon must not intersect itself.');
    }
  }
  if(Math.abs(area)<=EPS)throw new Error('Exclusion polygon must have positive area.');
  return ring;
}

// A concave parcel can contain both endpoints while the segment between them
// leaves it. Split at every boundary crossing and check each open interval.
function segmentInside(a,b,parcelRing){
  const dx=b[0]-a[0],dz=b[1]-a[1],lengthSquared=dx*dx+dz*dz,cuts=[0,1];
  for(let i=1;i<parcelRing.length;i++){
    const c=parcelRing[i-1],d=parcelRing[i],ex=d[0]-c[0],ez=d[1]-c[1];
    const denominator=dx*ez-dz*ex;
    if(Math.abs(denominator)>EPS){
      const t=((c[0]-a[0])*ez-(c[1]-a[1])*ex)/denominator;
      const u=((c[0]-a[0])*dz-(c[1]-a[1])*dx)/denominator;
      if(t>0&&t<1&&u>=-EPS&&u<=1+EPS)cuts.push(t);
    }else if(Math.abs(cross(a,b,c))<=EPS){
      for(const p of [c,d]){
        const t=((p[0]-a[0])*dx+(p[1]-a[1])*dz)/lengthSquared;
        if(t>0&&t<1)cuts.push(t);
      }
    }
  }
  cuts.sort((x,y)=>x-y);
  for(let i=1;i<cuts.length;i++){
    const t=(cuts[i-1]+cuts[i])/2;
    if(!insideOrBoundary([a[0]+dx*t,a[1]+dz*t],parcelRing))return false;
  }
  return true;
}

/** Validates before search and returns detached, serializable restrictions. */
export function normalizeRoutingConstraints(world,options={}){
  function ids(value,label){
    if(value===undefined)return [];
    if(!Array.isArray(value)||value.length>1000||value.some(id=>typeof id!=='string'||!world.parcelById?.has(id))||new Set(value).size!==value.length)throw new Error(`${label} must contain unique known parcel IDs.`);
    return [...value].sort();
  }
  const blockedParcelIds=ids(options.blockedParcelIds,'Blocked parcels');
  const blockedTowerParcelIds=ids(options.blockedTowerParcelIds,'Blocked tower parcels');
  const zones=options.exclusionZones===undefined?[]:options.exclusionZones;
  if(!Array.isArray(zones)||zones.length>MAX_ZONES)throw new Error('Exclusion zones must be a bounded array.');
  const exclusionZones=zones.map(zone=>{
    if(!zone||Object.keys(zone).some(key=>!['parcelId','ring'].includes(key))||typeof zone.parcelId!=='string'||!world.parcelById?.has(zone.parcelId))throw new Error('Exclusion zone must name a known parcel.');
    const ring=validateRing(zone.ring),parcel=world.parcelById.get(zone.parcelId),geometry=parcel.geometry;
    if(!geometry||geometry.coordinateSystem!=='local-demo-grid'||geometry.type!=='Polygon'||geometry.rings?.length!==1)throw new Error('Exclusion zone requires a supported local parcel boundary.');
    const parcelRing=geometry.rings[0];
    if(ring.some(([x,z])=>Math.abs(x)>world.width/2+EPS||Math.abs(z)>world.depth/2+EPS)||
      ring.some(p=>!insideOrBoundary(p,parcelRing))||ring.slice(1).some((p,i)=>!segmentInside(ring[i],p,parcelRing)))throw new Error('Exclusion polygon must stay inside its named parcel and map.');
    return {parcelId:zone.parcelId,ring};
  });
  return {blockedParcelIds,blockedTowerParcelIds,exclusionZones};
}

const rectRing=rect=>[[rect.x0,rect.z0],[rect.x1,rect.z0],[rect.x1,rect.z1],[rect.x0,rect.z1],[rect.x0,rect.z0]];

export function foundationIntersectsExclusion(rect,zones=[]){
  const ring=rectRing(rect);
  return zones.some(zone=>polygonsTouch(ring,zone.ring));
}

function convexHull(points){
  points.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const lower=[],upper=[];
  for(const p of points){while(lower.length>=2&&cross(lower.at(-2),lower.at(-1),p)<=EPS)lower.pop();lower.push(p);}
  for(const p of [...points].reverse()){while(upper.length>=2&&cross(upper.at(-2),upper.at(-1),p)<=EPS)upper.pop();upper.push(p);}
  const ring=lower.slice(0,-1).concat(upper.slice(0,-1));ring.push([...ring[0]]);return ring;
}

/** The swept square matches the router's conservative x/z corridor padding. */
export function spanIntersectsExclusion(a,b,halfWidth,zones=[]){
  if(!zones.length)return false;
  const corridor=convexHull([a,b].flatMap(p=>[-halfWidth,halfWidth].flatMap(dx=>[-halfWidth,halfWidth].map(dz=>[p.x+dx,p.z+dz]))));
  return zones.some(zone=>polygonsTouch(corridor,zone.ring));
}
