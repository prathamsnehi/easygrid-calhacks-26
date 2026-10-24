/**
 * Capital One Nessie banking sandbox read-only evidence adapter.
 * API key MUST be supplied server-side; no secrets in UI, logs, or repository.
 * It reads sandbox accounts and their deposits/withdrawals for finance evidence.
 * It NEVER sends payments or claims a mock ledger entry is a Nessie transfer.
 * Verify against an actual Nessie account before claiming sponsor integration.
 */
export type NessieTransaction = {
  _id?: string; amount?: number; status?: string; transaction_date?: string;
  medium?: string; description?: string;
};
export type NessieAccount = { _id: string; balance?: number; nickname?: string; type?: string };
export class NessieSandbox {
  private readonly apiKey: string;
  private readonly transport: typeof fetch;
  private readonly origin: string;
  constructor(apiKey: string,
    transport: typeof fetch = fetch,
    origin = 'https://prod-api.nessieisreal.com') {
    this.apiKey = apiKey;
    this.transport = transport;
    this.origin = origin;
    if (!apiKey.trim()) throw new Error('NESSIE_API_KEY required on server');
    if (!origin.startsWith('https://') && !origin.startsWith('http://127.0.0.1'))
      throw new Error('Nessie origin must use HTTPS');
  }
  private async get<T>(path: string): Promise<T> {
    const url = new URL(path, this.origin);
    url.searchParams.set('key',this.apiKey);
    let response: Response;
    try { response = await this.transport(url.toString(),{method:'GET',headers:{Accept:'application/json'}}); }
    catch { throw new Error('Nessie sandbox request failed'); }
    if (!response.ok) throw new Error('Nessie sandbox returned HTTP '+response.status);
    return await response.json() as T;
  }
  accounts(): Promise<NessieAccount[]> { return this.get('/accounts'); }
  account(accountId: string): Promise<NessieAccount> {
    if (!accountId.trim()) throw new Error('accountId required');
    return this.get('/accounts/'+encodeURIComponent(accountId));
  }
  deposits(accountId: string): Promise<NessieTransaction[]> {
    if (!accountId.trim()) throw new Error('accountId required');
    return this.get('/accounts/'+encodeURIComponent(accountId)+'/deposits');
  }
  withdrawals(accountId: string): Promise<NessieTransaction[]> {
    if (!accountId.trim()) throw new Error('accountId required');
    return this.get('/accounts/'+encodeURIComponent(accountId)+'/withdrawals');
  }
}
