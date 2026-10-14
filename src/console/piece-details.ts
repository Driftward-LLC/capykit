import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { Field, inputWrapperStyles } from "@astryxdesign/core/Field";
import * as stylex from "@stylexjs/stylex";
import React, { useId } from 'react';
import type {CatalogApp} from '../hosted/piece-catalog.js';
const h=React.createElement;
// Native validation remains authoritative for selects, typed inputs and length-limited credentials.
export function NativeField({label,description,children,className,inputID,isRequired,isDisabled}:{label:string;description?:string;className?:string;inputID?:string;isRequired?:boolean;isDisabled?:boolean;children?:React.ReactElement<{id?:string|undefined;className?:string|undefined;required?:boolean|undefined;disabled?:boolean|undefined;'aria-label'?:string|undefined;'aria-describedby'?:string|undefined}>}):React.ReactElement {
 const generated=useId();
 if(!children)throw new Error('A native form control is required.');
 const input=React.Children.only(children),id=input.props.id??inputID??generated,descriptionID=description?`${id}-description`:undefined,disabled=input.props.disabled??isDisabled??false,required=input.props.required??isRequired??false;
 // Use the published Field appearance rather than maintaining a second native-control theme.
 const appearance=stylex.props(inputWrapperStyles.base,disabled&&inputWrapperStyles.disabled);
 return h(Field,{label,inputID:id,...description&&descriptionID?{description,descriptionID}:{},isRequired:required,isDisabled:disabled,...className?{className}:{},children:React.cloneElement(input,{id,required,disabled,className:[appearance.className,'capykit-native-control',input.props.className].filter(Boolean).join(' '),'aria-label':input.props['aria-label']??label,'aria-describedby':[input.props['aria-describedby'],descriptionID].filter(Boolean).join(' ')||undefined})});
}
export function categoryName(value:string):string{return value.toLowerCase().split('_').map(v=>['ai','crm'].includes(v)?v.toUpperCase():v==='and'?'&':v.charAt(0).toUpperCase()+v.slice(1)).join(' ');}
export function PieceDetails({app}:{app:CatalogApp}):React.ReactElement{
 const slug=app.pieceName.replace(/^@activepieces\/(?:piece-)?/u,'');
 return h(Card,{className:'piece-details',role:'region','aria-label':'Catalog integration'},h('h2',null,'Available through Activepieces'),h('p',null,app.description),
  h(Banner,{status:'info',title:'Available in the catalog, not connected',description:'This integration is in the Activepieces catalog. It has not been enabled in Capykit yet, so you cannot connect or run its actions here.'}),
  h('dl',null,h('dt',null,'Actions'),h('dd',null,String(app.actionCount)),h('dt',null,'Triggers'),h('dd',null,String(app.triggerCount)),h('dt',null,'Connection method'),h('dd',null,app.authentication.join(' or ')),h('dt',null,'Categories'),h('dd',null,app.categories.map(categoryName).join(', ')||'Other'),h('dt',null,'Connector version'),h('dd',null,app.version)),
  app.deprecated?h(Banner,{status:'warning',role:'status',title:'Activepieces has marked this connector as deprecated.'}):null,
  h(Button,{variant:'secondary',label:'View actions on Activepieces ↗',href:`https://www.activepieces.com/pieces/${encodeURIComponent(slug)}`,target:'_blank',rel:'noopener noreferrer'}));
}
