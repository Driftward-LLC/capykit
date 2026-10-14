import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {ActionAccess} from '../src/console/action-access.js';
import {finishMutation,type AccessOptions} from '../src/console/agent-setup.js';

// Seed only the metadata and selected identity for static UI checks; browser lifecycle
// and mutation behavior remain covered by scripts/test-agent-setup.mjs.
const seed=vi.hoisted(()=>({values:[] as unknown[]}));
vi.mock('react',async importOriginal=>{
 const actual=await importOriginal<typeof import('react')>();
 return {...actual,useState:(initial:unknown)=>actual.useState(seed.values.length?seed.values.shift():initial)};
});
const principalId='11111111-1111-4111-8111-111111111111',keyId='22222222-2222-4222-8222-222222222222',connectionId='33333333-3333-4333-8333-333333333333',grantId='44444444-4444-4444-8444-444444444444';
const options:AccessOptions={
 recipients:[{id:principalId,name:'Factory',kind:'agent'}],
 keys:[{id:keyId,principalId,name:'Factory',expiresAt:'2030-06-01T00:00:00Z',status:'active'}],
 grants:[{id:grantId,recipientId:principalId,name:'Factory',actionId:'github.get-issue.v1',connectionId,repositoryIds:['7'],expiresAt:'2030-06-01T00:00:00Z',status:'active'}],
 actions:[{id:'github.get-issue.v1',app:'github',name:'Get issue',description:'Read only',fields:[],connections:[{id:connectionId,name:'Workspace account',repositories:[{id:'7',name:'acme/demo'}]}]}],
};
function render(metadata=options,states:unknown[]=[metadata,principalId]){seed.values=states;return renderToStaticMarkup(React.createElement(ActionAccess,{active:true,onSessionExpired:()=>{}}));}
afterEach(()=>{seed.values=[];finishMutation('idle');});

describe('selected-agent static hierarchy (not browser interaction coverage)',()=>{
 it('leads with the stable name and short ID, then readiness, setup, keys, access and collapsed history',()=>{
  const html=render();
  expect(html).toContain('<h1 tabindex="-1">Factory</h1>');
  expect(html).toContain('Agent · ID 11111111');
  expect(html).toContain('Missing verification is not an access denial.');
  const markers=['<h1','Client connection:','Continue setup','<h2>Keys</h2>','<h2>Allowed access</h2>','<summary>Key history</summary>'];
  let previous=-1;for(const marker of markers){const position=html.indexOf(marker);expect(position).toBeGreaterThan(previous);previous=position;}
  expect(html).toContain('<details class="agent-setup">');
  expect(html).toContain('<details class="agent-history">');
  expect(html).toContain('aria-label="Existing agent"');
  expect(html).toContain('Grant a workspace action');
  expect(html).toContain('Owner-browser read-only connection test');
 });
 it('keeps compact keys and complete access metadata without exposing a credential',()=>{
  const html=render();
  expect(html).toContain('Key ID 22222222');expect(html).toContain('Exact key details');
  expect(html).toContain('Replace this key');expect(html).toContain('Existing permissions stay the same.');
  for(const exact of [principalId,keyId,grantId,connectionId,'github.get-issue.v1','acme/demo · 7'])expect(html).toContain(exact);
  expect(html).toContain('Read only · active');expect(html).toContain('Personal-account, function and skill grants are separate.');
  expect(html).not.toContain('ck_agent_');
 });
 it('retains exact grant IDs and unavailable account/resource labels when provider metadata disappears',()=>{
  const html=render({...options,actions:[]});
  for(const exact of [grantId,connectionId,'github.get-issue.v1','Unavailable account','Unavailable repository · 7'])expect(html).toContain(exact);
  expect(html).toContain('No workspace actions available');
  expect(html).toContain('Not yet verified');
 });
 it('uses real Astryx controls and keeps exact replacement consent in a modal',()=>{
  const states=[options,principalId,'',false,'','2027-01-01T12:00','','',[],false,null,false,'',false,'','',{kind:'rotate',id:keyId,principalId},false];
  const html=render(options,states);
  for(const component of ['astryx-button','astryx-card','astryx-banner','astryx-field','astryx-dialog'])expect(html.includes(component)).toBe(true);
  expect(html.includes('aria-modal="true"')).toBe(true);
  expect(html.includes('Confirm exact key replacement')).toBe(true);
  expect(html.includes(`Only key ${keyId} stops working immediately.`)).toBe(true);
  expect(html.includes('Existing grants and unrelated keys remain unchanged.')).toBe(true);
  expect(html.includes('data-autofocus=""')).toBe(true);
 });
 it('keeps native name and expiry validation under the Astryx form controls',()=>{
  const html=render(options,[options,'','',true,'New identity']);
  const nameInput=html.match(/<input[^>]*value="New identity"[^>]*>/u)?.[0]??'';
  expect(nameInput).toContain('maxLength="80"');expect(nameInput).toContain('required=""');
  expect(html).toMatch(/<input[^>]*type="datetime-local"[^>]*required=""/u);
  expect(html).toContain('astryx-form-layout');
 });
 it('requires saving independently of copying and names the one-time key without enabling other writes',()=>{
  const states=[options,principalId,'',false,'','2027-01-01T12:00','','',[],false,{id:keyId,principalId,key:'fixture-one-time-value',expiresAt:'2027-01-01T12:00:00Z'},false,'',false,'','',null,false];
  const html=render(options,states);
  for(const copy of ['Save this key now','Factory','Key ID: '+keyId,'Select key for manual copy','I saved this key in secure secret storage.'])expect(html.includes(copy)).toBe(true);
  expect(/readonly=""/iu.test(html)).toBe(true);expect(/autocomplete="off"/iu.test(html)).toBe(true);expect(/spellcheck="false"/iu.test(html)).toBe(true);
  expect(/<button[^>]*disabled=""[^>]*>[\s\S]*?Continue after saving/u.test(html)).toBe(true);
  expect(html.includes('Create agent and key')).toBe(false);expect(html.includes('Grant action access')).toBe(false);
 });
});