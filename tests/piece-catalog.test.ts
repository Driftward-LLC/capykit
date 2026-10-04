import {describe,it,expect} from 'vitest';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import snapshot from '../src/hosted/piece-catalog.json' with {type:'json'};
import {appCatalog,personalAvailability} from '../src/hosted/piece-catalog.js';
const execute=promisify(execFile);
describe('full Activepieces metadata catalog',()=>{
 it('preserves every imported package and separates discovery from executable integrations',()=>{
  const catalog=appCatalog();expect(catalog.length).toBe(snapshot.count);expect(catalog.length).toBeGreaterThan(700);expect(new Set(catalog.map(p=>p.id)).size).toBe(catalog.length);expect(new Set(catalog.map(p=>p.pieceName)).size).toBe(catalog.length);
  expect(catalog.filter(p=>p.supportedInCapykit).map(p=>p.id).sort()).toEqual(['github','google-drive']);expect(catalog.every(p=>!p.configured&&!p.connected)).toBe(true);
  for(const id of ['gmail','slack','notion','linear','google-calendar','google-sheets','package-cashfree-payments'])expect(catalog.some(p=>p.id===id)).toBe(true);
  const enabled=appCatalog([{id:'github',name:'GitHub',description:'Approved repositories only',configured:true,connected:true,connector:'@activepieces/piece-github@0.9.0'}]);expect(enabled[0]).toMatchObject({id:'github',configured:true,connected:true,description:'Approved repositories only'});expect(enabled.filter(p=>p.connected)).toHaveLength(1);
  expect(snapshot.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);expect(Number.isFinite(Date.parse(snapshot.retrievedAt))).toBe(true);expect(snapshot.source).toBe('https://cloud.activepieces.com/api/v1/pieces?includeHidden=false');
  expect(catalog.every(p=>p.logoUrl===null||new URL(p.logoUrl).origin==='https://cdn.activepieces.com')).toBe(true);expect(JSON.stringify(catalog)).not.toMatch(/"(authUrl|tokenUrl|props|clientSecret|scope)"/u);
 });
 it('refreshes reproducibly from metadata without importing executable code and keeps old output after rejection',async()=>{
  const root=await mkdtemp(join(tmpdir(),'capykit-catalog-'));const input=join(root,'input.json'),output=join(root,'catalog.json');
  const fixture={name:'@activepieces/piece-example',displayName:'Example',version:'1.0.0',description:'Example app',actions:3,triggers:1,categories:['PRODUCTIVITY'],auth:{type:'OAUTH2',clientSecret:'discarded'},logoUrl:'https://evil.example.test/track'};
  try{await writeFile(input,JSON.stringify([fixture]));await execute(process.execPath,['scripts/update-piece-catalog.mjs','--input',input,'--output',output]);const first=await readFile(output,'utf8');expect(first).not.toContain('discarded');expect(first).not.toContain('evil.example.test');
   await execute(process.execPath,['scripts/update-piece-catalog.mjs','--input',input,'--output',output]);const second=JSON.parse(await readFile(output,'utf8')) as {pieces:unknown;sourceSha256:string};expect(second.pieces).toEqual((JSON.parse(first) as {pieces:unknown}).pieces);
   const stable=await readFile(output,'utf8');for(const invalid of [[fixture,fixture],[{...fixture,name:'@activepieces/../../unsafe'}],[{...fixture,actions:-1}],[{...fixture,auth:{type:'EXECUTE'}}],[{...fixture,auth:{type:'__proto__'}}],[{...fixture,name:'@activepieces/piece-'}]]){await writeFile(input,JSON.stringify(invalid));await expect(execute(process.execPath,['scripts/update-piece-catalog.mjs','--input',input,'--output',output])).rejects.toThrow();expect(await readFile(output,'utf8')).toBe(stable);}
  }finally{await rm(root,{recursive:true,force:true});}
 });
});

it("distinguishes OAuth-only central setup from key-based and no-auth connections",()=>{const pending=personalAvailability(appCatalog(),new Set());const drive=pending.find(a=>a.id==='google-drive');expect(drive?.personalReady).toBe(false);expect(pending.find(a=>a.id==='text-helper')?.personalReady).toBe(true);expect(personalAvailability(appCatalog(),new Set(['@activepieces/piece-google-drive'])).find(a=>a.id==='google-drive')?.personalReady).toBe(true);expect(personalAvailability(appCatalog(),undefined).every(a=>!a.personalReady)).toBe(true);});
