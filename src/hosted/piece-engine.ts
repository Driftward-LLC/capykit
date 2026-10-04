import { readFileSync, lstatSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { ConnectionError } from './connections.js';
import { appCatalog } from './piece-catalog.js';

const oauthClient=z.object({clientId:z.string().min(1),clientSecret:z.string().min(1),callbackPath:z.enum(['/v1/connections/personal/callback','/v1/connections/google/callback']).optional()}).strict();
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
/** Only operator-selected internal endpoints, fixed REST paths and three fixed MCP tools.
 * Neither the service session nor upstream connection IDs leave the backend. */
export class PieceEngine {
 private session?:{token:string;projectId:string;mcpToken:string;expires:number};private authenticating:Promise<void>|undefined;private running=0;
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
  const mcp=await this.raw(`/api/v1/projects/${value.projectId}/mcp-server/token`,{},value.token);if(typeof mcp.mcpToken!=='string'||!mcp.mcpToken)fail();
  this.session={token:value.token,projectId:value.projectId,mcpToken:mcp.mcpToken,expires:Date.now()+45*60_000};
 }
 private async ready(){if(!this.session||this.session.expires<Date.now()){this.authenticating??=this.login().finally(()=>{this.authenticating=undefined;});await this.authenticating;}return this.session??fail();}
 async metadata(id:string):Promise<PieceMetadata>{
  const app=appCatalog().find(p=>p.id===id);if(!app)fail('NOT_FOUND',404);const session=await this.ready();
  const value=await this.raw(`/api/v1/pieces/${encodeURIComponent(app.pieceName)}`,undefined,session.token);
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
 async tool(name:'ap_run_action'|'ap_get_piece_props'|'ap_resolve_property_options',args:Record<string,unknown>){
  const session=await this.ready();if(this.running>=2)fail('CONNECTOR_BUSY',429);this.running++;const client=new Client({name:'capykit-connectors',version:'0.1.0'});
  try{await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',this.config.baseUrl),{requestInit:{headers:{authorization:`Bearer ${session.mcpToken}`}},fetch:(url,init)=>this.fetch(String(url),init)}) as Parameters<Client['connect']>[0]);
   const result=await client.callTool({name,arguments:args},undefined,{timeout:45_000});if(result.isError)fail('PROVIDER_REQUEST_FAILED');return result;
  }catch(error){if(error instanceof ConnectionError)throw error;return fail();}finally{try{await client.close();}finally{this.running--;}}
 }
}
