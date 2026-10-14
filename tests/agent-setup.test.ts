import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,describe,expect,it} from 'vitest';
import {ActionAccess} from '../src/console/action-access.js';
import {accessOptions,issuedKey,localExpiry,expiryIso,validScope,identityLabel,beginMutation,finishMutation,mutationSnapshot,subscribeMutations,setupInstructions} from '../src/console/agent-setup.js';
import type {Action} from '../src/console/actions.js';
const principalId='11111111-1111-4111-8111-111111111111',keyId='22222222-2222-4222-8222-222222222222',oldId='33333333-3333-4333-8333-333333333333';
const expiresAt='2030-06-01T00:00:00.000Z',key=`ck_agent_${'a'.repeat(43)}`;
const response={id:keyId,principalId,key,expiresAt};
const action:Action={id:'github.get-issue.v1',app:'github',name:'Get issue',description:'Read only',fields:[],connections:[{id:oldId,name:'Workspace account',repositories:[{id:'7',name:'owner/repo'}]}]};
const options={recipients:[{id:principalId,name:'Assistant',kind:'agent'}],keys:[{id:keyId,principalId,name:'Assistant',expiresAt,status:'active'}],grants:[{id:oldId,recipientId:principalId,name:'Assistant',actionId:action.id,connectionId:oldId,repositoryIds:['7'],expiresAt,status:'active'}],actions:[action]};
afterEach(()=>{finishMutation('idle');});
describe('agent setup security boundaries',()=>{
 it('accepts only native key responses bound to the requested identity and expiry',()=>{
  expect(issuedKey(response,expiresAt,principalId,oldId)).toEqual(response);
  for(const malformed of [null,{}, {...response,key:undefined},{...response,key:'ck_agent_short'},{...response,key:`${key}\n`},{...response,id:oldId},{...response,principalId:keyId},{...response,expiresAt:'2030-07-01T00:00:00Z'},{...response,id:'not-an-id'}])expect(issuedKey(malformed,expiresAt,principalId,oldId)).toBeNull();
  expect(issuedKey(response,expiresAt)).toEqual(response);
 });
 it('does not release the synchronous pending lock when views unsubscribe or another view returns',()=>{
  const phases:string[]=[],unsubscribe=subscribeMutations(()=>phases.push(mutationSnapshot().phase));
  expect(beginMutation()).toBe(true);expect(beginMutation()).toBe(false);expect(beginMutation(true)).toBe(false);
  unsubscribe();expect(mutationSnapshot().phase).toBe('pending');
  const returned:string[]=[],off=subscribeMutations(()=>returned.push(mutationSnapshot().phase));
  finishMutation('uncertain');expect(returned).toEqual(['uncertain']);expect(phases).toEqual(['pending']);off();
  expect(beginMutation()).toBe(false);expect(beginMutation(true)).toBe(true);finishMutation('uncertain');expect(beginMutation()).toBe(false);
  expect(beginMutation(true)).toBe(true);finishMutation('idle');expect(beginMutation()).toBe(true);
 });
 it('requires complete metadata before reconciliation, including recipient IDs on grants',()=>{
  expect(accessOptions(options)).toEqual(options);
  for(const malformed of [null,{}, {...options,recipients:null},{...options,keys:[{...options.keys[0],principalId:''}]},{...options,grants:[{...options.grants[0],recipientId:undefined}]},{...options,actions:[{...action,connections:[{}]}]},{...options,keys:[{...options.keys[0],status:'unknown'}]}])expect(accessOptions(malformed)).toBeNull();
 });
 it('disambiguates duplicate names with complete native principal IDs',()=>{
  const first={id:principalId,name:'Assistant',kind:'agent'};
  expect(identityLabel(first)).toContain(principalId);expect(identityLabel({...first,id:keyId})).not.toEqual(identityLabel(first));
 });
 it('validates exact connected-account repository scope and rejects duplicates and stale choices',()=>{
  expect(validScope(action,oldId,['7'])).toBe(true);
  for(const ids of [[],['7','7'],['8'],['7','8']])expect(validScope(action,oldId,ids)).toBe(false);
  expect(validScope(action,keyId,['7'])).toBe(false);expect(validScope(undefined,oldId,['7'])).toBe(false);
  const drive={...action,app:'google-drive' as const};expect(validScope(drive,oldId,[])).toBe(true);expect(validScope(drive,oldId,['7'])).toBe(false);
 });
 it('validates future expiry within the native one-year bound and rejects normalized invalid dates',()=>{
  const now=Date.parse('2029-01-01T00:00:00Z');
  expect(expiryIso(localExpiry(30,now),now)).not.toBeNull();
  for(const value of ['', 'not-a-date','2029-02-31T12:00',localExpiry(0,now),localExpiry(366,now)])expect(expiryIso(value,now)).toBeNull();
 });
 it('keeps setup snippets placeholder-only with separate workspace/personal tool mappings',()=>{
  const copy=JSON.stringify(setupInstructions);expect(copy).not.toContain(key);expect(copy).not.toContain(principalId);
  expect(setupInstructions.environment).toContain('<SAVED_AGENT_KEY>');expect(setupInstructions.workspace).toContain('run_action({id:');expect(setupInstructions.workspace).not.toContain('actionId');
  expect(setupInstructions.personal).toContain('run_connection_action({connectionId:');expect(setupInstructions.personal).toContain('action: "<ACTION_NAME>"');
 });
});
describe('agent management initial SSR copy (not browser interaction coverage)',()=>{
 it('requires metadata before creation, offers ID-based discovery, and never claims client verification',()=>{
  const html=renderToStaticMarkup(React.createElement(ActionAccess,{active:true,onSessionExpired:()=>{}}));
  expect(html).toContain('Find an existing agent by name or ID');expect(html).toContain('Reload metadata');expect(html).toContain('Client status: Not yet verified');expect(html).toContain('Identity, keys, action grants and client setup are separate');expect(html).not.toContain('ck_agent_');expect(html).not.toContain('localStorage');
 });
 it('supports scoped app copy and renders no controls while inactive',()=>{
  expect(renderToStaticMarkup(React.createElement(ActionAccess,{active:true,app:'github',onSessionExpired:()=>{}}))).toContain('GitHub agent access');
  const html=renderToStaticMarkup(React.createElement(ActionAccess,{active:false,onSessionExpired:()=>{}}));expect(html).not.toContain('button');expect(html).not.toContain('input');expect(html).not.toContain('ck_agent_');
 });
});
