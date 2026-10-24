import test from 'node:test';
import assert from 'node:assert/strict';
import { NessieSandbox } from '../src/nessie-sandbox.ts';

test('Nessie read-only client sends authenticated sandbox request, never payment', async () => {
  const requests: {url:string;method?:string}[]=[];
  const fakeFetch: typeof fetch = async (input,init) => {
    requests.push({url:String(input),method:init?.method});
    return new Response(JSON.stringify([{_id:'a1',balance:100}]),{status:200});
  };
  const client=new NessieSandbox('test-only-key',fakeFetch,'http://127.0.0.1:3000');
  const accounts=await client.accounts();
  assert.equal(accounts[0]._id,'a1');
  await client.deposits('a1');
  await client.withdrawals('a1');
  assert.equal(requests.length,3);
  assert.ok(requests.every(r=>r.method==='GET'));
  assert.match(requests[0].url,/\/accounts\?key=test-only-key/);
  assert.match(requests[1].url,/\/accounts\/a1\/deposits/);
});
test('Nessie credentials and errors fail closed without leaking secrets', async () => {
  assert.throws(()=>new NessieSandbox(''),/NESSIE_API_KEY/);
  const failing: typeof fetch = async () => new Response('bad key',{status:401});
  const client=new NessieSandbox('private-secret',failing);
  await assert.rejects(()=>client.accounts(),/HTTP 401/);
});
