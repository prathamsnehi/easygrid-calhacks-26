import test from 'node:test';
import assert from 'node:assert/strict';
import {Snapshot} from '../../../packages/contracts/src/schemas.ts';
import {operations} from '../../../packages/contracts/src/api.ts';
import {createWorld} from '../src/world.js';
import {createPlacement} from '../src/placement.js';
import {computeTransmissionRoutes} from '../src/routing.js';
import {analyzeRouteParcels} from '../src/parcel-analysis.js';
import {createHandoff,buildCallSessionRequest} from '../src/handoff.js';

test('every map handoff snapshot and canonical call request pass the frozen shared Zod schemas',()=>{
  const world=createWorld(),substation=createPlacement(world,'substation',-43,-17);
  const placements={substation,datacenter:createPlacement(world,'datacenter',43,-17,{substation})};
  const result=computeTransmissionRoutes(world,placements);
  assert.equal(result.status,'ok');
  for(const route of result.candidates){
    const analysis=analyzeRouteParcels(world,route,result.assumptions);
    const handoff=createHandoff({world,route,analysis,placements,sessionId:'schema-check',routeVersion:7});
    assert.deepEqual(Snapshot.parse(handoff.snapshot),handoff.snapshot);
    const request=buildCallSessionRequest({projectId:'backend-project-17',parcelId:handoff.judgeRole.parcelId,
      expectedRevision:8,routeVersion:7,registeredContactRef:'registered-demo-contact-19',
      participantConsent:true,idempotencyKey:`call-${route.id}-7`});
    assert.deepEqual(operations.createCallSession.request.parse(request),request);
    assert.equal(request.participantContactRef,'registered-demo-contact-19');
    assert.notEqual(request.participantContactRef,handoff.judgeRole.participantContactRef);
  }
});
