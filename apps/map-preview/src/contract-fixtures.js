/** Temporary development examples, deliberately independent of the final shared API. */
export function createContractExample(status = 'approved') {
  if (!['approved', 'pending', 'refused'].includes(status)) throw new Error('Unknown example status.');
  return {
    sourceMode: 'fixture', sessionId: 'contract-demo-easygrid-full-2026-10-24', paymentSchedule: 'full-after-signatures',
    project: {name: 'Willow Creek transmission link', developerName: 'EasyGrid', signerName: 'Ethan Cole'},
    route: {id: 'route-willow-north', version: 3, name: 'Willow Creek / North corridor'},
    negotiation: {id: 'NEG-DEMO-024', version: 2, status, approvedAt: status === 'approved' ? '2026-10-24T17:30:00Z' : null},
    parcels: [
      {parcelId: 'P-004', ownerId: 'OWNER-DEMO-004', ownerName: 'Willow Creek Orchard', signerName: 'Olivia Bennett',
        landDescription: 'Fictional orchard parcel. A 180 m overhead corridor and two illustrative tower pads along the northern boundary.',
        accepted: status === 'approved', termsVersion: 2, compensationCents: 1200000,
        accessTerms: 'Use the approved northern corridor for two tower pads and overhead transmission lines. Schedule maintenance access with the fictional landowner and restore disturbed ground.'},
      {parcelId: 'P-009', ownerId: 'OWNER-DEMO-009', ownerName: 'Meadow Ridge Farm', signerName: 'Daniel Brooks',
        landDescription: 'Fictional grazing parcel. A 125 m overhead corridor and one illustrative tower pad along the eastern boundary.',
        accepted: status === 'approved', termsVersion: 1, compensationCents: 800000,
        accessTerms: 'Use the approved eastern corridor for one tower pad and overhead transmission lines. Preserve livestock access and coordinate maintenance visits with the fictional landowner.'},
    ],
  };
}
