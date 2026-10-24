/**
 * CAL-13: deterministic, synthetic easement preview and simulated signature.
 * Pure domain operations only: SpacetimeDB must enforce revision, authorization,
 * atomic idempotency and persistence at the command boundary.
 */
import { createHash } from 'node:crypto';
import { ContractError } from './api.ts';
import { assertVersion, canonicalJson, validateNegotiation } from './policy.ts';
import { Easement, DateOnly, type NegotiationResult, type Easement as EasementType } from './schemas.ts';

export type EasementInput = {
  id: string; projectId: string; routeId: string; parcelId: string;
  contractVersion: number; templateVersion: string;
  ownerAlias: string; operatorAlias: string; corridorDescription: string;
  accessConditions: string[]; effectiveStartDate: string; effectiveEndDate: string;
  negotiation: NegotiationResult; offerCapCents: number;
  priorContract?: EasementType;
  currentRouteVersion?: number; currentTermsVersion?: number;
};

export type EasementArtifact = {
  contract: EasementType | null;
  preview: string;
  missingFields: string[];
  supersededContract?: EasementType;
};

const nonempty = (value: string) => value.trim().length > 0;
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function createEasementDraft(input: EasementInput): EasementArtifact {
  const missingFields: string[] = [];
  for (const key of ['id', 'projectId', 'routeId', 'parcelId', 'templateVersion',
    'ownerAlias', 'operatorAlias', 'corridorDescription', 'effectiveStartDate', 'effectiveEndDate'] as const) {
    if (!nonempty(input[key])) missingFields.push(key);
  }
  if (input.accessConditions.length === 0 || input.accessConditions.some(v => !nonempty(v)))
    missingFields.push('accessConditions');
  const n = input.negotiation;
  if (input.currentRouteVersion !== undefined) assertVersion(input.currentRouteVersion, n.routeVersion);
  if (input.currentTermsVersion !== undefined) assertVersion(input.currentTermsVersion, n.termsVersion);
  if (n.outcome !== 'accepted') missingFields.push('acceptedNegotiation');
  if (n.accessConsent !== 'allowed' || !n.explicitConfirmation) missingFields.push('explicitAccessConsent');
  if (n.evidenceRefs.length === 0) missingFields.push('evidenceRefs');
  if (n.projectId !== input.projectId || n.parcelId !== input.parcelId)
    throw new ContractError('INVALID_INPUT', 'Negotiation does not match project/parcel');
  const startValid = DateOnly.safeParse(input.effectiveStartDate).success;
  const endValid = DateOnly.safeParse(input.effectiveEndDate).success;
  if (!startValid || !endValid || input.effectiveStartDate >= input.effectiveEndDate)
    missingFields.push('effectiveDates');
  if (startValid && !input.effectiveStartDate.endsWith('-01'))
    missingFields.push('monthAlignedStartDate');
  if (startValid && endValid && input.effectiveStartDate.endsWith('-01') &&
      Number.isInteger(n.termMonths) && n.termMonths >= 1) {
    const startMonth = Number(input.effectiveStartDate.slice(0, 4)) * 12 +
      Number(input.effectiveStartDate.slice(5, 7)) - 1;
    const endMonth = startMonth + n.termMonths;
    const expectedEnd = new Date(Date.UTC(Math.floor(endMonth / 12),
      endMonth % 12, 0)).toISOString().slice(0, 10);
    if (input.effectiveEndDate !== expectedEnd) missingFields.push('termDateMismatch');
  }
  if (input.priorContract) {
    if (input.priorContract.status === 'superseded')
      throw new ContractError('BLOCKED_STATE', 'Cannot supersede an already superseded contract');
    if (input.priorContract.projectId !== input.projectId || input.priorContract.parcelId !== input.parcelId)
      throw new ContractError('INVALID_INPUT', 'Prior contract belongs to another project/parcel');
    if (input.contractVersion !== input.priorContract.contractVersion + 1)
      throw new ContractError('STALE_VERSION', 'Regeneration must increment contract version');
  } else if (input.contractVersion !== 1) {
    throw new ContractError('STALE_VERSION', 'First contract version must be 1');
  }
  if (missingFields.length > 0)
    return { contract: null, preview: '', missingFields: [...new Set(missingFields)] };
  validateNegotiation(n, input.offerCapCents);
  const canonicalContent = {
    projectId: input.projectId, routeId: input.routeId, parcelId: input.parcelId,
    routeVersion: n.routeVersion, termsVersion: n.termsVersion,
    contractVersion: input.contractVersion, templateVersion: input.templateVersion,
    ownerAlias: input.ownerAlias, operatorAlias: input.operatorAlias,
    corridorDescription: input.corridorDescription, accessConditions: input.accessConditions,
    effectiveStartDate: input.effectiveStartDate, effectiveEndDate: input.effectiveEndDate,
    upfrontCents: n.upfrontCents, depositCents: n.depositCents,
    depositCreditPolicy: n.depositCreditPolicy, monthlyRentCents: n.monthlyRentCents,
    termMonths: n.termMonths, conditions: n.conditions,
  };
  const hash = createHash('sha256').update(canonicalJson(canonicalContent)).digest('hex');
  const contract = Easement.parse({
    schemaVersion: 1, sourceMode: 'mock', evidenceRefs: n.evidenceRefs,
    id: input.id, contractVersion: input.contractVersion,
    projectId: input.projectId, parcelId: input.parcelId, routeId: input.routeId,
    routeVersion: n.routeVersion, termsVersion: n.termsVersion,
    templateVersion: input.templateVersion, contentHash: `sha256:${hash}`,
    effectiveStartDate: input.effectiveStartDate, effectiveEndDate: input.effectiveEndDate,
    upfrontCents: n.upfrontCents, depositCents: n.depositCents,
    depositCreditPolicy: n.depositCreditPolicy, monthlyRentCents: n.monthlyRentCents,
    termMonths: n.termMonths, status: 'draft', signatureMode: 'simulated',
    artifactRef: `demo-easement:${input.id}:v${input.contractVersion}`,
  });
  const preview = [
    'DEMO ONLY — SIMULATED EASEMENT; NOT A LEGAL AGREEMENT',
    `Contract ${contract.id} v${contract.contractVersion} | Template ${contract.templateVersion}`,
    `Parties: ${input.operatorAlias} / ${input.ownerAlias} (synthetic aliases)`,
    `Parcel: ${input.parcelId} | Corridor: ${input.corridorDescription}`,
    `Route: ${input.routeId} v${contract.routeVersion} | Terms: v${contract.termsVersion}`,
    `Access: ${input.accessConditions.join('; ')}`,
    `Additional conditions: ${n.conditions.join('; ') || 'None'}`,
    `Term: ${contract.termMonths} months | Effective: ${contract.effectiveStartDate} to ${contract.effectiveEndDate}`,
    `Upfront compensation: ${usd(contract.upfrontCents)}`,
    `Deposit: ${usd(contract.depositCents)} (${contract.depositCreditPolicy})`,
    `Monthly rent: ${usd(contract.monthlyRentCents)}`,
    `Content hash: ${contract.contentHash}`,
    'No real signature, notarization, transfer of funds or legal execution.',
  ].join('\n');
  const supersededContract = input.priorContract
    ? Easement.parse({ ...input.priorContract, status: 'superseded' }) : undefined;
  return { contract, preview, missingFields: [], supersededContract };
}

export function awaitDemoSignature(contract: EasementType): EasementType {
  if (contract.status !== 'draft')
    throw new ContractError('BLOCKED_STATE', 'Only draft contracts can await signature');
  return Easement.parse({ ...contract, status: 'awaiting_demo_signature' });
}

export type DemoSignatureReceipt = {
  simulation: true; contractId: string; contractVersion: number;
  contentHash: string; signerAlias: string; signedAt: string;
  notice: 'SIMULATED SIGNATURE — NOT LEGALLY EXECUTED';
};

export function demoSign(contract: EasementType, signerAlias: string, signedAt: string):
  { easement: EasementType; receipt: DemoSignatureReceipt } {
  if (contract.status !== 'awaiting_demo_signature')
    throw new ContractError('BLOCKED_STATE', 'Contract is not awaiting a demo signature');
  if (!nonempty(signerAlias)) throw new ContractError('INVALID_INPUT', 'Signer alias required');
  const easement = Easement.parse({ ...contract, status: 'demo_signed', signedAt });
  return { easement, receipt: {
    simulation: true, contractId: contract.id, contractVersion: contract.contractVersion,
    contentHash: contract.contentHash, signerAlias, signedAt,
    notice: 'SIMULATED SIGNATURE — NOT LEGALLY EXECUTED',
  } };
}
