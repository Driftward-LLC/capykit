import { describe, expect, it, vi, afterEach } from "vitest";
import { runConnector } from "../src/hosted/activepieces.js";
import { providerJson } from "../src/hosted/provider-http.js";
import { loadGoogleConfig, GoogleProvider, driveScope } from "../src/hosted/google.js";
import { randomBytes } from "node:crypto";

afterEach(()=>vi.unstubAllGlobals());
describe("pinned Activepieces connector transport",()=>{
  it("executes the real GitHub action with brokered I/O and only returns projected fields",async()=>{
    const request=vi.fn(()=>Promise.resolve({number:12,title:"Example",state:"open",body:"private body not returned",token:"not returned"}));
    expect(await runConnector({action:"github.get-issue",resource:"example/repo",issueNumber:12},request)).toEqual({number:12,title:"Example",state:"open"});
    expect(request).toHaveBeenCalledOnce();
  });
  it("executes the real Drive action and rejects mismatched resource data",async()=>{
    expect(await runConnector({action:"drive.get-file",resource:"file_12"},()=>Promise.resolve({id:"file_12",name:"Report",mimeType:"application/pdf",owners:["not returned"]}))).toEqual({id:"file_12",name:"Report",mimeType:"application/pdf"});
    await expect(runConnector({action:"drive.get-file",resource:"file_12"},()=>Promise.resolve({id:"other",name:"Report",mimeType:"application/pdf"}))).rejects.toMatchObject({code:"CONNECTOR_FAILED"});
  });
  it("fails closed when the broker refuses or inputs could escape a resource path",async()=>{
    const deny=vi.fn(()=>Promise.reject(new Error("sensitive provider error")));
    await expect(runConnector({action:"github.get-issue",resource:"example/repo",issueNumber:12},deny)).rejects.toMatchObject({code:"CONNECTOR_FAILED"});
    await expect(runConnector({action:"drive.get-file",resource:"../../secret"},deny)).rejects.toMatchObject({code:"INVALID_REQUEST"});
  });
});
describe("bounded provider transport and dedicated Google OAuth",()=>{
  it("rejects redirects and oversized or invalid JSON without including provider data",async()=>{
    const mock=vi.fn(()=>Promise.resolve(new Response('x'.repeat(262145))));
    vi.stubGlobal("fetch",mock);
    await expect(providerJson("https://example.test")).rejects.toMatchObject({code:"PROVIDER_RESPONSE_INVALID"});
    expect(mock.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({redirect:"error"})]));
    mock.mockResolvedValue(new Response("private provider failure",{status:403}));
    await expect(providerJson("https://example.test")).rejects.toThrow("PROVIDER_REQUEST_FAILED");
  });
  it("recognizes Google's invalid_grant without treating outages as revoked credentials",async()=>{
    const mock=vi.fn(()=>Promise.resolve(new Response(JSON.stringify({error:"invalid_grant",error_description:"private"}),{status:400})));
    vi.stubGlobal("fetch",mock);
    await expect(providerJson("https://oauth2.googleapis.com/token")).rejects.toMatchObject({code:"PROVIDER_AUTHORIZATION_EXPIRED"});
    mock.mockResolvedValue(new Response("unavailable",{status:503}));
    await expect(providerJson("https://oauth2.googleapis.com/token")).rejects.toMatchObject({code:"PROVIDER_REQUEST_FAILED"});
  });
  it("requires dedicated credentials and requests only metadata and verified account identity",()=>{
    expect(loadGoogleConfig({},"https://capykit.example.test")).toBeUndefined();
    expect(()=>loadGoogleConfig({CAPYKIT_GOOGLE_CLIENT_ID:"partial"},"https://capykit.example.test")).toThrow("CONFIGURATION_UNAVAILABLE");
    const config=loadGoogleConfig({CAPYKIT_GOOGLE_CLIENT_ID:"123.apps.googleusercontent.com",CAPYKIT_GOOGLE_CLIENT_SECRET:randomBytes(32).toString("hex"),CAPYKIT_GOOGLE_ENCRYPTION_KEY:randomBytes(32).toString("base64")},"https://capykit.example.test");
    if(!config)throw new Error("missing fixture");
    const url=new URL(new GoogleProvider(config).authorizationUrl("bound-state","challenge"));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")).toBe(`openid email ${driveScope}`);
    expect(url.searchParams.get("redirect_uri")).toBe("https://capykit.example.test/v1/connections/google/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});
