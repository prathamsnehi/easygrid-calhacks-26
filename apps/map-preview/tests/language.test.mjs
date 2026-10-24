import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const appRoot=new URL('../',import.meta.url);
const hangul=/\p{Script=Hangul}/u;

test('all map source text stays in English',()=>{
  const sourceRoot=new URL('src/',appRoot);
  const files=readdirSync(sourceRoot).filter(name=>/\.(?:js|html|css)$/.test(name));
  for(const name of files){
    const source=readFileSync(new URL(name,sourceRoot),'utf8');
    assert.doesNotMatch(source,hangul,`${name} contains Korean text; map information must remain English.`);
  }
  const template=readFileSync(new URL('index.html',sourceRoot),'utf8');
  assert.match(template,/<html\s+lang="en"/);
});

test('the delivered map and parcel export contain English-only UI and fixture text',()=>{
  const html=readFileSync(new URL('dist/index.html',appRoot),'utf8');
  const fixtures=readFileSync(new URL('dist/parcel-fixtures.json',appRoot),'utf8');
  assert.match(html,/<html\s+lang="en"/);
  assert.doesNotMatch(html,hangul,'Build output contains Korean map text.');
  assert.doesNotMatch(fixtures,hangul,'Parcel export contains Korean fixture text.');
  for(const owner of JSON.parse(fixtures).owners){
    assert.match(owner.phoneDisplay,/\bdemo\b/);
  }
});
