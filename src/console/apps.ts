import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActionConsole } from "./actions.js";
import { Connections, hasGitHubReturn } from "./connections.js";
import { sessionFetch, writeRequest } from "./session.js";
const h = React.createElement;
type AppId = "github" | "google-drive";
interface Catalog {
  apps: { id: AppId; name: string; configured: boolean; connected: boolean; description: string }[];
  github: { id: string; status: string; account: { login: string } | null; repositories: { id: string; fullName: string }[] }[];
  google: { configured: boolean; connection: { status: string; email: string | null; updatedAt?: string } | null };
}
let googleReturn: { code: string; state: string } | { notice: string } | null = (() => {
  const url = new URL(window.location.href);
  if (url.pathname !== "/v1/connections/google/callback") return null;
  window.history.replaceState(null,"","/?tab=connections&app=google-drive");
  const code=url.searchParams.get("code"), state=url.searchParams.get("state");
  if (url.searchParams.has("error")) return {notice:"Google Drive connection was canceled. You can connect when you’re ready."};
  if (!code || code.length>4096 || !state || !/^[A-Za-z0-9_-]{43}$/.test(state) || url.searchParams.getAll("code").length!==1 || url.searchParams.getAll("state").length!==1) return {notice:"Google Drive setup expired or could not be verified. Connect again to continue."};
  return {code,state};
})();
export function discardGoogleReturn(): void { googleReturn=null; }
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
function AppIcon({id}:{id:AppId}): React.ReactElement {
  return h("span",{className:`app-icon ${id}`,"aria-hidden":true},id==="github" ? h("svg",{viewBox:"0 0 24 24",fill:"currentColor"},h("path",{d:"M12 .8a11.4 11.4 0 0 0-3.6 22.2c.6.1.8-.2.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.8.1-.8.1-.8 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.4 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6a4.7 4.7 0 0 1 1.2-3.2c-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2a4.7 4.7 0 0 1 1.2 3.2c0 4.7-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.2v3.4c0 .4.2.7.8.6A11.4 11.4 0 0 0 12 .8Z"})) : h("svg",{viewBox:"0 0 48 48"},h("path",{fill:"#0F9D58",d:"M17 5 2 31l8 13 15-26Z"}),h("path",{fill:"#F4B400",d:"M17 5h15l15 26H32Z"}),h("path",{fill:"#4285F4",d:"M10 44h30l7-13H17Z"})));
}
export function Apps({active,onSessionExpired,onCreateFunction}:{active:boolean;onSessionExpired:()=>void;onCreateFunction:()=>void}):React.ReactElement {
  const [selected,setSelected]=useState<AppId|null>(()=>{
    const url=new URL(window.location.href), app=url.searchParams.get("app");
    return googleReturn?"google-drive":hasGitHubReturn()?"github":app==="github"||app==="google-drive"?app:url.searchParams.has("setup")?"github":null;
  });
  const [data,setData]=useState<Catalog|null>(null),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [noticeSuccess,setNoticeSuccess]=useState(false);
  const [query,setQuery]=useState(""),[connectedOnly,setConnectedOnly]=useState(false),[busy,setBusy]=useState(false),[disconnecting,setDisconnecting]=useState(false);
  const heading=useRef<HTMLHeadingElement>(null);
  const load=useCallback(async()=>{try{const value=await json<Catalog>(await sessionFetch("/v1/apps"),onSessionExpired);setData(value);setError("");return value;}catch(error){setError(error instanceof Error?error.message:"Could not load apps.");return undefined;}},[onSessionExpired]);
  useEffect(()=>{if(active)void load();},[active,load]);
  useEffect(()=>{
    const callback=googleReturn;googleReturn=null;
    if (!callback)return;
    if ("notice" in callback){setNoticeSuccess(false);setNotice(callback.notice);return;}
    setBusy(true);
    void writeRequest("/v1/connections/google/callback","POST",callback).then(response=>json(response,onSessionExpired)).then(async()=>{setNoticeSuccess(true);setNotice("Google Drive is connected.");await load();}).catch((error:unknown)=>{setError(error instanceof Error?error.message:"Google Drive setup failed.");}).finally(()=>{setBusy(false);});
  },[load,onSessionExpired]);
  function open(id:AppId|null){setSelected(id);setError("");setNotice("");setDisconnecting(false);const url=new URL(window.location.href);if(id)url.searchParams.set("app",id);else url.searchParams.delete("app");if(id!=="github")url.searchParams.delete("setup");window.history.replaceState(null,"",url);void load();requestAnimationFrame(()=>heading.current?.focus());}
  async function connect(){if(busy)return;setBusy(true);setError("");setNotice("");try{const value=await json<{authorizationUrl:string}>(await writeRequest("/v1/connections/google/start","POST",{consent:true}),onSessionExpired);const url=new URL(value.authorizationUrl);if(url.origin!=="https://accounts.google.com")throw new Error("Unexpected authorization URL.");window.location.assign(url.href);}catch(error){setError(error instanceof Error?error.message:"Could not start Google setup.");setBusy(false);}}
  async function checkAvailability(){setBusy(true);setNotice("");try{const value=await load();if(value){setNoticeSuccess(value.google.configured);setNotice(value.google.configured?"Google Drive is ready. Connect your account below.":"Google Drive is still unavailable. Your administrator needs to finish setup.");}}finally{setBusy(false);}}
  async function disconnect(){setBusy(true);setError("");try{const response=await writeRequest("/v1/connections/google","DELETE");if(!response.ok)await json(response,onSessionExpired);setDisconnecting(false);setNoticeSuccess(true);setNotice("Google Drive is disconnected.");await load();}catch(error){setError(error instanceof Error?error.message:"Could not disconnect.");}finally{setBusy(false);}}
  const google=data?.google.connection;
  const apps=(data?.apps??[]).filter(app=>(!connectedOnly||app.connected)&&app.name.toLowerCase().includes(query.toLowerCase().trim()));
  return h("section",{className:"apps"},
    selected?h("button",{type:"button",className:"text-button connection-back",onClick:()=>{ open(null); },disabled:busy},"← All apps"):null,
    h("div",{className:"section-heading"},h("div",null,h("h1",{ref:heading,tabIndex:-1},selected==="google-drive"?"Google Drive":selected==="github"?"GitHub":"Apps"),h("p",{className:"muted"},selected?"Manage your workspace connection.":"Your tools, connected.")),h("button",{type:"button",className:"text-button",disabled:busy,"aria-label":"Refresh apps",onClick:()=>{void load();}},"↻")),
    error?h("p",{className:"message error",role:"alert"},error):null,notice?h("p",{className:noticeSuccess?"message success":"message",role:"status"},notice):null,
    h("div",{hidden:selected!==null},h("label",{className:"app-search"},"Search apps",h("input",{type:"search",placeholder:"Search apps",value:query,onChange:event=>{ setQuery(event.currentTarget.value); }})),
      h("div",{className:"app-filters","aria-label":"Filter apps"},h("button",{type:"button","aria-pressed":!connectedOnly,onClick:()=>{ setConnectedOnly(false); }},"All apps"),h("button",{type:"button","aria-pressed":connectedOnly,onClick:()=>{ setConnectedOnly(true); }},"Connected")),
      data===null?h("p",{role:"status"},error?"Use Refresh apps to try again.":"Loading apps…"):apps.length===0?h("p",{className:"empty-state"},query?"No apps match your search.":"No connected apps yet. Choose All apps to connect your first app."):h("ul",{className:"app-list"},...apps.map(app=>h("li",{key:app.id},h("button",{type:"button",className:"app-row",onClick:()=>{ open(app.id); }},h(AppIcon,{id:app.id}),h("span",{className:"app-row-copy"},h("strong",null,app.name),h("span",{className:app.connected?"app-connected":"muted"},app.connected?"● Connected":!app.configured?"Not available yet":app.id==="google-drive"&&google?.status==="reconnect_required"?"Reconnect required":"Ready to connect"),h("span",{className:"small muted"},app.connected&&app.id==="google-drive"?google?.email:app.description)),h("span",{"aria-hidden":true},"›"))))),
      h("button",{type:"button",className:"create-function",onClick:onCreateFunction},"＋ Create a function"),
      h("p",{className:"small muted catalog-note"},"GitHub and Google Drive are the first supported apps. More Activepieces integrations will be added as their connection flows are ready.")),
    h("div",{hidden:selected!=="github"},selected==="github"&&data?.apps.find(app=>app.id==="github")?.connected?h(ActionConsole,{key:JSON.stringify(data.github),app:"github",onSessionExpired}):null,h("details",{open:!data?.apps.find(app=>app.id==="github")?.connected,className:"connection-management"},h("summary",null,"Manage GitHub connection"),h(Connections,{onSessionExpired,active:active&&selected==="github",onConnectionsChanged:()=>{void load();}}))),
    selected!=="google-drive"||!data?null:h(React.Fragment,null,
      h("section",{className:"panel drive-connection"},h(AppIcon,{id:"google-drive"}),h("h2",null,google?.status==="active"?"Connected account":!data.google.configured?"Google Drive isn’t available yet":google?.status==="reconnect_required"?"Reconnect Google Drive":"Connect Google Drive"),
        google?.status==="active"?h(React.Fragment,null,h("p",null,google.email),h("p",{className:"muted"},"Read-only access to file names and metadata. Choose an action below."),h("p",{className:"small muted"},h("a",{href:"https://myaccount.google.com/connections",target:"_blank",rel:"noopener noreferrer"},"Manage Capykit’s Google account permission ↗"),". Removing it there disconnects every workspace using this Google account."),
          disconnecting?h("div",{className:"connection-confirm"},h("p",null,"Disconnect Google Drive from this workspace? Capykit will remove its saved credentials. Other workspaces and your Google account permissions will stay unchanged."),h("div",{className:"actions"},h("button",{type:"button",className:"danger",disabled:busy,onClick:()=>{void disconnect();}},"Confirm disconnect"),h("button",{type:"button",className:"secondary",disabled:busy,onClick:()=>{ setDisconnecting(false); }},"Keep connected"))):h("button",{type:"button",className:"secondary",onClick:()=>{ setDisconnecting(true); }},"Disconnect")):
        !data.google.configured?h(React.Fragment,null,h("p",{className:"muted"},"Your administrator needs to enable Google Drive for this Capykit deployment. There’s nothing to authorize yet."),h("button",{type:"button",className:"secondary",disabled:busy,onClick:()=>{void checkAvailability();}},busy?"Checking…":"Check availability"),h("p",{className:"small muted"},"Once enabled: connect → choose your Google account → approve access at Google → return here connected.")):
        h(React.Fragment,null,
          google?.status==="reconnect_required"?h("p",{role:"status"},"Google access expired or was removed. Reconnect your account to continue."):null,
          h("p",{className:"muted"},"Choose your account and approve access securely at Google. You’ll return here when connected."),
          h("p",{id:"drive-access",className:"small muted"},"Connecting allows workspace owners to read file names and metadata across this account’s Drive, including shared files it can access. Capykit cannot read file contents or change files."),
          h("button",{type:"button",disabled:busy,"aria-describedby":"drive-access",onClick:()=>{void connect();}},busy?"Connecting…":google?.status==="reconnect_required"?"Reconnect Google Drive":"Connect Google Drive"))),
      google?.status==="active"?h(ActionConsole,{key:google.updatedAt,app:"google-drive",onSessionExpired}):null));
}
