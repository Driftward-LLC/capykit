import {readFileSync,writeFileSync} from 'node:fs';
const prefix='/usr/src/app';
const sourcePath=`${prefix}/packages/pieces/common/dist/src/lib/http/core/fetch-http-client.js`;
const source=readFileSync(sourcePath,'utf8');
const unsafe="process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';";
if(source.split(unsafe).length!==2)throw new Error('Upstream TLS patch target changed; review the engine image');
writeFileSync(sourcePath,source.replace(unsafe,''));
const guard=readFileSync('/opt/capykit/connector-tls.cjs','utf8');
for(const relative of ['packages/server/api/dist/src/bootstrap.js','packages/server/worker/dist/src/bootstrap.js','dist/packages/engine/main.js']){
 const path=`${prefix}/${relative}`,body=readFileSync(path,'utf8');
 // Cache installation copies this engine bundle. The guard travels with it,
 // including child processes with intentionally filtered environments.
 const directive=body.match(/^(?:"use strict";|'use strict';)\s*/u)?.[0]??'';
 writeFileSync(path,directive+guard+'\n'+body.slice(directive.length));
}
console.log('Verified connector TLS patch applied to API and engine bundles.');
