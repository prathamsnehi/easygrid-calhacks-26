import { z } from 'zod';
import * as s from './schemas.ts';

export const Command = { schemaVersion: z.literal(1), expectedRevision: s.Revision, idempotencyKey: s.Id };
export const ErrorCode = z.enum(['INVALID_INPUT', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND',
  'STALE_REVISION', 'STALE_VERSION', 'IDEMPOTENCY_CONFLICT', 'BLOCKED_STATE',
  'DEPENDENCY_UNAVAILABLE', 'INVALID_RESPONSE']);
export const errorStatus = {
  INVALID_INPUT: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  STALE_REVISION: 409, STALE_VERSION: 409, IDEMPOTENCY_CONFLICT: 409,
  BLOCKED_STATE: 422, DEPENDENCY_UNAVAILABLE: 503, INVALID_RESPONSE: 502,
} as const;
export const ErrorEnvelope = z.strictObject({
  error: z.strictObject({ code: ErrorCode, message: s.Text, retryable: z.boolean(), details: z.record(z.string(), z.json()).optional() }),
  requestId: s.Id,
});
export function success<T extends z.ZodType>(data: T) {
  return z.strictObject({ data, projectRevision: s.Revision, requestId: s.Id });
}
function operation<Q extends z.ZodObject, R extends z.ZodType>(
  method: 'GET' | 'POST', path: string, pathKeys: string[], request: Q, data: R,
) { return { method, path, pathKeys, request, response: success(data) }; }
const ProjectCommand = { projectId: s.Id, ...Command };
const RouteResult = z.strictObject({ candidates: z.array(s.RouteCandidate), recommendation: s.Id.nullable(), reasons: z.array(s.Text) });
export const operations = {
  createProject: operation('POST', '/api/v1/projects', [], z.strictObject({
    ...Command, expectedRevision: z.literal(0), endpointA: s.Point, endpointB: s.Point,
    budgetCents: s.Cents, rentHorizonMonths: z.number().int().min(1).max(1200), sourceMode: s.SourceMode,
  }), s.Project),
  getProject: operation('GET', '/api/v1/projects/{projectId}', ['projectId'], z.strictObject({ projectId: s.Id }), s.Snapshot),
  evaluateRoutes: operation('POST', '/api/v1/projects/{projectId}/routes', ['projectId'], z.strictObject(ProjectCommand), RouteResult),
  createCallSession: operation('POST', '/api/v1/call-sessions', [], z.strictObject({
    ...ProjectCommand, parcelId: s.Id, routeVersion: s.Version,
    participantContactRef: s.Id, participantConsent: z.literal(true),
  }), s.CallSession),
  getCallSession: operation('GET', '/api/v1/call-sessions/{sessionId}', ['sessionId'], z.strictObject({ sessionId: s.Id }), s.CallSession),
  recordNegotiation: operation('POST', '/api/v1/negotiation-results', [], z.strictObject({
    ...ProjectCommand, result: s.NegotiationResult,
  }).refine(v => v.projectId === v.result.projectId, 'Result must belong to the command project'),
  z.strictObject({ result: s.NegotiationResult, rerouteNeeded: z.boolean() })),
  replan: operation('POST', '/api/v1/projects/{projectId}/replan', ['projectId'], z.strictObject({
    ...ProjectCommand, negotiationResultId: s.Id,
  }), z.strictObject({ priorCandidates: z.array(s.RouteCandidate), candidates: z.array(s.RouteCandidate),
    recommendation: s.Id.nullable(), costDeltaCents: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    changedParcelIds: s.UniqueIds, invalidatedApprovalIds: s.UniqueIds, reasons: z.array(s.Text) })),
  createEasement: operation('POST', '/api/v1/easements', [], z.strictObject({
    ...ProjectCommand, routeId: s.Id, routeVersion: s.Version, parcelId: s.Id, termsVersion: s.Version,
  }), z.strictObject({ easement: s.Easement.nullable(), missingFields: z.array(s.Text) })),
  demoSign: operation('POST', '/api/v1/easements/{contractId}/demo-sign', ['contractId'], z.strictObject({
    ...Command, contractId: s.Id, contractVersion: s.Version, signerAlias: s.Text,
  }), z.strictObject({ easement: s.Easement, simulation: z.literal(true) })),
  approveProject: operation('POST', '/api/v1/projects/{projectId}/approvals', ['projectId'], z.strictObject({
    ...ProjectCommand, routeId: s.Id, routeVersion: s.Version, termsVersions: s.TermsVersions, contractIds: s.UniqueIds.min(1),
  }), s.Approval),
  createPayment: operation('POST', '/api/v1/payments', [], z.strictObject({
    ...Command, contractId: s.Id, contractVersion: s.Version, approvalId: s.Id,
    kind: z.enum(['deposit', 'rent']), installmentPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  }).refine(v => v.kind === 'rent' ? v.installmentPeriod !== undefined : v.installmentPeriod === undefined,
    'Rent requires an installment period; deposit must not contain one'), s.Payment),
  reconcile: operation('POST', '/api/v1/reconciliations', [], z.strictObject({
    ...ProjectCommand, asOfDemoDate: s.DateOnly,
  }), z.strictObject({ entries: z.array(s.ReconciliationEntry) })),
  resetDemo: operation('POST', '/api/v1/demo/reset', [], z.strictObject({
    ...ProjectCommand, newSessionId: s.Id,
  }), z.strictObject({ sessionId: s.Id, project: s.Project })),
} as const;
export type OperationName = keyof typeof operations;
export type ApiRequest<K extends OperationName> = z.infer<(typeof operations)[K]['request']>;
export type ApiResponse<K extends OperationName> = z.infer<(typeof operations)[K]['response']>;
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
export interface ContractApi {
  execute<K extends OperationName>(operation: K, request: ApiRequest<K>): Promise<ApiResponse<K>>;
}
export class ContractError extends Error {
  code: z.infer<typeof ErrorCode>;
  constructor(code: z.infer<typeof ErrorCode>, message: string) { super(message); this.code = code; }
  get status() { return errorStatus[this.code]; }
  envelope(requestId: string): ErrorEnvelope {
    // A 503 is not automatically retryable: the provider may have received the command.
    return ErrorEnvelope.parse({ error: { code: this.code, message: this.message, retryable: false }, requestId });
  }
}
/** No automatic retries. Authentication and the service base URL are caller-owned. */
export function createApiClient(baseUrl: string, fetcher: typeof fetch = fetch): ContractApi {
  return { async execute<K extends OperationName>(name: K, input: ApiRequest<K>): Promise<ApiResponse<K>> {
    const op = operations[name];
    const parsed = op.request.safeParse(input);
    if (!parsed.success) throw new ContractError('INVALID_INPUT', 'Request does not match API v1');
    const body = { ...parsed.data } as Record<string, unknown>;
    let path = op.path;
    for (const key of op.pathKeys) { path = path.replace(`{${key}}`, encodeURIComponent(String(body[key]))); delete body[key]; }
    const response = await fetcher(new URL(path, baseUrl), {
      method: op.method, headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      ...(op.method === 'POST' ? { body: JSON.stringify(body) } : {}),
    });
    let json: unknown;
    try { json = await response.json(); }
    catch { throw new ContractError('INVALID_RESPONSE', 'Server did not return JSON'); }
    if (!response.ok) {
      const error = ErrorEnvelope.safeParse(json);
      if (!error.success) throw new ContractError('INVALID_RESPONSE', 'Invalid API error envelope');
      throw new ContractError(error.data.error.code, error.data.error.message);
    }
    const result = op.response.safeParse(json);
    if (!result.success) throw new ContractError('INVALID_RESPONSE', 'Response does not match API v1');
    return result.data as ApiResponse<K>;
  } };
}
