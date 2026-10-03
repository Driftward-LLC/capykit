import {createHash} from 'node:crypto';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
const source='https://cloud.activepieces.com/api/v1/pieces?includeHidden=false';
const args=process.argv.slice(2);const values={};
for(let i=0;i<args.length;i+=2){if(!['--input','--output'].includes(args[i])||!args[i+1])throw new Error('Usage: update-piece-catalog.mjs [--input file] [--output file]');values[args[i]]=args[i+1];}
let bytes;
if(values['--input'])bytes=await readFile(values['--input']);
else{const response=await fetch(source,{redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('Activepieces catalog unavailable');const reader=response.body.getReader();const chunks=[];let size=0;try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>12000000)throw new Error('Catalog exceeds size limit');chunks.push(next.value);}}finally{await reader.cancel();}bytes=Buffer.concat(chunks);}
if(bytes.length>12000000)throw new Error('Catalog exceeds size limit');
const rows=JSON.parse(bytes.toString('utf8'));if(!Array.isArray(rows)||!rows.length||rows.length>5000)throw new Error('Invalid catalog');
const methods={OAUTH2:'OAuth',OIDC:'OpenID Connect',SECRET_TEXT:'API key',BASIC_AUTH:'Username and password',CUSTOM_AUTH:'Connection details'};
function text(value,max){if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error('Invalid catalog text');return value.trim();}
const pieces=rows.map(row=>{
 const pieceName=text(row.name,160);if(!/^@activepieces\/[a-z0-9][a-z0-9-]*$/u.test(pieceName))throw new Error('Invalid package name');
 const id=pieceName.startsWith('@activepieces/piece-')?pieceName.slice('@activepieces/piece-'.length):'package-'+pieceName.slice('@activepieces/'.length);
 const version=text(row.version,40);if(!/^\d+\.\d+\.\d+$/u.test(version))throw new Error('Invalid version');
 for(const count of [row.actions,row.triggers])if(!Number.isSafeInteger(count)||count<0||count>10000)throw new Error('Invalid capability count');
 const categories=row.categories??[];if(!Array.isArray(categories)||categories.some(c=>typeof c!=='string'||! /^[A-Z_]{1,60}$/u.test(c)))throw new Error('Invalid categories');
 const auths=row.auth==null?[]:Array.isArray(row.auth)?row.auth:[row.auth];
 const authentication=Array.from(new Set(auths.map(a=>{if(!methods[a.type])throw new Error('Unknown authentication method');return methods[a.type];})));if(!authentication.length)authentication.push('No authentication required');
 let logoUrl=null;try{const url=new URL(row.logoUrl);if(url.protocol==='https:'&&url.hostname==='cdn.activepieces.com'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname.startsWith('/pieces/'))logoUrl=url.href;}catch{/* Use an initial when no trusted logo is supplied. */}
 return {id,pieceName,name:text(row.displayName,160),description:row.description?text(row.description,1000):'',version,logoUrl,categories:Array.from(new Set(categories)).sort(),actionCount:row.actions,triggerCount:row.triggers,authentication,deprecated:Boolean(row.deprecated)};
}).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
if(new Set(pieces.map(p=>p.id)).size!==pieces.length)throw new Error('Duplicate catalog identifier');
const output=resolve(values['--output']??'src/hosted/piece-catalog.json');
const catalog={source,retrievedAt:new Date().toISOString(),sourceSha256:createHash('sha256').update(bytes).digest('hex'),count:pieces.length,pieces};
const temporary=output+'.tmp';await writeFile(temporary,JSON.stringify(catalog,null,2)+'\n',{flag:'wx'});await rename(temporary,output);
console.log(JSON.stringify({count:pieces.length,source,output}));
