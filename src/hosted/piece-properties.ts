import { ConnectionError } from './connections.js';
export interface PieceField {key:string;name:string;description:string;required:boolean;type:string;secret:boolean;defaultValue?:unknown;options?:{label:string;value:string|number|boolean}[];}
const text=(value:unknown,fallback='',max=2000)=>typeof value==='string'?value.replace(/<[^>]*>/gu,'').slice(0,max):fallback;
export function pieceFields(raw:unknown):PieceField[]{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return [];
 return Object.entries(raw).filter(([key,value])=>/^[a-zA-Z0-9_-]{1,100}$/u.test(key)&&!['auth','__proto__','constructor','prototype'].includes(key)&&value&&typeof value==='object').slice(0,80).map(([key,value])=>{
  const p=value as Record<string,unknown>;const options=p.options as {options?:unknown[]}|undefined;
  return {key,name:text(p.displayName,key,160),description:text(p.description),required:p.required===true,type:text(p.type,'SHORT_TEXT',40),secret:p.type==='SECRET_TEXT'||p.type==='LONG_TEXT'||/password|secret|token|key/iu.test(key),...(p.defaultValue===undefined?{}:{defaultValue:p.defaultValue}),...(Array.isArray(options?.options)?{options:options.options.slice(0,500).flatMap(option=>{if(!option||typeof option!=='object')return [];const o=option as {label?:unknown;value?:unknown};return ['string','number','boolean'].includes(typeof o.value)?[{label:text(o.label,String(o.value),160),value:o.value as string|number|boolean}]:[];})}:{})};
 });
}
/** Literal inputs only: never allow Activepieces expressions to select other credentials. */
export function literalInput(value:unknown):Record<string,unknown>{
 const visit=(v:unknown,depth=0):void=>{if(depth>12)throw new ConnectionError('INVALID_REQUEST',400);if(typeof v==='string'&&v.includes('{{'))throw new ConnectionError('INVALID_REQUEST',400);
  if(v&&typeof v==='object')for(const [key,child] of Object.entries(v)){if(['auth','__proto__','constructor','prototype'].includes(key)||key.includes('{{'))throw new ConnectionError('INVALID_REQUEST',400);visit(child,depth+1);}};
 if(!value||typeof value!=='object'||Array.isArray(value)||Buffer.byteLength(JSON.stringify(value))>32*1024)throw new ConnectionError('INVALID_REQUEST',400);visit(value);return value as Record<string,unknown>;
}
