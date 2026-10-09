import { readFileSync, lstatSync } from 'node:fs';
import { z } from 'zod';
import { ConnectionError } from './connections.js';
import { appCatalog } from './piece-catalog.js';

const oauthClient=z.object({clientId:z.string().min(1),clientSecret:z.string().min(1),allowedProps:z.record(z.string(),z.array(z.union([z.string(),z.number(),z.boolean()])).min(1)).default({}),callbackPath:z.enum(['/v1/connections/personal/callback','/v1/connections/google/callback']).optional()}).strict();
const configSchema=z.object({baseUrl:z.url(),email:z.email(),password:z.string().min(16),encryptionKey:z.string(),oauthClients:z.record(z.string(),oauthClient).default({})}).strict();
export type PieceEngineConfig=z.infer<typeof configSchema>;
export type PieceMetadata={name:string;version:string;auth:Record<string,unknown>|Record<string,unknown>[]|null;actions:Record<string,{name:string;displayName:string;description?:string;requireAuth?:boolean;props:Record<string,unknown>}>};
function fail(code='CONNECTOR_FAILED',status=502):never{throw new ConnectionError(code,status);}
export function loadPieceEngineConfig(path:string|undefined):PieceEngineConfig|undefined {
 if(!path)return undefined;const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077)!==0)||stat.size>128*1024)fail('CONFIGURATION_UNAVAILABLE',503);
 const result=configSchema.safeParse(JSON.parse(readFileSync(path,'utf8')));if(!result.success)fail('CONFIGURATION_UNAVAILABLE',503);
 const config=result.data,url=new URL(config.baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')fail('CONFIGURATION_UNAVAILABLE',503);
 const key=Buffer.from(config.encryptionKey,'base64');if(key.length!==32||key.toString('base64')!==config.encryptionKey)fail('CONFIGURATION_UNAVAILABLE',503);
 return config;
}
/** Only operator-selected internal endpoints, fixed REST paths and server-built disabled drafts.
 * Neither the service session nor upstream connection IDs leave the backend. */
export class PieceEngine {
 private session?:{token:string;projectId:string;expires:number};private authenticating:Promise<void>|undefined;private running=0;
 constructor(readonly config:PieceEngineConfig){}
 private async fetch(url:URL|string,init:RequestInit={}):Promise<Response>{
  let response:Response;try{response=await fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(45_000)});}catch{return fail('PROVIDER_UNAVAILABLE');}
  if([204,205,304].includes(response.status))return response;const reader=response.body?.getReader();if(!reader)fail();const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024*1024)fail('CONNECTOR_RESULT_LIMIT');chunks.push(value);}}finally{await reader.cancel();}
  return new Response(Buffer.concat(chunks),{status:response.status,headers:response.headers});
 }
 private async raw(path:string,body?:unknown,token?:string):Promise<Record<string,unknown>>{
  const response=await this.fetch(new URL(path,this.config.baseUrl),{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)fail(response.status===401?'PROVIDER_AUTHORIZATION_EXPIRED':'PROVIDER_REQUEST_FAILED');
  try{const value:unknown=await response.json();if(!value||typeof value!=='object'||Array.isArray(value))fail();return value as Record<string,unknown>;}catch{return fail();}
 }
 private async login():Promise<void>{
  const value=await this.raw('/api/v1/authentication/sign-in',{email:this.config.email,password:this.config.password});
  if(typeof value.token!=='string'||typeof value.projectId!=='string'||!value.token||!/^[A-Za-z0-9_-]{1,80}$/u.test(value.projectId))fail();
  this.session={token:value.token,projectId:value.projectId,expires:Date.now()+45*60_000};
 }
 private async ready(){if(!this.session||this.session.expires<Date.now()){this.authenticating??=this.login().finally(()=>{this.authenticating=undefined;});await this.authenticating;}return this.session??fail();}
 async metadata(id:string):Promise<PieceMetadata>{
  const app=appCatalog().find(p=>p.id===id);if(!app)fail('NOT_FOUND',404);const session=await this.ready();
  const value=await this.raw(`/api/v1/pieces/${encodeURIComponent(app.pieceName)}?version=${encodeURIComponent(app.version)}`,undefined,session.token);
  if(value.name!==app.pieceName||value.version!==app.version||!value.actions||typeof value.actions!=='object'||Array.isArray(value.actions))fail('CONNECTOR_VERSION_UNAVAILABLE',409);
  return value as PieceMetadata;
 }
 async connect(piece:PieceMetadata,externalId:string,name:string,value:Record<string,unknown>):Promise<string>{
  const session=await this.ready();const data=await this.raw('/api/v1/app-connections',{projectId:session.projectId,pieceName:piece.name,pieceVersion:piece.version,externalId,displayName:name,type:value.type,value},session.token);
  if(typeof data.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/u.test(data.id)||data.status!=='ACTIVE')fail('PROVIDER_CREDENTIALS_INVALID',400);return data.id;
 }
 async authorization(piece:PieceMetadata,redirectUrl:string,props:Record<string,unknown>){
  const client=this.config.oauthClients[piece.name];if(!client)fail('PROVIDER_SETUP_REQUIRED',503);const session=await this.ready();
  const value=await this.raw('/api/v1/app-connections/oauth2/authorization-url',{pieceName:piece.name,pieceVersion:piece.version,projectId:session.projectId,clientId:client.clientId,redirectUrl,props},session.token);
  if(typeof value.authorizationUrl!=='string'||(value.codeVerifier!==undefined&&typeof value.codeVerifier!=='string'))fail();
  const url=new URL(value.authorizationUrl);if(url.protocol!=='https:'||url.username||url.password)fail();
  return {url,verifier:typeof value.codeVerifier==='string'?value.codeVerifier:undefined};
 }
 async disconnect(id:string){const session=await this.ready();const response=await this.fetch(new URL(`/api/v1/app-connections/${encodeURIComponent(id)}`,this.config.baseUrl),{method:'DELETE',headers:{authorization:`Bearer ${session.token}`}});if(!response.ok&&response.status!==404)fail('PROVIDER_REQUEST_FAILED');}
 private async temporaryFlow<T>(piece:PieceMetadata,name:string,input:Record<string,unknown>,externalId:string,fn:(session:{token:string;projectId:string},flow:Record<string,unknown>)=>Promise<T>):Promise<T>{
  const session=await this.ready();if(this.running>=2)fail('CONNECTOR_BUSY',429);this.running++;let flowId:string|undefined;
  try{const flow=await this.raw('/api/v1/flows',{projectId:session.projectId,displayName:'Capykit private action'},session.token);if(typeof flow.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/u.test(flow.id)||flow.status!=='DISABLED')fail();flowId=flow.id;
   const version=flow.version as {trigger?:{name?:string}};if(typeof version.trigger?.name!=='string')fail();
   const action={name:'capykit_action',displayName:'Capykit action',type:'PIECE',valid:true,settings:{pieceName:piece.name,pieceVersion:piece.version,actionName:name,input:{...input,auth:`{{connections['${externalId}']}}`},propertySettings:{},errorHandlingOptions:{continueOnFailure:{value:false},retryOnFailure:{value:false}}}};
   const populated=await this.raw(`/api/v1/flows/${flowId}`,{type:'ADD_ACTION',request:{parentStep:version.trigger.name,stepLocationRelativeToParent:'AFTER',action}},session.token);
   const saved=populated.version as {trigger?:{nextAction?:{settings?:{pieceVersion?:string}}}};
   if(populated.status!=='DISABLED'||saved.trigger?.nextAction?.settings?.pieceVersion!==piece.version)fail('CONNECTOR_VERSION_UNAVAILABLE',409);
   return await fn(session,populated);
  }finally{try{if(flowId){const response=await this.fetch(new URL(`/api/v1/flows/${flowId}`,this.config.baseUrl),{method:'DELETE',headers:{authorization:`Bearer ${session.token}`}});if(!response.ok&&response.status!==404)fail('CONNECTOR_CLEANUP_FAILED');}}finally{this.running--;}}
 }
 async runAction(piece:PieceMetadata,name:string,input:Record<string,unknown>,externalId:string,authorize:()=>Promise<unknown>){return this.temporaryFlow(piece,name,input,externalId,async(session,flow)=>{
  const version=flow.version as {id:string};await authorize();const started=await this.raw('/api/v1/sample-data/test-step',{projectId:session.projectId,flowVersionId:version.id,stepName:'capykit_action'},session.token);if(typeof started.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/u.test(started.id))fail();
  const deadline=Date.now()+35_000;for(;;){const run=await this.raw(`/api/v1/flow-runs/${started.id}?projectId=${encodeURIComponent(session.projectId)}`,undefined,session.token);
   if(run.status==='SUCCEEDED'){const steps=run.steps as Record<string,{output?:unknown}>;return {content:[{type:'text',text:JSON.stringify(steps.capykit_action?.output??null)}]};}
   if(!['QUEUED','RUNNING'].includes(String(run.status))||Date.now()>deadline)fail('PROVIDER_REQUEST_FAILED');await new Promise(resolve=>setTimeout(resolve,500));
  }
 });}
 async fields(piece:PieceMetadata,name:string,input:Record<string,unknown>,externalId:string,authorize:()=>Promise<unknown>){const props=piece.actions[name]?.props??{};if(!Object.values(props).some(p=>p&&typeof p==='object'&&['DROPDOWN','MULTI_SELECT_DROPDOWN','DYNAMIC'].includes(String((p as {type:unknown}).type))))return props;
  return this.temporaryFlow(piece,name,input,externalId,async(session,flow)=>{const version=flow.version as {id:string};const resolved={...props};
   for(const [propertyName,raw] of Object.entries(props)){const p=raw as {type?:string;refreshers?:string[]};if(!p.type||!['DROPDOWN','MULTI_SELECT_DROPDOWN','DYNAMIC'].includes(p.type)||(p.refreshers??[]).some(key=>key!=='auth'&&input[key]===undefined))continue;
    await authorize();const data=await this.raw('/api/v1/pieces/options',{projectId:session.projectId,flowId:flow.id,flowVersionId:version.id,pieceName:piece.name,pieceVersion:piece.version,actionOrTriggerName:name,propertyName,input:{...input,auth:`{{connections['${externalId}']}}`}},session.token);
    if(data.status==='OK')resolved[propertyName]={...(raw as Record<string,unknown>),...(p.type==='DYNAMIC'?{dynamicFields:data.result}:{options:data.result})};
   }return resolved;
  });
 }
}
