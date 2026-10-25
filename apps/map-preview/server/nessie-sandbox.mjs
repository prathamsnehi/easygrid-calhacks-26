/** Server-only Nessie adapter. The browser never receives provider keys or account IDs. */
import {createHash} from 'node:crypto';
export function dollarsToCents(value) {
  const match = String(value).match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error('Invalid bank amount.');
  const result = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(result)) throw new Error('Bank amount exceeds the supported range.');
  return result;
}

export function createNessieSandboxBank({apiKey, baseUrl, payerId, recipients, allowTransfers = false, fetcher = fetch, now = () => new Date().toISOString()}) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || !['prod-api.nessieisreal.com','api.nessieisreal.com','api.reimaginebanking.com'].includes(base.hostname) || base.username || base.password || base.port || base.pathname !== '/' || base.search || base.hash) throw new Error('Configure an approved HTTPS Nessie API origin.');
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 150 && !/[\s\u0000-\u001f]/.test(value);
  if (!apiKey || !validId(payerId) || !recipients || Object.values(recipients).some(r => !validId(r.accountId) || !validId(r.customerId) || r.accountId === payerId)) throw new Error('Configure sandbox credentials and explicit fictional-owner recipient mappings on the server.');
  const destination = ownerId => { const result = Object.hasOwn(recipients, ownerId) ? recipients[ownerId] : null; if (!result) throw new Error('No configured recipient for this fictional owner.'); return result; };
  async function request(path, {method = 'GET', body, allowEmptyTransferList = false} = {}) {
    const url = new URL(path, base); url.searchParams.set('key', apiKey);
    let response;
    try { response = await fetcher(url, {method, redirect: 'error', signal: AbortSignal.timeout(10000), headers: {'content-type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})}); }
    catch { throw new Error('Nessie sandbox request could not be confirmed.'); }
    if (!response.ok) {
      // The live provider represents an empty account transfer list with this exact JSON string.
      // Only inspect(), after verifying both accounts, may accept this response as no evidence.
      if (allowEmptyTransferList && method === 'GET' && path === `/accounts/${encodeURIComponent(payerId)}/transfers` && response.status === 404) {
        let message;
        try { message = await response.json(); } catch { /* Other error responses remain failures. */ }
        if (message === 'No transfers found for this account') return [];
      }
      throw new Error(`Nessie sandbox returned HTTP ${response.status}.`);
    }
    try { return await response.json(); } catch { throw new Error('Nessie sandbox returned an invalid response.'); }
  }
  const recipientBinding = ownerId => createHash('sha256').update(JSON.stringify([base.origin,payerId,destination(ownerId)])).digest('hex');
  const marker = input => `EasyGrid ${input.obligationId} ${input.documentHash} ${recipientBinding(input.ownerId)}`;
  const amountIssue = amountCents => !Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents % 100 !== 0
    ? 'Nessie records support whole-dollar amounts only. The exact approved compensation includes cents; no record was created and the amount was not rounded.' : null;
  const recordId = row => {
    if (row?.id !== undefined && row?._id !== undefined && row.id !== row._id) throw new Error('The sandbox returned conflicting record identities.');
    return row?.id ?? row?._id;
  };
  function evidence(row, input, recipient) {
    const id = recordId(row);
    if (!validId(id)) throw new Error('The sandbox record has no verifiable transaction ID.');
    return {obligationId: input.obligationId, amountCents: dollarsToCents(row.amount),
      // This binds a record to approved demo context; it does not prove a recipient was paid.
      recipientMatches: row.description === marker(input) && (row.payer_id === undefined || row.payer_id === payerId) &&
        (row.payee_id === undefined || row.payee_id === recipient.accountId),
      paymentSemantics:'record-only',
      status: ['failed','rejected','cancelled','canceled'].includes(row.status)
        ? (['cancelled','canceled'].includes(row.status) ? 'rejected' : row.status)
        : ['pending','completed','executed'].includes(row.status) ? 'recorded' : 'pending',
      transactionRef: `nessie-${id.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 100)}`};
  }
  return {
    mode: 'nessie-sandbox',
    paymentSemantics:'record-only',
    amountIncrementCents:100,
    amountIssue,
    storageNamespace: createHash('sha256').update(JSON.stringify([base.origin, payerId])).digest('hex'),
    canTransfer: allowTransfers,
    recipientBinding,
    inspect: async input => {
      if (input.scenario && input.scenario !== 'normal') throw new Error('Planted scenarios are available only in local simulation.');
      const recipient = destination(input.ownerId);
      const payer = await request(`/accounts/${encodeURIComponent(payerId)}`);
      const payee = await request(`/accounts/${encodeURIComponent(recipient.accountId)}`);
      if (payer._id !== payerId || payee._id !== recipient.accountId || payee.customer_id !== recipient.customerId) throw new Error('Sandbox account identity does not match server configuration.');
      const transfers = await request(`/accounts/${encodeURIComponent(payerId)}/transfers`, {allowEmptyTransferList:true});
      if (!Array.isArray(transfers)) throw new Error('Invalid sandbox transfer evidence.');
      const matches = transfers.filter(row => typeof row?.description === 'string' && row.description.startsWith(`EasyGrid ${input.obligationId} `));
      return {recipientMatches: true, balanceCents: dollarsToCents(payer.balance),
        existingEvidence: matches.length > 1 ? {obligationId: input.obligationId, amountCents: 0, recipientMatches: false, status: 'pending'} : matches.length ? evidence(matches[0], input, recipient) : null};
    },
    transfer: async input => {
      if (!allowTransfers) throw new Error('Nessie sandbox writes are disabled until explicitly enabled by the operator.');
      const issue = amountIssue(input.amountCents);
      if (issue) throw new Error(issue);
      const recipient = destination(input.ownerId), amount = input.amountCents / 100;
      if (dollarsToCents(amount) !== input.amountCents) throw new Error('This amount cannot be represented exactly by the sandbox API.');
      // No automatic retry and no invented idempotency header. Durable obligation state protects this call.
      const response = await request(`/accounts/${encodeURIComponent(payerId)}/transfers`, {method:'POST', body:{transaction_date:now().slice(0,10),status:'pending',amount,description:marker(input)}});
      const id = recordId(response.objectCreated) ?? recordId(response);
      if (!validId(id)) throw new Error('The sandbox accepted no verifiable transfer ID.');
      const confirmed = await request(`/transfers/${encodeURIComponent(id)}`);
      if (recordId(confirmed) !== id) throw new Error('The sandbox returned a different transaction identity.');
      return evidence(confirmed, input, recipient);
    },
  };
}
