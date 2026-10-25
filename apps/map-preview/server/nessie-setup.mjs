/** CAL-37: private, restartable fictional-account setup. Never submits transfers. */
import {readFile, writeFile, rename, unlink, open} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {parseEnv} from 'node:util';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createWorld} from '../src/world.js';
import {createContractExample} from '../src/contract-fixtures.js';

const ORIGINS = new Set(['https://prod-api.nessieisreal.com','https://api.nessieisreal.com','https://api.reimaginebanking.com']);
const ADDRESS = Object.freeze({street_number:'100',street_name:'Demo Lane',city:'San Francisco',state:'CA',zip:'94123'});
const PAYER = 'CAL-POWER';
const clone = value => JSON.parse(JSON.stringify(value));
const validId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,150}$/.test(value);
class SetupError extends Error {}
const requireSetup = (value, message) => {if (!value) throw new SetupError(message);};

export function nessieDemoOwners() {
  return [...new Set([...createWorld().owners.map(owner => owner.id), ...createContractExample().parcels.map(parcel => parcel.ownerId)])].sort();
}

export function nessieDemoTarget(id) {
  requireSetup(id === PAYER || validId(id), 'Invalid fictional owner identifier.');
  const label = id === PAYER ? 'Payer' : id;
  return {id, customer:{first_name:'EasyGrid',last_name:`${label} Sandbox`,address:{...ADDRESS}},
    account:{type:'Checking',nickname:`EasyGrid ${label} Sandbox`,rewards:0,balance:id === PAYER ? 10000000 : 0}};
}

function privateJSON(value, fallback) {
  if (!value) return clone(fallback);
  try {return JSON.parse(value);} catch {throw new SetupError('Private setup configuration is invalid JSON.');}
}

/** persist receives private environment values; callers must never log its argument. */
export function createNessieSetup({config, fetcher = fetch, persist = async () => {}, ownerIds = nessieDemoOwners()}) {
  const settings = {...config};
  let origin;
  try {origin = new URL(settings.NESSIE_API_ORIGIN);} catch {throw new SetupError('Configure the HTTPS Nessie API origin.');}
  requireSetup(ORIGINS.has(origin.origin) && origin.pathname === '/' && !origin.search && !origin.hash && !origin.username && !origin.password,
    'Configure an approved HTTPS Nessie API origin.');
  requireSetup(typeof settings.NESSIE_API_KEY === 'string' && settings.NESSIE_API_KEY.length > 0 && !/[\s\u0000-\u001f]/.test(settings.NESSIE_API_KEY),
    'A private Nessie API key is required.');
  requireSetup(Array.isArray(ownerIds) && ownerIds.length > 0 && ownerIds.every(id => validId(id) && id !== PAYER) && new Set(ownerIds).size === ownerIds.length,
    'Unique fictional owner identifiers are required.');
  const recipients = privateJSON(settings.NESSIE_OWNER_RECIPIENTS, {});
  requireSetup(recipients && typeof recipients === 'object' && !Array.isArray(recipients) && Object.values(recipients).every(row => row && validId(row.accountId) && validId(row.customerId)),
    'Private recipient mappings are invalid.');
  const state = privateJSON(settings.NESSIE_SETUP_STATE, {schemaVersion:1,customers:{},pending:null});
  requireSetup(state && state.schemaVersion === 1 && state.customers && typeof state.customers === 'object' && !Array.isArray(state.customers) &&
    Object.values(state.customers).every(validId) && (!state.pending || ['customer','account'].includes(state.pending.kind) && validId(state.pending.targetId)),
    'Private setup checkpoint is invalid.');
  const targets = [nessieDemoTarget(PAYER), ...ownerIds.map(nessieDemoTarget)];
  requireSetup(!state.pending || targets.some(target => target.id === state.pending.targetId), 'The pending setup operation belongs to another owner list.');
  const save = async () => {
    settings.NESSIE_OWNER_RECIPIENTS = JSON.stringify(recipients);
    settings.NESSIE_SETUP_STATE = JSON.stringify(state);
    try {await persist({...settings});} catch {throw new SetupError('Private setup checkpoint could not be saved. No further creation was attempted.');}
  };
  async function request(path, body) {
    const url = new URL(path, origin);url.searchParams.set('key', settings.NESSIE_API_KEY);
    let response;
    try {response = await fetcher(url, {method:body ? 'POST' : 'GET',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{accept:'application/json','content-type':'application/json'},...(body ? {body:JSON.stringify(body)} : {})});}
    catch {throw new SetupError(body ? 'Account setup outcome is uncertain. Run --check before any recovery; no automatic retry was sent.' : 'Nessie account information could not be confirmed.');}
    requireSetup(response.ok, body ? 'Account setup was not confirmed. The pending operation remains blocked for review.' : `Nessie read-only check returned HTTP ${response.status}.`);
    try {return await response.json();} catch {throw new SetupError(body ? 'Account setup returned an unreadable result. The pending operation remains blocked for review.' : 'Nessie account information was unreadable.');}
  }
  async function customers() {
    const rows = await request('/customers');
    requireSetup(Array.isArray(rows), 'Nessie customer list was not an array.');return rows;
  }
  function findCustomer(rows, target) {
    // Recognize existing fictional payer records without renaming or replacing them.
    const names = target.id === PAYER ? [target.customer.last_name, 'Cal Power Sandbox'] : [target.customer.last_name];
    const matches = rows.filter(row => row?.first_name === target.customer.first_name && names.includes(row?.last_name));
    requireSetup(matches.length <= 1, 'More than one fictional customer matches a setup name. Resolve the ambiguity before continuing.');
    const row = matches[0];
    if (row) requireSetup(validId(row._id) && Object.entries(ADDRESS).every(([key,value]) => String(row.address?.[key]) === value),
      'A matching customer has an unexpected identity or address. Setup stopped.');
    if (row && state.customers[target.id]) requireSetup(row._id === state.customers[target.id], 'A saved fictional customer no longer matches the provider record.');
    return row;
  }
  async function findAccount(customerId, target) {
    const rows = await request(`/customers/${encodeURIComponent(customerId)}/accounts`);
    requireSetup(Array.isArray(rows), 'Nessie account list was not an array.');
    const names = target.id === PAYER ? [target.account.nickname, 'EasyGrid Cal Power Sandbox'] : [target.account.nickname];
    const matches = rows.filter(row => names.includes(row?.nickname));
    requireSetup(matches.length <= 1, 'More than one account matches a fictional nickname. Resolve the ambiguity before continuing.');
    const row = matches[0];
    if (row) requireSetup(validId(row._id) && row.customer_id === customerId && row.type === 'Checking' && Number.isFinite(Number(row.balance)) && Number(row.balance) >= 0,
      'A matching sandbox account has an unexpected identity, type or balance.');
    const saved = target.id === PAYER ? settings.NESSIE_PAYER_ACCOUNT_ID : recipients[target.id]?.accountId;
    if (row && saved) requireSetup(row._id === saved, 'An existing payout mapping differs from the sandbox account. Setup will not replace it.');
    if (row && target.id !== PAYER && recipients[target.id]) requireSetup(customerId === recipients[target.id].customerId,
      'An existing recipient customer binding differs from the provider record.');
    return row;
  }
  async function create(kind, target, path, body) {
    requireSetup(!state.pending, 'An earlier creation has an unresolved outcome. Inspect provider records before continuing.');
    state.pending = {kind,targetId:target.id};
    await save(); // The uncertainty marker must exist before the external side effect.
    await request(path, body); // No retry, including after a failed or unreadable POST response.
  }
  async function clearPending(kind, target) {
    if (state.pending?.kind === kind && state.pending.targetId === target.id) {state.pending = null;await save();}
  }
  return {
    async run({createAccounts = false, enableTransfers = false} = {}) {
      requireSetup(!enableTransfers || createAccounts, '--enable-transfers requires --create-demo-accounts.');
      if (createAccounts) {
        settings.EASYGRID_PAYMENT_PROVIDER = 'simulation';settings.NESSIE_ALLOW_SANDBOX_TRANSFERS = 'no';await save();
      }
      let rows = await customers(), payerReady = false, matchedRecipients = 0, missingCustomers = 0, missingAccounts = 0;
      // Resolve a durable pending operation first, even when earlier targets are already provisioned.
      const ordered = state.pending ? [...targets.filter(t => t.id === state.pending.targetId), ...targets.filter(t => t.id !== state.pending.targetId)] : targets;
      for (const target of ordered) {
        let customer = findCustomer(rows, target);
        if (!customer) {
          missingCustomers++;
          if (!createAccounts) continue;
          requireSetup(!state.customers[target.id] && !(target.id === PAYER ? settings.NESSIE_PAYER_ACCOUNT_ID : recipients[target.id]),
            'A configured fictional customer is missing. Setup will not create a replacement payout identity.');
          await create('customer', target, '/customers', target.customer);
          rows = await customers();customer = findCustomer(rows, target);
          requireSetup(customer, 'Created customer is not yet visible. The pending operation is retained; no second customer will be created.');
          missingCustomers--;
        }
        if (createAccounts) {state.customers[target.id] = customer._id;await clearPending('customer',target);await save();}
        let account = await findAccount(customer._id, target);
        if (!account) {
          missingAccounts++;
          if (!createAccounts) continue;
          requireSetup(!(target.id === PAYER ? settings.NESSIE_PAYER_ACCOUNT_ID : recipients[target.id]),
            'A configured sandbox account is missing. Setup will not create a replacement payout destination.');
          await create('account',target,`/customers/${encodeURIComponent(customer._id)}/accounts`,target.account);
          account = await findAccount(customer._id,target);
          requireSetup(account, 'Created account is not yet visible. The pending operation is retained; no second account will be created.');
          missingAccounts--;
        }
        if (target.id === PAYER) {payerReady = true;if (createAccounts) settings.NESSIE_PAYER_ACCOUNT_ID = account._id;}
        else {matchedRecipients++;if (createAccounts) recipients[target.id] = {accountId:account._id,customerId:customer._id};}
        if (createAccounts) {await clearPending('account',target);await save();}
      }
      const accountsReady = payerReady && matchedRecipients === ownerIds.length;
      if (createAccounts && accountsReady) {
        requireSetup(!state.pending, 'A pending creation still needs reconciliation.');
        settings.EASYGRID_PAYMENT_PROVIDER = 'nessie';
        settings.NESSIE_ALLOW_SANDBOX_TRANSFERS = enableTransfers ? 'yes' : 'no';
        await save();
      }
      const configured = Boolean(settings.NESSIE_PAYER_ACCOUNT_ID) && ownerIds.every(id => Boolean(recipients[id]));
      const ready = accountsReady && configured && !state.pending;
      return {mode:createAccounts ? 'synthetic-account-setup' : 'read-only',ready,accountsReady,configured,payerReady,ownerCount:ownerIds.length,matchedRecipients,
        missingCustomers,missingAccounts,pendingOperation:Boolean(state.pending),transfersEnabled:settings.NESSIE_ALLOW_SANDBOX_TRANSFERS === 'yes'};
    },
  };
}

function serializeEnvironment(config) {
  return Object.entries(config).map(([key,value]) => {
    requireSetup(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !/[\r\n\u0000]/.test(value), 'Private environment file has an unsupported entry.');
    if (!value.includes("'")) return `${key}='${value}'`;
    requireSetup(!value.includes('"') && !value.includes('\\'), 'Private environment file has an unsupported quoted value.');
    return `${key}="${value}"`;
  }).join('\n') + '\n';
}

export async function runNessieSetupCLI(args = process.argv.slice(2), {fetcher = fetch, acquireLock = path => open(path,'wx',0o600)} = {}) {
  const createAccounts = args.includes('--create-demo-accounts'), enableTransfers = args.includes('--enable-transfers');
  const known = args.every(arg => ['--check','--create-demo-accounts','--enable-transfers'].includes(arg) || arg.startsWith('--env-file='));
  requireSetup(known && !(args.includes('--check') && createAccounts), 'Use --check or --create-demo-accounts [--enable-transfers] [--env-file=path].');
  const envArgs = args.filter(arg => arg.startsWith('--env-file='));
  requireSetup(envArgs.length <= 1, 'Supply one private environment file.');
  const file = envArgs.length ? resolve(envArgs[0].slice('--env-file='.length)) : fileURLToPath(new URL('../.env.nessie',import.meta.url));
  requireSetup(/(?:^|[\\/])\.env(?:\.[A-Za-z0-9_-]+)?$/.test(file) && !file.endsWith('.env.example'), 'Use a private ignored .env file, not an example file.');
  const lockPath = `${file}.setup.lock`;let lock;
  if (createAccounts) {
    try {lock = await acquireLock(lockPath);} catch {throw new SetupError('Another setup may be running. Review the private setup lock before retrying.');}
  }
  try {
    // Read only after exclusion: another completed run may have saved an uncertain POST.
    let config;
    try {config = parseEnv(await readFile(file,'utf8'));} catch {throw new SetupError('The private Nessie environment file could not be loaded.');}
    const persist = async next => {
      const temporary = `${file}.tmp-${randomUUID()}`;
      try {await writeFile(temporary,serializeEnvironment(next),{mode:0o600,flag:'wx'});await rename(temporary,file);}
      finally {await unlink(temporary).catch(() => {});}
    };
    return await createNessieSetup({config,persist,fetcher}).run({createAccounts,enableTransfers});
  } finally {if (lock) {await lock.close();await unlink(lockPath);}}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runNessieSetupCLI().then(summary => console.log(JSON.stringify(summary)),error => {
    console.error(error instanceof SetupError ? error.message : 'Nessie setup stopped. Private provider details were not logged.');
    process.exitCode = 1;
  });
}
