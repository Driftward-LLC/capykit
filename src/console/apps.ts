import React, { useCallback, useEffect, useRef, useState } from "react";
import { Connections, hasGitHubReturn } from "./connections.js";
import { sessionFetch, writeRequest } from "./session.js";
const h = React.createElement;
type AppId = "github" | "google-drive";
interface Catalog {
  apps: { id: AppId; name: string; configured: boolean; connected: boolean; description: string }[];
  github: { id: string; status: string; account: { login: string } | null; repositories: { id: string; fullName: string }[] }[];
  google: { configured: boolean; connection: { status: string; email: string | null } | null };
}
let googleReturn: { code: string; state: string } | { notice: string } | null = (() => {
  const url = new URL(window.location.href);
  if (url.pathname !== "/v1/connections/google/callback") return null;
  window.history.replaceState(null,"","/?tab=connections");
  const code=url.searchParams.get("code"), state=url.searchParams.get("state");
  if (url.searchParams.has("error")) return {notice:"Google Drive connection was canceled. You can connect when you’re ready."};
  if (!code || code.length>4096 || !state || !/^[A-Za-z0-9_-]{43}$/.test(state) || url.searchParams.getAll("code").length!==1 || url.searchParams.getAll("state").length!==1) return {notice:"Google Drive setup expired or could not be verified. Connect again to continue."};
  return {code,state};
})();
export function discardGoogleReturn(): void { googleReturn=null; }
const messages: Record<string,string> = {
  CONFIGURATION_UNAVAILABLE:"Google Drive needs one-time setup by your workspace operator. Your existing connections are still available.",
  CONNECT_STATE_INVALID:"This setup expired or was already used. Connect Google Drive again.",
  PROVIDER_SCOPE_REQUIRED:"Google did not approve read-only Drive metadata access. Connect again and approve that permission.",
  PROVIDER_AUTHORIZATION_EXPIRED:"Provider authorization has expired. Disconnect and connect this app again.",
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
function ConnectionTest({app,data,onSessionExpired,onFailure}:{app:AppId;data:Catalog;onSessionExpired:()=>void;onFailure:(message:string)=>void}):React.ReactElement {
  const repositories=data.github.filter(c=>c.status==="active").flatMap(c=>c.repositories.map(r=>({value:`${c.id}:${r.id}`,name:r.fullName})));
  const [repository,setRepository]=useState(repositories[0]?.value??"");
  const [resource,setResource]=useState(""); const [busy,setBusy]=useState(false); const [error,setError]=useState("");
  const [result,setResult]=useState<Record<string,unknown>|null>(null);
  async function test(event:React.SubmitEvent<HTMLElement>) {
    event.preventDefault(); setBusy(true);setError("");setResult(null);
    try {
      const [connectionId,repositoryId]=repository.split(":");
      const body=app==="github"?{connectionId,repositoryId,issueNumber:Number(resource)}:{fileId:resource.trim()};
      const response=await json<{result:Record<string,unknown>}>(await writeRequest(`/v1/apps/${app}/test`,"POST",body),onSessionExpired);
      setResult(response.result);
    } catch(error) {const message=error instanceof Error?error.message:"Connection test failed.";setError(message);onFailure(message);} finally{setBusy(false);}
  }
  return h("section",{className:"panel connection-test","aria-label":"Test connection"},h("h2",null,"Try your connection"),h("p",{className:"muted"},app==="github"?"Read one issue from an approved repository. Nothing will be changed.":"Read a file’s name, ID and type. File contents will not be opened or changed."),
    h("form",{onSubmit:(event)=>{void test(event);}},
      app!=="github"?null:h("label",null,"Repository",h("select",{value:repository,disabled:busy,onChange:(event:React.ChangeEvent<HTMLSelectElement>)=>{setRepository(event.currentTarget.value);setResult(null);}},...repositories.map(r=>h("option",{key:r.value,value:r.value},r.name)))),
      h("label",null,app==="github"?"Issue number":"Drive file ID",h("input",{required:true,type:app==="github"?"number":"text",...(app==="github"?{min:1,step:1,inputMode:"numeric" as const}:{pattern:"[A-Za-z0-9_-]{1,200}",maxLength:200}),value:resource,disabled:busy,onChange:event=>{setResource((event.currentTarget).value);setResult(null);},placeholder:app==="github"?"e.g. 12":"The ID in the file’s Drive URL"})),
      h("button",{type:"submit",disabled:busy||(app==="github"&&!repository)},busy?"Reading…":"Test connection")),
    error?h("p",{className:"message error",role:"alert"},error):null,
    result?h("div",{className:"test-result",role:"status"},h("h3",null,"Connection works"),h("dl",null,...Object.entries(result).flatMap(([key,value])=>[h("dt",{key:`${key}-label`},key),h("dd",{key},String(value))]))):null,
    h("p",{className:"small muted"},"This is an owner-only connection test. Running published functions is not available yet."));
}
export function Apps({active,onSessionExpired,onCreateFunction}:{active:boolean;onSessionExpired:()=>void;onCreateFunction:()=>void}):React.ReactElement {
  const [selected,setSelected]=useState<AppId|null>(()=>googleReturn?"google-drive":hasGitHubReturn()||new URL(window.location.href).searchParams.has("setup")?"github":null);
  const [data,setData]=useState<Catalog|null>(null),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [query,setQuery]=useState(""),[connectedOnly,setConnectedOnly]=useState(false),[busy,setBusy]=useState(false),[consent,setConsent]=useState(false),[disconnecting,setDisconnecting]=useState(false);
  const heading=useRef<HTMLHeadingElement>(null);
  const load=useCallback(async()=>{try{setData(await json<Catalog>(await sessionFetch("/v1/apps"),onSessionExpired));setError("");}catch(error){setError(error instanceof Error?error.message:"Could not load apps.");}},[onSessionExpired]);
  useEffect(()=>{if(active)void load();},[active,load]);
  useEffect(()=>{
    const callback=googleReturn;googleReturn=null;
    if (!callback)return;
    if ("notice" in callback){setNotice(callback.notice);return;}
    setBusy(true);
    void writeRequest("/v1/connections/google/callback","POST",callback).then(response=>json(response,onSessionExpired)).then(async()=>{setNotice("Google Drive is connected.");await load();}).catch((error:unknown)=>{setError(error instanceof Error?error.message:"Google Drive setup failed.");}).finally(()=>{setBusy(false);});
  },[load,onSessionExpired]);
  function testFailure(message:string){void load().then(()=>{setError(message);});}
  function open(id:AppId|null){setSelected(id);setError("");setNotice("");setDisconnecting(false);setConsent(false);void load();requestAnimationFrame(()=>heading.current?.focus());}
  async function connect(){setBusy(true);setError("");try{const value=await json<{authorizationUrl:string}>(await writeRequest("/v1/connections/google/start","POST",{consent:true}),onSessionExpired);const url=new URL(value.authorizationUrl);if(url.origin!=="https://accounts.google.com")throw new Error("Unexpected authorization URL.");window.location.assign(url.href);}catch(error){setError(error instanceof Error?error.message:"Could not start Google setup.");setBusy(false);}}
  async function disconnect(){setBusy(true);setError("");try{const response=await writeRequest("/v1/connections/google","DELETE");if(!response.ok)await json(response,onSessionExpired);setDisconnecting(false);setNotice("Google Drive is disconnected.");await load();}catch(error){setError(error instanceof Error?error.message:"Could not disconnect.");}finally{setBusy(false);}}
  const google=data?.google.connection;
  const apps=(data?.apps??[]).filter(app=>(!connectedOnly||app.connected)&&app.name.toLowerCase().includes(query.toLowerCase().trim()));
  return h("section",{className:"apps"},
    selected?h("button",{type:"button",className:"text-button connection-back",onClick:()=>{ open(null); },disabled:busy},"← All apps"):null,
    h("div",{className:"section-heading"},h("div",null,h("h1",{ref:heading,tabIndex:-1},selected==="google-drive"?"Google Drive":selected==="github"?"GitHub":"Apps"),h("p",{className:"muted"},selected?"Manage your workspace connection.":"Your tools, connected.")),h("button",{type:"button",className:"text-button",disabled:busy,"aria-label":"Refresh apps",onClick:()=>{void load();}},"↻")),
    error?h("p",{className:"message error",role:"alert"},error):null,notice?h("p",{className:"message success",role:"status"},notice):null,
    h("div",{hidden:selected!==null},h("label",{className:"app-search"},"Search apps",h("input",{type:"search",placeholder:"Search apps",value:query,onChange:event=>{ setQuery(event.currentTarget.value); }})),
      h("div",{className:"app-filters","aria-label":"Filter apps"},h("button",{type:"button","aria-pressed":!connectedOnly,onClick:()=>{ setConnectedOnly(false); }},"All apps"),h("button",{type:"button","aria-pressed":connectedOnly,onClick:()=>{ setConnectedOnly(true); }},"Connected")),
      data===null?h("p",{role:"status"},error?"Use Refresh apps to try again.":"Loading apps…"):apps.length===0?h("p",{className:"empty-state"},query?"No apps match your search.":"No connected apps yet. Choose All apps to connect your first app."):h("ul",{className:"app-list"},...apps.map(app=>h("li",{key:app.id},h("button",{type:"button",className:"app-row",onClick:()=>{ open(app.id); }},h(AppIcon,{id:app.id}),h("span",{className:"app-row-copy"},h("strong",null,app.name),h("span",{className:app.connected?"app-connected":"muted"},app.connected?"● Connected":app.configured?"Ready to connect":"Setup needed"),h("span",{className:"small muted"},app.connected&&app.id==="google-drive"?google?.email:app.description)),h("span",{"aria-hidden":true},"›"))))),
      h("button",{type:"button",className:"create-function",onClick:onCreateFunction},"＋ Create a function"),
      h("p",{className:"small muted catalog-note"},"GitHub and Google Drive are the first supported apps. More Activepieces integrations will be added as their connection flows are ready.")),
    h("div",{hidden:selected!=="github"},h(Connections,{onSessionExpired,active:active&&selected==="github",onConnectionsChanged:()=>{void load();}}),data?.apps.find(app=>app.id==="github")?.connected?h(ConnectionTest,{key:JSON.stringify(data.github),app:"github",data,onSessionExpired,onFailure:testFailure}):null),
    selected!=="google-drive"||!data?null:h(React.Fragment,null,
      h("section",{className:"panel drive-connection"},h(AppIcon,{id:"google-drive"}),h("h2",null,google?.status==="active"?"Connected account":"Connect Google Drive"),
        google?.status==="active"?h(React.Fragment,null,h("p",null,google.email),h("p",{className:"muted"},"Read-only access to file names and metadata. Only workspace owners can test this connection."),h("p",{className:"small muted"},h("a",{href:"https://myaccount.google.com/connections",target:"_blank",rel:"noopener noreferrer"},"Manage Capykit’s Google account permission ↗"),". Removing it there disconnects every workspace using this Google account."),
          disconnecting?h("div",{className:"connection-confirm"},h("p",null,"Disconnect Google Drive from this workspace? Capykit will remove its saved credentials. Other workspaces and your Google account permissions will stay unchanged."),h("div",{className:"actions"},h("button",{type:"button",className:"danger",disabled:busy,onClick:()=>{void disconnect();}},"Confirm disconnect"),h("button",{type:"button",className:"secondary",disabled:busy,onClick:()=>{ setDisconnecting(false); }},"Keep connected"))):h("button",{type:"button",className:"secondary",onClick:()=>{ setDisconnecting(true); }},"Disconnect")):
        !data.google.configured?h(React.Fragment,null,h("p",null,"Google Drive needs one-time setup by your workspace operator."),h("p",{className:"muted"},"A dedicated Capykit Google OAuth client must be configured before you can choose an account. GitHub is available now.")):
        h(React.Fragment,null,h("p",{className:"muted"},"Choose a Google account and approve read-only metadata access. Google grants access to names and metadata across that account’s Drive, including shared files it can access. Capykit will not read file contents or make changes."),h("label",{className:"checkbox-label"},h("input",{type:"checkbox",checked:consent,disabled:busy,onChange:event=>{ setConsent(event.currentTarget.checked); }}),"Allow workspace owners to use this account for Drive metadata tests."),h("button",{type:"button",disabled:busy||!consent,onClick:()=>{void connect();}},busy?"Connecting…":"Continue with Google"))),
      google?.status==="active"?h(ConnectionTest,{app:"google-drive",data,onSessionExpired,onFailure:testFailure}):null));
}
