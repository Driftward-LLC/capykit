import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { ConnectionError } from './connections.js';
import { authorizeWorkspace, requireWorkspaceOwner } from './workspace-access.js';
import { canManageWorkspace, type AuthenticatedContext } from './identity.js';
import { actions, describeAction, getAction } from './actions.js';

const uuid=z.string().uuid();
const expiry=z.string().datetime({offset:true}).refine(value=>Date.parse(value)>Date.now()+1000&&Date.parse(value)<=Date.now()+365*86400000);
const fail=(code:string,status=400):never=>{throw new ConnectionError(code,status);};
function parse<T>(schema:z.ZodType<T>,input:unknown):T {const result=schema.safeParse(input);return result.success?result.data:fail('INVALID_REQUEST');}
interface Connection {id:string;generation:number;name:string;repositories:{id:string;name:string}[];}
export interface ActionAuthorization { actionId:string;connectionId:string;generation:number;repositoryId?:string;grantId:string|null; }
export class ActionAccess {
 constructor(readonly pool:Pool) {}
 private async transaction<T>(context:AuthenticatedContext,run:(client:PoolClient)=>Promise<T>,owner=false):Promise<T> {
  const client=await this.pool.connect();try{await client.query('begin');const membership=await authorizeWorkspace(client,context);if(owner)requireWorkspaceOwner(membership);const result=await run(client);await client.query('commit');return result;}catch(error){await client.query('rollback');throw error;}finally{client.release();}
 }
 private async audit(client:PoolClient,context:AuthenticatedContext,event:string,actionId:string|null=null,grantId:string|null=null) {
  await client.query('insert into connector_action_audit(workspace_id,actor_principal_id,event,action_id,grant_id) values($1,$2,$3,$4,$5)',[context.membership.workspaceId,context.membership.principalId,event,actionId,grantId]);
 }
 async event(context:AuthenticatedContext,event:string,authorization:ActionAuthorization) {await this.transaction(context,client=>this.audit(client,context,event,authorization.actionId,authorization.grantId));}
 async authenticate(key:string):Promise<AuthenticatedContext|undefined> {
  if(!/^ck_agent_[A-Za-z0-9_-]{43}$/u.test(key))return undefined;
  const rows=await this.pool.query<{workspace_id:string;principal_id:string;credential_id:string}>('select * from authenticate_connector_agent($1)',[createHash('sha256').update(key).digest('hex')]);
  const row=rows.rows[0];return row?{identity:{provider:'capykit-agent',subject:row.principal_id,email:'',credentialId:row.credential_id},membership:{workspaceId:row.workspace_id,principalId:row.principal_id,principalKind:'agent',role:'member',active:true}}:undefined;
 }
 private async connection(client:PoolClient,context:AuthenticatedContext,actionId:string,id:string):Promise<Connection> {
  const workspace=context.membership.workspaceId;
  if(getAction(actionId).app==='google-drive') {
   if(id!==workspace)return fail('NOT_FOUND',404);
   const row=(await client.query<{generation:number;status:string;email:string}>('select generation,status,email from google_connections where workspace_id=$1',[workspace])).rows[0];
   if(!row)return fail('NOT_FOUND',404);if(row.status!=='active')return fail('CONNECTION_INACTIVE',403);
   return {id,generation:row.generation,name:row.email,repositories:[]};
  }
  const row=(await client.query<{generation:number;status:string;account:{login:string}|null}>('select generation,status,account from provider_connections where workspace_id=$1 and id=$2',[workspace,id])).rows[0];
  if(!row)return fail('NOT_FOUND',404);if(row.status!=='active')return fail('CONNECTION_INACTIVE',403);
  const repositories=(await client.query<{id:string;name:string}>('select repository_id as id,full_name as name from connection_repositories where workspace_id=$1 and connection_id=$2 order by full_name limit 500',[workspace,id])).rows;
  return {id,generation:row.generation,name:row.account?.login??'GitHub',repositories};
 }
 private async authorize(client:PoolClient,context:AuthenticatedContext,actionId:string,connectionId:string,repositoryId?:string,bound?:ActionAuthorization):Promise<ActionAuthorization> {
  const action=getAction(actionId);const connection=await this.connection(client,context,actionId,connectionId);
  if(bound&&connection.generation!==bound.generation)fail('CONNECTION_INACTIVE',403);
  if(action.app==='github'&&(!repositoryId||!connection.repositories.some(r=>r.id===repositoryId)))fail('FORBIDDEN',403);
  if(canManageWorkspace(context.membership)&&(!bound||bound.grantId===null))return {actionId,connectionId,generation:connection.generation,grantId:null,...(repositoryId?{repositoryId}:{})};
  const grant=(await client.query<{id:string}>(`select id from connector_action_grants where workspace_id=$1 and recipient_principal_id=$2 and action_id=$3
   and connection_id=$4 and generation=$5 and connector_version=$6 and revoked_at is null and expires_at>now()
   and ($7::text is null or $7=any(repository_ids)) and ($8::uuid is null or id=$8) order by created_at,id limit 1`,[context.membership.workspaceId,context.membership.principalId,actionId,connectionId,connection.generation,action.version,repositoryId??null,bound?.grantId??null])).rows[0];
  if(!grant)return fail('FORBIDDEN',403);
  return {actionId,connectionId,generation:connection.generation,grantId:grant.id,...(repositoryId?{repositoryId}:{})};
 }
 async bind(context:AuthenticatedContext,actionId:string,connectionId:string,repositoryId?:string):Promise<ActionAuthorization> {
  if(!uuid.safeParse(connectionId).success)fail('INVALID_REQUEST');
  return this.transaction(context,client=>this.authorize(client,context,actionId,connectionId,repositoryId));
 }
 async check(context:AuthenticatedContext,bound:ActionAuthorization):Promise<void> {
  await this.transaction(context,client=>this.authorize(client,context,bound.actionId,bound.connectionId,bound.repositoryId,bound).then(()=>{}));
 }
 async catalog(context:AuthenticatedContext) {
  return this.transaction(context,async client=>{
   const owner=canManageWorkspace(context.membership);
   const grants=(await client.query<{action_id:string;connection_id:string;generation:number;connector_version:string;repository_ids:string[]}>('select action_id,connection_id,generation,connector_version,repository_ids from connector_action_grants where workspace_id=$1 and recipient_principal_id=$2 and revoked_at is null and expires_at>now() limit 500',[context.membership.workspaceId,context.membership.principalId])).rows;
   const github=(await client.query<{id:string}>("select id from provider_connections where workspace_id=$1 and status='active' order by id limit 200",[context.membership.workspaceId])).rows;
   const result=[];
   for(const action of actions) {
    const connections=[];
    for(const id of action.app==='google-drive'?[context.membership.workspaceId]:github.map(r=>r.id)) {
     if(!owner&&!grants.some(g=>g.action_id===action.id&&g.connection_id===id))continue;
     let connection:Connection;try{connection=await this.connection(client,context,action.id,id);}catch(error){if(error instanceof ConnectionError&&['NOT_FOUND','CONNECTION_INACTIVE'].includes(error.code))continue;throw error;}
     const eligible=grants.filter(g=>g.action_id===action.id&&g.connection_id===id&&g.generation===connection.generation&&g.connector_version===action.version);
     if(!owner&&eligible.length===0)continue;
     connections.push({id,name:connection.name,repositories:owner?connection.repositories:connection.repositories.filter(r=>eligible.some(g=>g.repository_ids.includes(r.id)))});
    }
    if(connections.length)result.push({...describeAction(action.id),connections});
   }
   return {actions:result};
  });
 }
 async options(context:AuthenticatedContext) {
  const catalog=await this.catalog(context);
  return this.transaction(context,async client=>{
   const recipients=(await client.query<{id:string;name:string;kind:string}>(`select p.id,p.display_name as name,p.kind from principals p join workspace_memberships m on m.workspace_id=p.workspace_id and m.principal_id=p.id where p.workspace_id=$1 and p.active and m.active order by p.display_name,p.id limit 200`,[context.membership.workspaceId])).rows;
   const keys=(await client.query(`select k.id,k.principal_id as "principalId",p.display_name as name,k.expires_at as "expiresAt",case when k.revoked_at is not null then 'revoked' when k.expires_at<=now() then 'expired' else 'active' end as status from agent_credentials k join principals p on p.workspace_id=k.workspace_id and p.id=k.principal_id where k.workspace_id=$1 order by k.created_at desc,k.id limit 200`,[context.membership.workspaceId])).rows;
   const grants=(await client.query(`select g.id,g.recipient_principal_id as "recipientId",p.display_name as name,g.action_id as "actionId",g.connection_id as "connectionId",g.repository_ids as "repositoryIds",g.expires_at as "expiresAt",case when g.revoked_at is not null then 'revoked' when g.expires_at<=now() then 'expired' else 'active' end as status from connector_action_grants g join principals p on p.workspace_id=g.workspace_id and p.id=g.recipient_principal_id where g.workspace_id=$1 order by g.created_at desc,g.id limit 200`,[context.membership.workspaceId])).rows;
   return {recipients,keys,grants,...catalog};
  },true);
 }
 async issueKey(context:AuthenticatedContext,input:unknown) {
  const body=parse(z.object({name:z.string().trim().min(1).max(80).optional(),rotateKeyId:uuid.optional(),expiresAt:expiry}).strict().refine(v=>(v.name!==undefined)!==(v.rotateKeyId!==undefined)),input);
  const key=`ck_agent_${randomBytes(32).toString('base64url')}`;
  return this.transaction(context,async client=>{
   const workspace=context.membership.workspaceId;
   let principalId:string;
   if(body.rotateKeyId) {
    const old=(await client.query<{principal_id:string}>('select principal_id from agent_credentials where workspace_id=$1 and id=$2 and revoked_at is null for update',[workspace,body.rotateKeyId])).rows[0];if(!old)return fail('NOT_FOUND',404);principalId=old.principal_id;
    await client.query('update agent_credentials set revoked_at=now() where workspace_id=$1 and id=$2',[workspace,body.rotateKeyId]);await this.audit(client,context,'key_revoked');
   } else {principalId=(await client.query<{id:string}>('select create_connector_agent($1) as id',[body.name])).rows[0]?.id??fail('INTERNAL_ERROR',500);}
   const row=(await client.query<{id:string}>('insert into agent_credentials(workspace_id,principal_id,key_hash,expires_at) values($1,$2,$3,$4) returning id',[workspace,principalId,createHash('sha256').update(key).digest('hex'),body.expiresAt])).rows[0];
   await this.audit(client,context,'key_issued');return {id:row?.id,principalId,key,expiresAt:body.expiresAt};
  },true);
 }
 async revokeKey(context:AuthenticatedContext,id:string) {
  parse(uuid,id);await this.transaction(context,async client=>{const row=await client.query('update agent_credentials set revoked_at=now() where workspace_id=$1 and id=$2 and revoked_at is null returning id',[context.membership.workspaceId,id]);if(row.rowCount)await this.audit(client,context,'key_revoked');},true);
 }
 async grant(context:AuthenticatedContext,input:unknown) {
  const body=parse(z.object({recipientId:uuid,actionId:z.string(),connectionId:uuid,repositoryIds:z.array(z.string().regex(/^[1-9][0-9]{0,15}$/u)).max(500).default([]),expiresAt:expiry}).strict(),input);
  const action=getAction(body.actionId);
  return this.transaction(context,async client=>{
   const workspace=context.membership.workspaceId;
   if(!(await client.query('select p.id from principals p join workspace_memberships m on m.workspace_id=p.workspace_id and m.principal_id=p.id where p.workspace_id=$1 and p.id=$2 and p.active and m.active',[workspace,body.recipientId])).rowCount)return fail('NOT_FOUND',404);
   const connection=await this.connection(client,context,body.actionId,body.connectionId);
   if(action.app==='github'?(body.repositoryIds.length===0||new Set(body.repositoryIds).size!==body.repositoryIds.length||body.repositoryIds.some(id=>!connection.repositories.some(r=>r.id===id))):body.repositoryIds.length!==0)fail('INVALID_REQUEST');
   const row=(await client.query<{id:string}>('insert into connector_action_grants(workspace_id,recipient_principal_id,action_id,connection_id,generation,connector_version,repository_ids,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8) returning id',[workspace,body.recipientId,body.actionId,body.connectionId,connection.generation,action.version,body.repositoryIds,body.expiresAt])).rows[0];
   await this.audit(client,context,'grant_created',action.id,row?.id??null);return {id:row?.id};
  },true);
 }
 async revokeGrant(context:AuthenticatedContext,id:string) {
  parse(uuid,id);await this.transaction(context,async client=>{const row=await client.query('update connector_action_grants set revoked_at=now() where workspace_id=$1 and id=$2 and revoked_at is null returning action_id',[context.membership.workspaceId,id]);if(row.rowCount)await this.audit(client,context,'grant_revoked',row.rows[0].action_id as string,id);},true);
 }
}
