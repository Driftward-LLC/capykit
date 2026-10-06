import {afterEach,describe,expect,it,vi} from 'vitest';
import {runConnector} from '../src/hosted/activepieces.js';
import {describeAction,validateAction,driveQuery} from '../src/hosted/actions.js';
import {createRemoteActionServer} from '../src/mcp/remote.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {randomBytes} from 'node:crypto';
afterEach(()=>vi.unstubAllGlobals());
describe('reviewed connector action surface',()=>{
 it('runs the actual Drive search action for one bounded page, projects metadata and exposes continuation',async()=>{
  const broker=vi.fn(()=>Promise.resolve({files:[{id:'file_1',name:'Report',mimeType:'application/pdf',owners:['private'],secret:'not returned'}],nextPageToken:'page_2'}));
  expect(await runConnector({action:'drive.search-files',resource:'search',name:'Report'},broker)).toEqual({files:[{id:'file_1',name:'Report',mimeType:'application/pdf'}],nextPageToken:'page_2'});
  expect(broker).toHaveBeenCalledOnce();
  expect(await runConnector({action:'drive.search-files',resource:'search',name:'',folderId:'folder_1'},()=>Promise.resolve({files:[]}))).toEqual({files:[],nextPageToken:null});
 });
 it('rejects query injection, unknown actions, extra token/URL props and oversized provider pages',async()=>{
  for(const input of [{name:"a' or trashed=true"},{name:'a\\b'},{name:'x',url:'https://example.test'},{name:'x',access_token:'secret'}])expect(()=>validateAction('drive.find-files.v1',input)).toThrow('INVALID_REQUEST');
  expect(()=>validateAction('drive.list-folder.v1',{folderId:'../../secret'})).toThrow('INVALID_REQUEST');
  expect(()=>describeAction('custom_api_call')).toThrow('NOT_FOUND');
  expect(driveQuery('drive.find-files.v1',validateAction('drive.find-files.v1',{name:'Budget',folderId:'folder_1'}))).toBe("name contains 'Budget' and trashed = false and 'folder_1' in parents");
  await expect(runConnector({action:'drive.search-files',resource:'search',name:'Report'},()=>Promise.resolve({files:Array.from({length:26},()=>({id:'file_1',name:'Report',mimeType:'text/plain'}))}))).rejects.toMatchObject({code:'CONNECTOR_FAILED'});
 });
 it('requires remote credentials through env, keeps local mode separate, and sanitizes redirect failures',async()=>{
  const key=`ck_agent_${randomBytes(32).toString('base64url')}`;
  expect(()=>createRemoteActionServer({})).toThrow('CAPYKIT_API_KEY');
  for(const base of ['http://example.test','https://user:pass@example.test','https://example.test/path'])expect(()=>createRemoteActionServer({CAPYKIT_API_KEY:key,CAPYKIT_BASE_URL:base})).toThrow('HTTPS origin');
  const request=vi.fn(()=>Promise.resolve(new Response(JSON.stringify({actions:[{id:'drive.get-file.v1',app:'google-drive'}]}))));vi.stubGlobal('fetch',request);
  const server=createRemoteActionServer({CAPYKIT_BASE_URL:'https://capykit.example.test',CAPYKIT_API_KEY:key});const client=new Client({name:'test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
  try{await server.connect(b);await client.connect(a);expect((await client.listTools()).tools.map(t=>t.name)).toEqual(['list_actions','get_action','run_action','list_connections','list_connection_actions','run_connection_action']);
   const catalog=await client.callTool({name:'list_actions',arguments:{}});expect(JSON.stringify(catalog)).not.toContain(key);expect(JSON.stringify(request.mock.calls[0])).toContain('redirect');expect(JSON.stringify(request.mock.calls[0])).toContain(key);
   request.mockRejectedValueOnce(new Error(`redirect to https://evil.test/?key=${key}`));expect(JSON.stringify(await client.callTool({name:'run_action',arguments:{id:'drive.get-file.v1',connectionId:'11111111-1111-4111-8111-111111111111',input:{fileId:'file_1'}}}))).not.toContain(key);
  }finally{await client.close();await server.close();}
 });
});
