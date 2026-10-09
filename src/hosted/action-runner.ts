import { ActionAccess } from './action-access.js';
import { driveFields, driveQuery, getAction, validateAction } from './actions.js';
import { ConnectionError, ConnectionStore } from './connections.js';
import { GoogleConnections } from './google.js';
import { runConnector } from './activepieces.js';
import { providerJson } from './provider-http.js';
import type { AuthenticatedContext } from './identity.js';

export async function runAction(access:ActionAccess,connections:ConnectionStore,drive:GoogleConnections,context:AuthenticatedContext,actionId:string,connectionId:string,rawInput:unknown) {
 const action=getAction(actionId);const input=validateAction(actionId,rawInput);
 const bound=await access.bind(context,actionId,connectionId,typeof input.repositoryId==='string'?input.repositoryId:undefined);
 const check=()=>access.check(context,bound);
 await access.event(context,'run_started',bound);
 try {
  await check();
  let result:Record<string,unknown>;
  if(action.app==='github') {
   result=await connections.withInstallationToken({workspaceId:context.membership.workspaceId,connectionId,repositoryIds:[String(input.repositoryId)],permission:'github.issue.read.v1'},async(token,assertAccess)=>{
    await check();await assertAccess();
    const headers={authorization:`Bearer ${token}`,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28'};
    const repo=await providerJson(`https://api.github.com/repositories/${String(input.repositoryId)}`,{headers});
    await check();await assertAccess();
    if(String(repo.id)!==input.repositoryId||typeof repo.full_name!=='string'||!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u.test(repo.full_name))throw new ConnectionError('PROVIDER_RESPONSE_INVALID',502);
    const resource=repo.full_name;
    return runConnector({action:'github.get-issue',resource,issueNumber:Number(input.issueNumber)},async signal=>{
     await check();await assertAccess();const data=await providerJson(`https://api.github.com/repos/${resource}/issues/${String(input.issueNumber)}`,{headers},signal);await check();await assertAccess();return data;
    });
   });
  } else {
   result=await drive.withToken(context,async(token,assertAccess)=>{
    const headers={authorization:`Bearer ${token}`};
    if(action.id==='drive.get-file.v1')return runConnector({action:'drive.get-file',resource:String(input.fileId)},async signal=>{
     await check();await assertAccess();const data=await providerJson(`https://www.googleapis.com/drive/v3/files/${String(input.fileId)}?supportsAllDrives=true`,{headers},signal);await check();await assertAccess();return data;
    });
    const url=new URL('https://www.googleapis.com/drive/v3/files');
    url.search=new URLSearchParams({q:driveQuery(actionId,input),fields:driveFields,pageSize:'25',supportsAllDrives:'true',includeItemsFromAllDrives:'false',corpora:'user',...(typeof input.pageToken==='string'?{pageToken:input.pageToken}:{})}).toString();
    return runConnector({action:'drive.search-files',resource:'search',name:action.id==='drive.find-files.v1'?String(input.name):'',...(typeof input.folderId==='string'?{folderId:input.folderId}:{})},async signal=>{
     await check();await assertAccess();const data=await providerJson(url.href,{headers},signal);
     if(!Array.isArray(data.files))throw new ConnectionError('PROVIDER_RESPONSE_INVALID',502);
     await check();await assertAccess();return data;
    });
   },check);
  }
  await check();await access.event(context,'run_succeeded',bound);await check();return {result};
 } catch(error) {await access.event(context,'run_failed',bound).catch(()=>{});throw error;}
}
