import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {expect,it} from 'vitest';
it.skipIf(spawnSync('openssl',['version']).status!==0)('enforces certificate verification despite the upstream global bypass and explicit false',()=>{
 const dir=mkdtempSync(join(tmpdir(),'capykit-tls-'));
 try{execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
 const script=`const https=require('node:https'),fs=require('node:fs');process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';const server=https.createServer({key:fs.readFileSync('key.pem'),cert:fs.readFileSync('cert.pem')},(q,r)=>r.end('unsafe'));server.listen(0,'127.0.0.1',async()=>{const url='https://127.0.0.1:'+server.address().port;try{let rejected=0;try{await fetch(url)}catch{rejected++}await new Promise(resolve=>https.get(url,{rejectUnauthorized:false},r=>{r.resume();resolve()}).on('error',()=>{rejected++;resolve()}));console.log(JSON.stringify({rejected}));process.exitCode=rejected===2?0:1;}finally{server.close()}});`;
 writeFileSync(join(dir,'check.cjs'),script);expect(JSON.parse(execFileSync(process.execPath,['--require',resolve('scripts/connector-tls.cjs'),'check.cjs'],{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','ignore']}))).toEqual({rejected:2});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
