import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CAPYKIT_VERSION } from '../core/index.js';

export function createRemoteActionServer(env:NodeJS.ProcessEnv=process.env):McpServer {
 const suppliedKey=env.CAPYKIT_API_KEY;
 if(!suppliedKey||!/^ck_agent_[A-Za-z0-9_-]{43}$/u.test(suppliedKey))throw new Error('Set CAPYKIT_API_KEY to the agent key issued in Capykit Access.');
 const key=suppliedKey;
 let base:URL;try{base=new URL(env.CAPYKIT_BASE_URL??'');}catch{throw new Error('Set CAPYKIT_BASE_URL to your Capykit HTTPS origin.');}
 const local=base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname)&&env.CAPYKIT_ALLOW_INSECURE_LOCALHOST==='true';
 if((base.protocol!=='https:'&&!local)||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw new Error('CAPYKIT_BASE_URL must be an HTTPS origin without credentials, query, or path.');
 const server=new McpServer({name:'capykit-remote-actions',version:CAPYKIT_VERSION});
 async function request(path:string,input?:unknown):Promise<Record<string,unknown>> {
  const response=await fetch(new URL(path,base),{method:input===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(25_000),headers:{authorization:`Bearer ${key}`,...(input===undefined?{}:{'content-type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});
  if(!response.ok) {
   const errors:Record<number,string>={400:'Check the action inputs.',401:'The Capykit agent key expired or was revoked.',403:'This agent does not have current access to that action and connection.',404:'That action or connection is unavailable.',429:'Capykit is busy. Try again shortly.'};
   throw new Error(errors[response.status]??'Capykit could not run the action.');
  }
  if(!response.body)throw new Error('Invalid Capykit response.');
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>1024*1024)throw new Error('Capykit response exceeded the limit.');chunks.push(next.value);}}finally{await reader.cancel();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>;
 }
 async function call(run:()=>Promise<Record<string,unknown>>) {
  try{const result=await run();return {structuredContent:result,content:[{type:'text' as const,text:JSON.stringify(result)}]};}
  catch(error){const message=error instanceof Error&&/^(Check the action|The Capykit agent|This agent|That action|Capykit (is busy|could not|response exceeded)|Invalid Capykit)/u.test(error.message)?error.message:'Capykit could not complete the request.';return {isError:true,content:[{type:'text' as const,text:message}]};}
 }
 server.registerTool('list_actions',{description:'Discover your currently granted connected-app actions, their input schemas and connection/repository choices. No provider credentials are returned.',inputSchema:{app:z.enum(['github','google-drive']).optional()}},async({app})=>call(async()=>{const result=await request('/v1/actions');const actions=result.actions as {app:string}[];return {actions:app?actions.filter(a=>a.app===app):actions};}));
 server.registerTool('get_action',{description:'Get the input schema and authorized connections for an action. Availability is checked again on every call.',inputSchema:{id:z.string().max(100)}},async({id})=>call(async()=>{const result=await request('/v1/actions');const action=(result.actions as {id:string}[]).find(a=>a.id===id);if(!action)throw new Error('That action or connection is unavailable.');return {action};}));
 server.registerTool('run_action',{description:'Run a granted read-only connector action through Capykit. Supply an exact action ID, connection ID and inputs from get_action. Does not execute uploaded code.',inputSchema:{id:z.enum(['github.get-issue.v1','drive.get-file.v1','drive.find-files.v1','drive.list-folder.v1']),connectionId:z.uuid(),input:z.record(z.string(),z.unknown())},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}},async({id,connectionId,input})=>call(()=>request(`/v1/actions/${id}/run`,{connectionId,input})));
 return server;
}
