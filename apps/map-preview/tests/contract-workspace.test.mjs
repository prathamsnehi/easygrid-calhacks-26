// Controlled DOM behavior test. It does not prove browser layout or visual rendering.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContractWorkspace} from '../src/contract-workspace.js';
import {createContractExample} from '../src/contract-fixtures.js';
import {createContractWorkflow,createDemoBank,DEMO_ACTORS} from '../server/contract-workflow.mjs';

function boot({saved = new Map(), workflow = null, apiOverride = null} = {}) {
  const nodes = new Map();
  class Element {
    constructor(id, tag = '') {this.id=id;this.hidden=/\shidden(?:\s|>)/.test(tag);this.disabled=/\sdisabled(?:\s|>)/.test(tag);this.value='';this.textContent='';this.innerHTML='';this.className='';this.children=[];this.listeners=new Map();this.attributes={};}
    addEventListener(type,callback){this.listeners.set(type,callback);}
    setAttribute(name,value){this.attributes[name]=value;}
    focus(){document.activeElement=this;}
    appendChild(child){this.children.push(child);}
    replaceChildren(...children){this.children=children;}
    async emit(type){return this.listeners.get(type)?.({preventDefault(){},target:this});}
  }
  const markup = readFileSync(new URL('../src/contract-workspace.html',import.meta.url),'utf8');
  for (const match of markup.matchAll(/<[a-z][^>]*\bid="([^"]+)"[^>]*>/g)) nodes.set(match[1],new Element(match[1],match[0]));
  const original = globalThis.document;
  globalThis.document = {activeElement:null,querySelector:selector => nodes.get(selector.slice(1)) ?? null,createElement:tag => new Element('',tag)};
  const flow = workflow ?? createContractWorkflow({source:createContractExample(),bank:createDemoBank()});
  const api = async (operation,draft,extra) => {
    if (operation === 'state') return flow.inspect(draft);
    if (operation.startsWith('sign/')) {const side=operation.split('/')[1];return flow.sign(draft,side,DEMO_ACTORS[side]);}
    if (operation === 'submit') return flow.submit(draft,DEMO_ACTORS.requester,extra);
    if (operation === 'construction-complete') return flow.completeConstruction(draft,extra.completion,DEMO_ACTORS.construction);
    if (operation === 'reconcile') return flow.reconcile(draft,DEMO_ACTORS.requester,extra);
    return flow.reject(draft,DEMO_ACTORS.utility,extra);
  };
  const app = createContractWorkspace({storage:{getItem:key => saved.get(key) ?? null,setItem:(key,value) => saved.set(key,value)},api:apiOverride ?? api});
  return {app,nodes,saved,flow,restore:() => {globalThis.document=original;},flush:() => new Promise(done => setImmediate(done)),
    click:async id => {if(!nodes.get(id).disabled)await nodes.get(id).emit('click');}};
}

test('approval gate, authoring, both click signatures, submission and restored payment work through the UI controller', async () => {
  const ui = boot();
  try {
    ui.app.open(createContractExample('pending'),{demo:true}); assert.equal(ui.nodes.get('cg-proceed').disabled,true);
    ui.app.setSource(createContractExample()); assert.equal(ui.nodes.get('cg-proceed').disabled,false);
    await ui.click('cg-proceed'); await ui.flush();
    assert.equal(ui.nodes.get('cg-editor').hidden,false); assert(ui.nodes.get('cg-preview').innerHTML.includes('$2,400.00'));
    assert.equal(ui.nodes.get('cg-submit').disabled,true);
    await ui.click('cg-sign-utility'); assert.equal(ui.nodes.get('cg-submit').disabled,true);
    await ui.click('cg-sign-landowner'); assert.equal(ui.nodes.get('cg-submit').disabled,true);
    ui.nodes.get('cg-parcel').value='P-009'; await ui.nodes.get('cg-parcel').emit('change'); await ui.flush();
    await ui.click('cg-sign-utility'); await ui.click('cg-sign-landowner');
    ui.nodes.get('cg-parcel').value='P-004'; await ui.nodes.get('cg-parcel').emit('change'); await ui.flush();
    assert.equal(ui.nodes.get('cg-submit').disabled,false);
    await ui.click('cg-submit'); assert(ui.nodes.get('cg-execution-status').textContent.includes('payment complete'));
    assert.equal(ui.nodes.get('cg-submit').disabled,true); assert.equal(ui.nodes.get('cg-notes').disabled,true);
    assert(ui.nodes.get('cg-journal-summary').textContent.includes('$2,400.00'));
    assert.equal(ui.flow.snapshot().journal.length,1);
    let run = null, complete = null, notices = 0;
    ui.app.setConstructionHandler(({construction,onComplete}) => {run=construction;complete=onComplete;notices++;});
    assert.equal(ui.nodes.get('cg-pay-balance').disabled,true);
    ui.nodes.get('cg-parcel').value='P-009'; await ui.nodes.get('cg-parcel').emit('change'); await ui.flush();
    await ui.click('cg-submit');
    assert.equal(notices,1); assert.equal(run.status,'in-progress');
    assert.equal(ui.nodes.get('cg-pay-balance').disabled,true);
    await complete();
    assert.equal(ui.nodes.get('cg-pay-balance').disabled,false);
    assert.equal(ui.flow.snapshot().journal.length,2);
    await ui.click('cg-pay-balance');
    assert.equal(ui.nodes.get('cg-pay-balance').disabled,true);
    assert.equal(ui.flow.snapshot().journal.length,3);
    assert.equal(notices,1);
  } finally {ui.restore();}
});

test('editing invalidates signatures, parcel switches preserve edits, and source changes lock open drafts', async () => {
  const ui = boot();
  try {
    ui.app.open(createContractExample(),{demo:true}); await ui.click('cg-proceed'); await ui.flush();
    await ui.click('cg-sign-utility'); await ui.click('cg-sign-landowner'); assert.equal(ui.nodes.get('cg-submit').disabled,true);
    ui.nodes.get('cg-notes').value='Review this draft note.'; await ui.nodes.get('cg-notes').emit('input');
    assert.equal(ui.nodes.get('cg-submit').disabled,true); assert.equal(ui.nodes.get('cg-utility-signature-status').textContent,'Sign ↗');
    ui.nodes.get('cg-parcel').value='P-009'; await ui.nodes.get('cg-parcel').emit('change'); await ui.flush();
    ui.nodes.get('cg-parcel').value='P-004'; await ui.nodes.get('cg-parcel').emit('change'); await ui.flush();
    assert.equal(ui.nodes.get('cg-notes').value,'Review this draft note.');
    ui.app.invalidate(); assert.equal(ui.nodes.get('cg-submit').disabled,true); assert.equal(ui.nodes.get('cg-download').disabled,true);
  } finally {ui.restore();}
});

test('handler resolution never unlocks the balance and invalidation aborts late construction callbacks', async () => {
  const ui = boot();
  try {
    let signal, complete, notices = 0;
    const handler = input => {signal=input.signal;complete=input.onComplete;notices++;return Promise.resolve();};
    ui.app.setConstructionHandler(handler);
    ui.app.open(createContractExample(),{demo:true}); await ui.click('cg-proceed'); await ui.flush();
    await ui.click('cg-sign-utility'); await ui.click('cg-sign-landowner');
    ui.nodes.get('cg-parcel').value='P-009'; await ui.nodes.get('cg-parcel').emit('change'); await ui.flush();
    await ui.click('cg-sign-utility'); await ui.click('cg-sign-landowner'); await ui.click('cg-submit');
    ui.nodes.get('cg-parcel').value='P-004'; await ui.nodes.get('cg-parcel').emit('change'); await ui.flush();
    await ui.click('cg-submit'); await ui.flush();
    assert.equal(notices,1); assert.equal(ui.nodes.get('cg-pay-balance').disabled,true);
    ui.app.setConstructionHandler(handler); assert.equal(notices,1);
    ui.app.invalidate(); assert.equal(signal.aborted,true);
    await assert.rejects(complete(),/context changed/);
    assert.equal(ui.nodes.get('cg-pay-balance').disabled,true);
    assert.equal(ui.flow.snapshot().construction.status,'in-progress');
  } finally {ui.restore();}
});

test('a late signature response cannot re-enable submission after the source approval is revoked', async () => {
  let resolveSignature;
  const ui = boot({apiOverride:async (operation,draft) => {
    if(operation === 'state')return {draftId:draft.id,documentHash:'a'.repeat(64),signatures:{},audit:[],journal:[],bankMode:'simulation'};
    return new Promise(resolve => {resolveSignature=resolve;});
  }});
  try {
    ui.app.open(createContractExample(),{demo:true}); await ui.click('cg-proceed'); await ui.flush();
    const pending = ui.click('cg-sign-utility'); await ui.flush(); ui.app.invalidate();
    resolveSignature({signatures:{utility:{simulated:true,signedAt:'2026-10-24T18:00:00Z'},landowner:{simulated:true,signedAt:'2026-10-24T18:00:00Z'}},audit:[],journal:[],bankMode:'simulation'});
    await pending; assert.equal(ui.nodes.get('cg-submit').disabled,true); assert.equal(ui.nodes.get('cg-stale').hidden,false);
  } finally {ui.restore();}
});
