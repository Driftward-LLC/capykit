import React from 'react';
import type {CatalogApp} from '../hosted/piece-catalog.js';
const h=React.createElement;
export function categoryName(value:string):string{return value.toLowerCase().split('_').map(v=>['ai','crm'].includes(v)?v.toUpperCase():v==='and'?'&':v.charAt(0).toUpperCase()+v.slice(1)).join(' ');}
export function PieceDetails({app}:{app:CatalogApp}):React.ReactElement{
 const slug=app.pieceName.replace(/^@activepieces\/(?:piece-)?/u,'');
 return h('section',{className:'panel piece-details'},h('h2',null,'Available through Activepieces'),h('p',null,app.description),
  h('p',{className:'message'},'This integration is in the Activepieces catalog. It has not been enabled in Capykit yet, so you cannot connect or run its actions here.'),
  h('dl',null,h('dt',null,'Actions'),h('dd',null,String(app.actionCount)),h('dt',null,'Triggers'),h('dd',null,String(app.triggerCount)),h('dt',null,'Connection method'),h('dd',null,app.authentication.join(' or ')),h('dt',null,'Categories'),h('dd',null,app.categories.map(categoryName).join(', ')||'Other'),h('dt',null,'Connector version'),h('dd',null,app.version)),
  app.deprecated?h('p',{role:'status'},'Activepieces has marked this connector as deprecated.'):null,
  h('a',{className:'button-link secondary',href:`https://www.activepieces.com/pieces/${encodeURIComponent(slug)}`,target:'_blank',rel:'noopener noreferrer'},'View actions on Activepieces ↗'));
}
