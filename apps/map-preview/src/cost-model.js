/** Source-based equipment allowances for a fictional 230 kV single-circuit demo. */
export const DEMO_METERS_PER_TILE=25;
export const DEMO_BUDGET_CENTS=500000000;

// MTEP24 table values are USD per 1,000 ft. Three phase conductors, one OPGW
// and one shield wire are already included; do not charge each rendered wire again.
const lineUsdPer1000Feet=3*(1807+2477+277)+(2819+4229)+(623+936);
export const DEMO_COST_MODEL=Object.freeze({
  id:'miso-mtep24-230kv-single-circuit-demo-v1',currency:'USD',
  dollarBasis:'MISO MTEP24 reported table values',voltageKv:230,circuitCount:1,
  horizontalMetersPerTile:DEMO_METERS_PER_TILE,verticalScale:'stylized-grid-units',
  source:Object.freeze({
    title:'MISO Transmission Cost Estimation Guide for MTEP24',
    url:'https://cdn.misoenergy.org/20240501%20PSC%20Item%2004%20MISO%20Transmission%20Cost%20Estimation%20Guide%20for%20MTEP24632680.pdf',
    structures:'Table 2.2-2, pages 11–12',conductor:'Table 2.2-11, page 19',
    groundWires:'Table 2.2-14, page 21',
  }),
  phaseConductorCount:3,opticalGroundWireCount:1,shieldWireCount:1,
  lineUsdPer1000Feet,lineSagAndWastePercent:4,
  linePerTileCents:Math.round(lineUsdPer1000Feet*1.04/304.8*DEMO_METERS_PER_TILE*100),
  towerCents:12839300,terminalCents:16174800,
  structureConvention:'Uniform installed running-angle allowance for interior towers; non-angle dead-end allowance for each facility terminal.',
  engineeringPercent:10,contingencyPercent:30,
  allowanceConvention:'Demo allowances: engineering/PM is 10% of construction base; contingency is 30% of base plus engineering. Round each span/node and the combined terminal allowance to cents.',
  limitations:'Reported MTEP24 values are not escalated to 2026 or a project quote. Terrain/crossing premiums and land/rent rates remain fictional. Facility construction, transformers and switchgear are excluded.',
});

export const CONSTRUCTION_BASE_COST_KEYS=Object.freeze([
  'lineCents','towerCents','terminalCents','terrainCents','waterCents',
  'agricultureCents','vegetationCents','roadCents',
]);
export const COST_KEYS=Object.freeze([
  ...CONSTRUCTION_BASE_COST_KEYS,'compensationCents','rentCents','engineeringCents','contingencyCents',
]);
export function emptyRouteCosts(){return Object.fromEntries(COST_KEYS.map(key=>[key,0]));}
function safeCents(value){
  if(!Number.isSafeInteger(value)||value<0)throw new Error('Construction costs must be nonnegative safe-integer cents.');
  return value;
}
function roundedPercent(cents,percent){
  return safeCents(Number((BigInt(cents)*BigInt(percent)+50n)/100n));
}

/** Recompute sequential allowances without marking up compensation or rent. */
export function applyConstructionAllowances(costs){
  const base=CONSTRUCTION_BASE_COST_KEYS.reduce((sum,key)=>safeCents(sum+safeCents(costs[key]??0)),0);
  costs.engineeringCents=roundedPercent(base,DEMO_COST_MODEL.engineeringPercent);
  costs.contingencyCents=roundedPercent(safeCents(base+costs.engineeringCents),DEMO_COST_MODEL.contingencyPercent);
  return costs;
}

/** The two fixed terminal allowances are added once, after graph search. */
export function terminalConstructionCosts(rateCents=DEMO_COST_MODEL.terminalCents,count=2){
  safeCents(rateCents);safeCents(count);
  const costs=emptyRouteCosts();costs.terminalCents=safeCents(rateCents*count);
  return applyConstructionAllowances(costs);
}
