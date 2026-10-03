import definitions from './action-definitions.json' with { type: 'json' };
import { z } from 'zod';
import { ConnectionError } from './connections.js';

const resource = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const pageToken = z.string().regex(/^[A-Za-z0-9_+=/-]{1,2048}$/u).optional();
const name = z.string().trim().min(1).max(120).refine(value => !/['\\]/u.test(value) && !Array.from({length:value.length},(_,i)=>value.charCodeAt(i)).some(c=>c<32));
export const actionIds = ['github.get-issue.v1','drive.get-file.v1','drive.find-files.v1','drive.list-folder.v1'] as const;
export type ActionId = typeof actionIds[number];
export interface ActionField { key: string; name: string; description: string; required: boolean; type: 'text'|'number'; }
const fields = (id: ActionId, mapping: Record<string,string>, required: string[]) => Object.entries(mapping).map(([key,source]) => {
  const props = definitions[id].props as Record<string,{name:string;description:string}>;
  return {key,name:props[source]?.name ?? key,description:props[source]?.description ?? '',required:required.includes(key),type:key==='issueNumber'?'number' as const:'text' as const};
});
export const actions = [
 {id:actionIds[0],app:'github' as const,version:'0.9.0',...definitions[actionIds[0]],description:'Read an issue’s number, title and state from an approved repository.',fields:fields(actionIds[0],{issueNumber:'issue_number'},['issueNumber']),schema:z.object({repositoryId:z.string().regex(/^[1-9][0-9]{0,15}$/u),issueNumber:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict()},
 {id:actionIds[1],app:'google-drive' as const,version:'0.11.0',...definitions[actionIds[1]],fields:fields(actionIds[1],{fileId:'file_id'},['fileId']),schema:z.object({fileId:resource}).strict()},
 {id:actionIds[2],app:'google-drive' as const,version:'0.11.0',...definitions[actionIds[2]],fields:fields(actionIds[2],{name:'value',folderId:'parent_folder_id'},['name']),schema:z.object({name,folderId:resource.optional(),pageToken}).strict()},
 {id:actionIds[3],app:'google-drive' as const,version:'0.11.0',...definitions[actionIds[3]],description:'List file names and metadata directly inside a folder. File contents are not downloaded.',fields:fields(actionIds[3],{folderId:'folder_id'},['folderId']),schema:z.object({folderId:resource,pageToken}).strict()},
];
export function getAction(id: string) { const action=actions.find(a=>a.id===id); if(!action) throw new ConnectionError('NOT_FOUND',404); return action; }
export function validateAction(id:string,input:unknown):Record<string,unknown> {const result=getAction(id).schema.safeParse(input); if(!result.success)throw new ConnectionError('INVALID_REQUEST',400);return result.data;}
export function describeAction(id:string) { const a=getAction(id);return {id:a.id,app:a.app,name:a.name,description:a.description,connectorVersion:a.version,readOnly:true,fields:a.fields,inputSchema:z.toJSONSchema(a.schema)}; }
export function driveQuery(id:string,input:Record<string,unknown>):string {
 const parts=[`name contains '${id==='drive.find-files.v1'?String(input.name):''}'`,'trashed = false'];
 if(typeof input.folderId==='string') parts.push(`'${input.folderId}' in parents`);
 return parts.join(' and ');
}
export const driveFields='nextPageToken,files(id,name,mimeType,createdTime,modifiedTime)';
