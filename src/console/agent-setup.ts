import type {Action} from './actions.js';

export interface Recipient {id:string;name:string;kind:string;}
export interface AgentKey {id:string;principalId:string;name:string;expiresAt:string;status:string;}
export interface ActionGrant {id:string;recipientId:string;name:string;actionId:string;connectionId:string;repositoryIds:string[];expiresAt:string;status:string;}
export interface AccessOptions {actions:Action[];recipients:Recipient[];keys:AgentKey[];grants:ActionGrant[];}
export interface IssuedKey {id:string;principalId:string;key:string;expiresAt:string;}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const id=(value:unknown):value is string=>typeof value==='string'&&uuid.test(value);
const text=(value:unknown):value is string=>typeof value==='string';
const date=(value:unknown):value is string=>text(value)&&Number.isFinite(Date.parse(value));
const status=(value:unknown)=>value==='active'||value==='expired'||value==='revoked';
export function accessOptions(value:unknown):AccessOptions|null {
 if(!record(value)||!Array.isArray(value.recipients)||!Array.isArray(value.keys)||!Array.isArray(value.grants)||!Array.isArray(value.actions))return null;
 if(!value.recipients.every(r=>record(r)&&id(r.id)&&text(r.name)&&text(r.kind)))return null;
 if(!value.keys.every(k=>record(k)&&id(k.id)&&id(k.principalId)&&text(k.name)&&date(k.expiresAt)&&status(k.status)))return null;
 if(!value.grants.every(g=>record(g)&&id(g.id)&&id(g.recipientId)&&text(g.name)&&text(g.actionId)&&id(g.connectionId)&&Array.isArray(g.repositoryIds)&&g.repositoryIds.every(text)&&date(g.expiresAt)&&status(g.status)))return null;
 if(!value.actions.every(a=>record(a)&&text(a.id)&&text(a.name)&&text(a.description)&&(a.app==='github'||a.app==='google-drive')&&Array.isArray(a.fields)&&a.fields.every(f=>record(f)&&text(f.key)&&text(f.name)&&text(f.description)&&typeof f.required==='boolean'&&(f.type==='text'||f.type==='number'))&&Array.isArray(a.connections)&&a.connections.every(c=>record(c)&&id(c.id)&&text(c.name)&&Array.isArray(c.repositories)&&c.repositories.every(r=>record(r)&&text(r.id)&&text(r.name)))))return null;
 return value as unknown as AccessOptions;
}
export function issuedKey(value:unknown,expiresAt:string,principalId?:string,rotateKeyId?:string):IssuedKey|null {
 if(!record(value)||!id(value.id)||!id(value.principalId)||!text(value.key)||!/^ck_agent_[A-Za-z0-9_-]{43}$/u.test(value.key)||!date(value.expiresAt)||Date.parse(value.expiresAt)!==Date.parse(expiresAt)||(principalId!==undefined&&value.principalId!==principalId)||value.id===rotateKeyId)return null;
 return {id:value.id,principalId:value.principalId,key:value.key,expiresAt:value.expiresAt};
}
export function localExpiry(days=30,now=Date.now()):string {const d=new Date(now+days*86400000);d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,16);}
export function expiryIso(value:string,now=Date.now()):string|null {
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value))return null;
 const d=new Date(value),time=d.getTime();if(!Number.isFinite(time)||time<=now+1000||time>now+365*86400000)return null;
 const local=new Date(time);local.setMinutes(local.getMinutes()-local.getTimezoneOffset());return local.toISOString().slice(0,16)===value?d.toISOString():null;
}
export function validScope(action:Action|undefined,connectionId:string,repositoryIds:string[]):boolean {
 const connection=action?.connections.find(c=>c.id===connectionId);if(!action||!connection)return false;
 return action.app==='google-drive'?repositoryIds.length===0:repositoryIds.length>0&&new Set(repositoryIds).size===repositoryIds.length&&repositoryIds.every(id=>connection.repositories.some(r=>r.id===id));
}
export const identityLabel=(recipient:Recipient):string=>`${recipient.id.slice(0,8)} · ${recipient.name} · ${recipient.kind} · ${recipient.id}`;

// ponytail: one browser-wide UI mutation gate; partition by workspace if simultaneous workspace views are introduced. No authority or secrets live here.
type Phase='idle'|'pending'|'uncertain';
let snapshot={phase:'idle' as Phase,revision:0};
const listeners=new Set<()=>void>();
export const mutationSnapshot=()=>snapshot;
export function subscribeMutations(listener:()=>void):()=>void {listeners.add(listener);return()=>{listeners.delete(listener);};}
export function beginMutation(reconcile=false):boolean {if(snapshot.phase==='pending'||(snapshot.phase==='uncertain'&&!reconcile))return false;finishMutation('pending');return true;}
export function finishMutation(phase:Phase):void {snapshot={phase,revision:snapshot.revision+1};for(const listener of listeners)listener();}

export const setupInstructions={
 environment:'CAPYKIT_BASE_URL=<CAPYKIT_HTTPS_ORIGIN>\nCAPYKIT_API_KEY=<SAVED_AGENT_KEY>\ncapykit-mcp --remote',
 workspace:'list_actions({})\nget_action({id: "<ACTION_ID>"})\nrun_action({id: "<ACTION_ID>", connectionId: "<CONNECTION_ID>", input: {"<INPUT_FIELD>": "<VALUE>"}})',
 personal:'list_connections({})\nlist_connection_actions({connectionId: "<PERSONAL_CONNECTION_ID>"})\nrun_connection_action({connectionId: "<PERSONAL_CONNECTION_ID>", action: "<ACTION_NAME>", input: {"<INPUT_FIELD>": "<VALUE>"}})',
};
