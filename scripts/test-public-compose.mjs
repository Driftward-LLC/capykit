import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHostedServer,loadGithubConfig} from '../dist/hosted-api.js';
const directory=await mkdtemp(join(tmpdir(),'capykit-public-compose-'));
const saved=process.env;
try {
 const fixture={CAPYKIT_DB_PASSWORD:'fixture',POSTGRES_PASSWORD:'fixture',CAPYKIT_AUTH_DB_PASSWORD:'fixture',CAPYKIT_AUTH_JWT_SECRET:'fixture',CAPYKIT_PUBLIC_BASE_URL:'https://private.example.ts.net:19121',CAPYKIT_PUBLIC_SIGNUP_BASE_URL:'https://public.example.ts.net:10000',CAPYKIT_GITHUB_ENV_FILE:join(directory,'github.env'),CAPYKIT_GOOGLE_ENV_FILE:join(directory,'missing.env'),CAPYKIT_GITHUB_SETUP_WORKSPACE_ID:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',CAPYKIT_GITHUB_SETUP_PRINCIPAL_ID:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',CAPYKIT_GITHUB_SETUP_ORGANIZATION:'private-org',CAPYKIT_GITHUB_WEBHOOK_URL:'https://public.example.ts.net:10000/v1/webhooks/github',CAPYKIT_TAILSCALE_LOGIN:'owner@github',CAPYKIT_TAILSCALE_EMAIL:'owner@example.test',CAPYKIT_TAILSCALE_SUBJECT:'12345678-1234-4321-8123-123456789012',CAPYKIT_TAILSCALE_PROXY_ADDRESS:'172.25.0.1',CAPYKIT_TAILSCALE_SERVICE_KEY:'fixture'};
 await writeFile(join(directory,'github.env'),'CAPYKIT_GITHUB_CLIENT_ID=private-fixture\n');
 const envFile=join(directory,'deployment.env');await writeFile(envFile,Object.entries(fixture).map(([key,value])=>`${key}=${value}`).join('\n'));
 const config=JSON.parse(execFileSync('docker',['--host=unix:///var/run/docker.sock','compose','--env-file',envFile,'--profile','public','config','--format','json'],{encoding:'utf8',env:{PATH:saved.PATH}}));
 const publicApp=config.services['public-app'],privateApp=config.services.app;
 assert.equal(privateApp.environment.CAPYKIT_GITHUB_CLIENT_ID,'private-fixture');assert.ok(privateApp.volumes.length);
 assert.equal(privateApp.environment.CAPYKIT_GITHUB_WEBHOOK_URL,fixture.CAPYKIT_GITHUB_WEBHOOK_URL);
 assert.equal(publicApp.environment.CAPYKIT_PUBLIC_SIGNUP,'true');assert.equal(publicApp.environment.CAPYKIT_PUBLIC_BASE_URL,fixture.CAPYKIT_PUBLIC_SIGNUP_BASE_URL);
 assert.equal(publicApp.environment.CAPYKIT_GITHUB_CLIENT_ID,undefined);assert.ok(!publicApp.volumes?.length);
 for(const name of ['CONFIG_FILE','SETUP_WORKSPACE_ID','SETUP_PRINCIPAL_ID','SETUP_ORGANIZATION','WEBHOOK_URL'])assert.equal(publicApp.environment[`CAPYKIT_GITHUB_${name}`],'');
 for(const name of ['LOGIN','EMAIL','SUBJECT','PROXY_ADDRESS','SERVICE_KEY'])assert.equal(publicApp.environment[`CAPYKIT_TAILSCALE_${name}`],'');
 assert.equal(publicApp.ports.length,1);assert.equal(publicApp.ports[0].host_ip,'127.0.0.1');assert.equal(publicApp.ports[0].published,'19124');assert.equal(publicApp.ports[0].target,3000);
 process.env=publicApp.environment;assert.equal(loadGithubConfig(),undefined);
 const server=createHostedServer();
 try{assert.equal((await server.inject({url:'/health/live'})).statusCode,200);}finally{await server.close();}
 console.log('Public Compose isolation and compiled startup passed; private bootstrap preserved. No services changed.');
}finally{process.env=saved;await rm(directory,{recursive:true,force:true});}
