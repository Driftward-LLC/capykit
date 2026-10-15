import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { Badge } from "@astryxdesign/core/Badge";
import { List, ListItem } from "@astryxdesign/core/List";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Dialog } from "@astryxdesign/core/Dialog";
import { NativeField } from "./piece-details.js";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { Plus, RefreshCw, ChevronRight } from "lucide-react";
import { ActionConsole } from "./actions.js";
import { ActionAccess } from "./action-access.js";
import { Connections, hasGitHubReturn } from "./connections.js";
import { sessionFetch, writeRequest } from "./session.js";
import type {CatalogApp} from "../hosted/piece-catalog.js";
import {PieceDetails,categoryName} from "./piece-details.js";
import {PersonalApp,personalJson,type PersonalAccount,type PersonalShareState} from "./personal-app.js";
const h = React.createElement;
type AppId = string;
interface Catalog {
  apps: CatalogApp[];
  personalEnabled?:boolean;
  catalog?: {count:number;retrievedAt:string;source:string};
  github: { id: string; status: string; account: { login: string } | null; repositories: { id: string; fullName: string }[] }[];
  google: { configured: boolean; connection: { status: string; email: string | null; updatedAt?: string } | null };
}
let personalReturn: {code:string;state:string;appId:string} | {notice:string;appId:string} | null = (()=>{
 const url=new URL(window.location.href),marker=sessionStorage.getItem('capykit_personal_app');
 if(url.pathname!=='/v1/connections/personal/callback'&&!(url.pathname==='/v1/connections/google/callback'&&marker&&sessionStorage.getItem('capykit_personal_state')===url.searchParams.get('state')))return null;
 const appId=marker&&/^[a-z0-9-]{1,120}$/u.test(marker)?marker:'';sessionStorage.removeItem('capykit_personal_app');sessionStorage.removeItem('capykit_personal_state');
 window.history.replaceState(null,'','/?tab=connections'+(appId?'&app='+encodeURIComponent(appId):''));
 const code=url.searchParams.get('code'),state=url.searchParams.get('state');
 if(url.searchParams.has('error'))return {appId,notice:'Connection canceled. Your existing accounts are unchanged.'};
 if(!code||code.length>4096||!state||!/^[A-Za-z0-9_-]{43}$/u.test(state)||url.searchParams.getAll('code').length!==1||url.searchParams.getAll('state').length!==1)return {appId,notice:'This connection setup expired. Connect again.'};
 return {code,state,appId};
})();
let googleReturn: { code: string; state: string } | { notice: string } | null = (() => {
  const url = new URL(window.location.href);
  if (url.pathname !== "/v1/connections/google/callback") return null;
  window.history.replaceState(null,"","/?tab=connections&app=google-drive");
  const code=url.searchParams.get("code"), state=url.searchParams.get("state");
  if (url.searchParams.has("error")) return {notice:"Google Drive connection was canceled. You can connect when you’re ready."};
  if (!code || code.length>4096 || !state || !/^[A-Za-z0-9_-]{43}$/.test(state) || url.searchParams.getAll("code").length!==1 || url.searchParams.getAll("state").length!==1) return {notice:"Google Drive setup expired or could not be verified. Connect again to continue."};
  return {code,state};
})();
export function discardGoogleReturn(): void { googleReturn=null;personalReturn=null;sessionStorage.removeItem("capykit_personal_app");sessionStorage.removeItem("capykit_personal_state"); }
const messages: Record<string,string> = {
  CONFIGURATION_UNAVAILABLE:"Google Drive isn’t enabled on this Capykit deployment yet. Your administrator needs to finish setup.",
  CONNECT_STATE_INVALID:"This setup expired or was already used. Connect Google Drive again.",
  PROVIDER_SCOPE_REQUIRED:"Google did not approve read-only Drive metadata access. Connect again and approve that permission.",
  PROVIDER_AUTHORIZATION_EXPIRED:"Authorization has expired. Reconnect this app to continue.",
  PROVIDER_RESOURCE_NOT_FOUND:"This resource was not found or is not accessible to the connected account. Check the number or file ID.",
  CONNECTION_INACTIVE:"This connection changed or is no longer active. Refresh and reconnect before trying again.",
  CONNECTION_ALREADY_ACTIVE:"Google Drive is already connected. Refresh to see the account.",
  CONNECTOR_BUSY:"Two connection tests are already running. Try again shortly.",
  FORBIDDEN:"Only a workspace owner can manage and test app connections.",
};
async function json<T>(response: Response, expired: () => void): Promise<T> {
  if (response.status===401) { expired(); throw new Error("Your session expired. Sign in again."); }
  const value=await response.json() as {error?:{code?:string}};
  if (!response.ok) throw new Error(messages[value.error?.code ?? ""] ?? "The app could not complete this request. Check the connection and try again.");
  return value as T;
}
function AppIcon({id,logoUrl,name}:{id:AppId;logoUrl?:string|null;name?:string}): React.ReactElement {
  if(id!=="github"&&id!=="google-drive")return h("span",{className:"app-icon catalog-icon","aria-hidden":true},name?.charAt(0)??"A",logoUrl?h("img",{src:logoUrl,alt:"",loading:"lazy",decoding:"async",referrerPolicy:"no-referrer",onError:event=>{event.currentTarget.hidden=true;}}):null);
  return h("span",{className:`app-icon ${id}`,"aria-hidden":true},id==="github" ? h("svg",{viewBox:"0 0 24 24",fill:"currentColor"},h("path",{d:"M12 .8a11.4 11.4 0 0 0-3.6 22.2c.6.1.8-.2.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.8.1-.8.1-.8 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.4 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6a4.7 4.7 0 0 1 1.2-3.2c-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2a4.7 4.7 0 0 1 1.2 3.2c0 4.7-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.2v3.4c0 .4.2.7.8.6A11.4 11.4 0 0 0 12 .8Z"})) : h("svg",{viewBox:"0 0 48 48"},h("path",{fill:"#0F9D58",d:"M17 5 2 31l8 13 15-26Z"}),h("path",{fill:"#F4B400",d:"M17 5h15l15 26H32Z"}),h("path",{fill:"#4285F4",d:"M10 44h30l7-13H17Z"})));
}
export function Apps({active,onSessionExpired,onCreateFunction,onManageAgents,manage=true}:{active:boolean;onSessionExpired:()=>void;onCreateFunction:()=>void;onManageAgents?:()=>void;manage?:boolean}):React.ReactElement {
  const [selected,setSelected]=useState<AppId|null>(()=>{
    const url=new URL(window.location.href), app=url.searchParams.get("app");
    return personalReturn?.appId?personalReturn.appId:googleReturn?"google-drive":hasGitHubReturn()?"github":app&&/^[a-z0-9-]{1,120}$/u.test(app)?app:url.searchParams.has("setup")?"github":null;
  });
  const [personalAccounts,setPersonalAccounts]=useState<PersonalAccount[]>([]);
  // ponytail: per signed-in workspace, in-memory locks; cross-tab coordination needs server idempotency.
  const shareStates=useRef(new Map<string,PersonalShareState>());
  const [,setShareVersion]=useState(0);
  const shareChanged=useCallback(()=>{setShareVersion(v=>v+1);},[]);
  const [accessOpen,setAccessOpen]=useState(false);
  useEffect(()=>{setAccessOpen(false);},[selected,active]);
  const [data,setData]=useState<Catalog|null>(null),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [noticeSuccess,setNoticeSuccess]=useState(false);
  const [category,setCategory]=useState(""),[limit,setLimit]=useState(40);
  const [query,setQuery]=useState(""),[connectedOnly,setConnectedOnly]=useState(false),[busy,setBusy]=useState(false),[disconnecting,setDisconnecting]=useState(false);
  const heading=useRef<HTMLHeadingElement>(null);
  const load=useCallback(async()=>{try{let value:Catalog;if(manage)value=await json<Catalog>(await sessionFetch("/v1/apps"),onSessionExpired);else{const [catalog,granted]=await Promise.all([sessionFetch("/v1/apps/catalog").then(r=>json<Pick<Catalog,"apps"|"catalog"|"personalEnabled">>(r,onSessionExpired)),sessionFetch("/v1/actions").then(r=>json<{actions:{app:string}[]}>(r,onSessionExpired))]);value={...catalog,apps:catalog.apps.map(app=>({...app,connected:granted.actions.some(action=>action.app===app.id)})),github:[],google:{configured:false,connection:null}};}if(value.personalEnabled){const personal=await personalJson<{connections:PersonalAccount[]}>(await sessionFetch("/v1/connections/personal"),onSessionExpired);setPersonalAccounts(personal.connections);value={...value,apps:value.apps.map(app=>({...app,connected:app.connected||personal.connections.some(c=>c.appId===app.id&&c.status==="active")})).sort((a,b)=>Number(b.connected)-Number(a.connected)||a.name.localeCompare(b.name))};}setData(value);setError("");return value;}catch(error){setError(error instanceof Error?error.message:"Could not load apps.");return undefined;}},[onSessionExpired,manage]);
  useEffect(()=>{if(active)void load();},[active,load]);
  useEffect(()=>{
    const callback=googleReturn;googleReturn=null;
    if (!callback)return;
    if ("notice" in callback){setNoticeSuccess(false);setNotice(callback.notice);return;}
    setBusy(true);
    void writeRequest("/v1/connections/google/callback","POST",callback).then(response=>json(response,onSessionExpired)).then(async()=>{setNoticeSuccess(true);setNotice("Google Drive is connected.");await load();}).catch((error:unknown)=>{setError(error instanceof Error?error.message:"Google Drive setup failed.");}).finally(()=>{setBusy(false);});
  },[load,onSessionExpired]);
  useEffect(()=>{
   const callback=personalReturn;personalReturn=null;if(!callback)return;
   if('notice' in callback){setNotice(callback.notice);return;}setBusy(true);
   void writeRequest('/v1/connections/personal/callback','POST',{code:callback.code,state:callback.state}).then(r=>personalJson<{appId:string}>(r,onSessionExpired)).then(async value=>{setSelected(value.appId);setNoticeSuccess(true);setNotice('Your personal account is connected. Only you can use it until you share an action.');await load();}).catch((e:unknown)=>{setError(e instanceof Error?e.message:'Could not complete connection.');}).finally(()=>{setBusy(false);});
  },[load,onSessionExpired]);
  function open(id:AppId|null){setSelected(id);setError("");setNotice("");setDisconnecting(false);const url=new URL(window.location.href);if(id)url.searchParams.set("app",id);else url.searchParams.delete("app");if(id!=="github")url.searchParams.delete("setup");window.history.replaceState(null,"",url);void load();requestAnimationFrame(()=>heading.current?.focus());}
  async function connect(){if(busy)return;sessionStorage.removeItem("capykit_personal_app");sessionStorage.removeItem("capykit_personal_state");setBusy(true);setError("");setNotice("");try{const value=await json<{authorizationUrl:string}>(await writeRequest("/v1/connections/google/start","POST",{consent:true}),onSessionExpired);const url=new URL(value.authorizationUrl);if(url.origin!=="https://accounts.google.com")throw new Error("Unexpected authorization URL.");window.location.assign(url.href);}catch(error){setError(error instanceof Error?error.message:"Could not start Google setup.");setBusy(false);}}
  async function checkAvailability(){setBusy(true);setNotice("");try{const value=await load();if(value){setNoticeSuccess(value.google.configured);setNotice(value.google.configured?"Google Drive is ready. Connect your account below.":"Google Drive is still unavailable. Your administrator needs to finish setup.");}}finally{setBusy(false);}}
  async function disconnect(){setBusy(true);setError("");try{const response=await writeRequest("/v1/connections/google","DELETE");if(!response.ok)await json(response,onSessionExpired);setDisconnecting(false);setNoticeSuccess(true);setNotice("Google Drive is disconnected.");await load();}catch(error){setError(error instanceof Error?error.message:"Could not disconnect.");}finally{setBusy(false);}}
  const google=data?.google.connection;
  const disconnectOpen=active&&disconnecting&&manage&&selected==="google-drive"&&google?.status==="active";
  const selectedApp=data?.apps.find(app=>app.id===selected);
  const categories=Array.from(new Set((data?.apps??[]).flatMap(app=>app.categories))).sort();
  const apps=(data?.apps??[]).filter(app=>(!connectedOnly||app.connected)&&(!category||app.categories.includes(category))&&[app.name,app.description,...app.categories.map(categoryName)].join(" ").toLowerCase().includes(query.toLowerCase().trim()));
  return h("section",{className:"apps astryx-route"},
    selected?h(Button, {type:"button", variant: "ghost", className:"connection-back", onClick:()=>{ open(null); }, isDisabled:busy, label: "← All apps"}):null,
    h("div",{className:"section-heading"},h("div",null,h("h1",{ref:heading,tabIndex:-1},selected?(selectedApp?.name??"App"):"Apps"),h("p",{className:"muted"},selected?data?.personalEnabled?"Your personal accounts and available actions.":selectedApp?.supportedInCapykit?"Your workspace connection and actions.":"Explore this integration.":"Find your next connection.")),h(Button, {type:"button", variant: "ghost", isDisabled:busy, icon:h(Icon,{icon:RefreshCw}), isIconOnly:true, onClick:()=>{void load();}, label: "Refresh apps"})),
    error&&!disconnectOpen?h(Banner,{status:"error",role:"alert",title:error}):null,notice?h(Banner,{status:noticeSuccess?"success":"info",role:"status",title:notice}):null,
    h("div",{hidden:selected!==null},h(NativeField, {className:"app-search", label: "Search apps"}, h("input",{type:"search",placeholder:"Search apps",value:query,onChange:event=>{ setQuery(event.currentTarget.value);setLimit(40); }})),
      h("div",{className:"app-filters","aria-label":"Filter apps"},h(Button, {type:"button", "aria-pressed":!connectedOnly, onClick:()=>{ setConnectedOnly(false);setLimit(40); }, variant: connectedOnly?"secondary":"primary", label: "All apps"}),h(Button, {type:"button", "aria-pressed":connectedOnly, onClick:()=>{ setConnectedOnly(true);setLimit(40); }, variant: connectedOnly?"primary":"secondary", label: "Connected"})),
      h(NativeField, {className:"app-category", label: "Category"}, h("select",{"aria-label":"Category",value:category,onChange:(event:React.ChangeEvent<HTMLSelectElement>)=>{setCategory(event.currentTarget.value);setLimit(40);}},h("option",{value:""},"All categories"),...categories.map(c=>h("option",{key:c,value:c},categoryName(c))))),
      data===null?error?h(EmptyState,{title:"Apps could not load",description:"Use Refresh apps to try again."}):h(Spinner,{label:"Loading apps…"}):h(React.Fragment,null,
        h("p",{className:"small muted",role:"status"},`${String(apps.length)} ${connectedOnly?"connected apps":"matching integrations"} · Showing ${String(Math.min(limit,apps.length))}`),
        apps.length===0?h(EmptyState,{title:query||category?"No apps match your filters":"No connected apps yet",description:query||category?"Try another search or category.":"Choose All apps to explore integrations."}):h(List,{className:"app-list",hasDividers:true,children:apps.slice(0,limit).map(app=>{
          const accounts=personalAccounts.filter(account=>account.appId===app.id);
          const status=app.connected?"Connected":data.personalEnabled?app.personalReady===false?"Provider setup pending":accounts.some(account=>account.status==='pending')?'Setup unfinished':accounts.some(account=>account.status==='failed')?'Connection failed':accounts.some(account=>account.status==='expired')?'Authorization expired':accounts.some(account=>account.status==='reconnect_required')?'Reconnect required':"Connect your account":!app.supportedInCapykit?"Available through Activepieces":!manage?"Managed by workspace owner":!app.configured?"Setup required":app.id==="google-drive"&&google?.status==="reconnect_required"?"Reconnect required":"Ready to connect";
          const accountLabels=accounts.map(account=>`${account.personal?'Personal':'Shared with you'} · ${account.name} · ${account.id.slice(0,8)}`).join('; ')||(app.id==='github'?data.github.filter(connection=>connection.status==='active'&&connection.account).map(connection=>`Workspace · ${connection.account?.login??'Unavailable account'}`).join('; '):app.id==='google-drive'&&google?.email?`Workspace · ${google.email}`:'');
          return h(ListItem,{key:app.id,className:"app-row",label:app.name,onClick:()=>{open(app.id);},startContent:h(AppIcon,{id:app.id,logoUrl:app.logoUrl,name:app.name}),description:h("div",{className:"app-row-copy"},h(Badge,{label:status,variant:status==='Connection failed'?'error':app.connected?"success":status.includes("pending")||status.includes("required")||status.includes('expired')||status.includes('unfinished')?"warning":"neutral"}),h("span",{className:"small muted catalog-description"},accountLabels||app.description),h("span",{className:"small muted"},`${String(app.actionCount)} Activepieces actions · ${String(app.triggerCount)} triggers`)),endContent:h(Icon,{icon:ChevronRight})});
        })}),
        apps.length>limit?h(Button,{type:"button",variant:"secondary",className:"catalog-more",onClick:()=>{setLimit(count=>count+40);},label:"Show more apps"}):null),
      manage?h(Button,{type:"button",className:"create-function",variant:"primary",label:"Create a function",icon:h(Icon,{icon:Plus}),onClick:onCreateFunction}):null,
      h("p",{className:"small muted catalog-note"},data?.personalEnabled?`${String(data.catalog?.count??0)} integrations. Personal accounts, centrally managed provider setup.`:`${String(data?.catalog?.count??0)} integrations from Activepieces. GitHub and Google Drive are enabled in Capykit; other integrations are available to explore.`,data?.catalog?h("span",null,` Catalog updated ${new Date(data.catalog.retrievedAt).toLocaleDateString()}.`):null)),
    selected&&data&&!selectedApp?h(EmptyState,{title:"App not in the current catalog",description:"Choose All apps to browse."}):null,
    selectedApp&&data?.personalEnabled?h(PersonalApp,{key:selectedApp.id,appId:selectedApp.id,appName:selectedApp.name,active,accounts:personalAccounts.filter(a=>a.appId===selectedApp.id),shareStates,onShareChanged:shareChanged,onSessionExpired,onChanged:()=>{void load();}}):null,
    selectedApp&&!data?.personalEnabled&&!selectedApp.supportedInCapykit?h(PieceDetails,{app:selectedApp}):null,
    selectedApp?.supportedInCapykit&&data?.personalEnabled?h("h2",null,"Workspace connection"):null,
    manage&&selectedApp?.supportedInCapykit&&(selected==="github"||selected==="google-drive")?h("details",{key:`access-${selected}`,open:accessOpen,onToggle:(event:React.ToggleEvent<HTMLDetailsElement>)=>{setAccessOpen(event.currentTarget.open);}},h("summary",null,"Who can use this app?"),h("p",{className:"small muted"},"Workspace action access shares the same identity and grant records as Agents. Personal-account sharing stays in the account above."),onManageAgents?h(Button, {type:"button", variant: "secondary", onClick:onManageAgents, label: "Manage identities in Agents"}):null,h(ActionAccess,{key:selected,app:selected,onSessionExpired,active:active&&accessOpen})):null,
    !manage&&selectedApp?.supportedInCapykit?h(React.Fragment,null,h(Banner,{status:"info",title:"Workspace-managed connection",description:"Your workspace owner manages this connection. Actions granted to you appear below."}),h("div",{className:"legacy-route"},h(ActionConsole,{key:selected,app:selected==="github"?"github":"google-drive",onSessionExpired}))):null,
    manage?h("div",{hidden:selected!=="github"},selected==="github"&&data?.github.some(c=>c.status==="active")?h("div",{className:"legacy-route"},h(ActionConsole,{key:JSON.stringify(data.github),app:"github",onSessionExpired})):null,h("details",{open:!data?.github.some(c=>c.status==="active"),className:"connection-management"},h("summary",null,"Manage GitHub connection"),h(Connections,{onSessionExpired,active:active&&selected==="github",onConnectionsChanged:()=>{void load();}}))):null,
    !manage||selected!=="google-drive"||!data?null:h(React.Fragment,null,
      h(Card,{className:"drive-connection",role:"region","aria-label":"Google Drive workspace connection"},h(AppIcon,{id:"google-drive"}),h("h2",null,google?.status==="active"?"Connected account":!data.google.configured?"Google Drive isn’t available yet":google?.status==="reconnect_required"?"Reconnect Google Drive":"Connect Google Drive"),
        google?.status==="active"?h(React.Fragment,null,h("p",null,google.email),h(Badge,{variant:"success",label:"Workspace · Connected"}),h("p",{className:"muted"},"Read-only access to file names and metadata. Choose an action below."),h("p",{className:"small muted"},h("a",{href:"https://myaccount.google.com/connections",target:"_blank",rel:"noopener noreferrer"},"Manage Capykit’s Google account permission ↗"),". Removing it there disconnects every workspace using this Google account."),
          h(Button, {type:"button", variant: "secondary", onClick:()=>{ setError(""); setDisconnecting(true); }, label: "Disconnect"}),h(Dialog, {isOpen:active&&disconnecting, onOpenChange:(open:boolean)=>{if(!busy)setDisconnecting(open);}, purpose:busy?"required":"form", "aria-label":"Disconnect Google Drive", className:"connection-confirm", children:h("div",{style:{overflowY:"auto"}},h("p",null,"Disconnect Google Drive from this workspace? Capykit will remove its saved credentials. Other workspaces and your Google account permissions will stay unchanged."),disconnecting&&error?h(Banner,{status:"error",role:"alert",title:error}):null, h("div",{className:"actions"},h(Button, {type:"button", variant: "destructive", isDisabled:busy, onClick:()=>{void disconnect();}, label: "Confirm disconnect"}),h(Button, {type:"button", variant: "secondary", "data-autofocus":"", isDisabled:busy, onClick:()=>{ setDisconnecting(false); }, label: "Keep connected"})))})):
        !data.google.configured?h(React.Fragment,null,h("p",{className:"muted"},"Your administrator needs to enable Google Drive for this Capykit deployment. There’s nothing to authorize yet."),h(Button, {type:"button", variant: "secondary", isDisabled:busy, onClick:()=>{void checkAvailability();}, label: busy?"Checking…":"Check availability"}),h("p",{className:"small muted"},"Once enabled: connect → choose your Google account → approve access at Google → return here connected.")):
        h(React.Fragment,null,
          google?.status==="reconnect_required"?h(Banner,{status:"warning",role:"status",title:"Reconnect required",description:"Google access expired or was removed. Reconnect your account to continue."}):null,
          h("p",{className:"muted"},"Choose your account and approve access securely at Google. You’ll return here when connected."),
          h("p",{id:"drive-access",className:"small muted"},"Connecting allows workspace owners to read file names and metadata across this account’s Drive, including shared files it can access. Capykit cannot read file contents or change files."),
          h(Button, {type:"button", isDisabled:busy, "aria-describedby":"drive-access", onClick:()=>{void connect();}, variant: "primary", label: busy?"Connecting…":google?.status==="reconnect_required"?"Reconnect Google Drive":"Connect Google Drive"}))),
      google?.status==="active"?h("div",{className:"legacy-route"},h(ActionConsole,{key:google.updatedAt,app:"google-drive",onSessionExpired})):null));
}
