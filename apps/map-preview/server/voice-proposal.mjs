import {createWorld} from '../src/world.js';
import {createPlacement} from '../src/placement.js';
import {computeTransmissionRoutes} from '../src/routing.js';
import {normalizeRoutingConstraints} from '../src/routing-constraints.js';
import {reconstructMapProposal} from './map-contracts.mjs';

/** Browser context selects trusted fixture geometry; it never supplies amounts. */
export function createVoiceProposal(context, world = createWorld()) {
  const handoff = reconstructMapProposal(context, world);
  const substation = createPlacement(world, 'substation', context.substation.x, context.substation.z);
  const datacenter = createPlacement(world, 'datacenter', context.datacenter.x, context.datacenter.z, {substation});
  const placements = {substation, datacenter};
  const result = computeTransmissionRoutes(world, placements, normalizeRoutingConstraints(world, context.routingConstraints ?? {}));
  const route = result.candidates.find(candidate => candidate.id === context.routeId);
  if (!route) throw new Error('The selected route is no longer available.');
  return {handoff, route, placements, assumptions:result.assumptions};
}
