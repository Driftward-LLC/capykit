import githubModule from "@activepieces/piece-github";
import driveModule from "@activepieces/piece-google-drive";

process.once("message", async ({ request, token, fixture }) => {
  try {
    let scope;
    if (fixture) {
      const { default: nock } = await import("nock");
      nock.disableNetConnect();
      const github = request.action === "github.issue.read";
      scope = nock(github ? "https://api.github.com" : "https://www.googleapis.com", {
        reqheaders: { authorization: `Bearer ${token}` },
      }).get(github ? `/repos/${request.resource}/issues/${request.issueNumber}` : `/drive/v3/files/${request.resource}`);
      if (!github) scope = scope.query({ supportsAllDrives: true });
      scope = scope.delay(fixture.delayMs ?? 0).reply(fixture.status ?? 200, fixture.body);
    }
    // Supply only an ephemeral access token. Never pass App private keys, refresh
    // tokens, custom URLs, credentials for another account, or dynamic action names.
    const auth = { type: "OAUTH2", access_token: token };
    let result;
    if (request.action === "github.issue.read") {
      const [owner, repo] = request.resource.split("/");
      const raw = await githubModule.github.actions().get_issue_ai.run({ auth, propsValue: { owner, repo, issue_number: request.issueNumber } });
      if (!raw || raw.number !== request.issueNumber || typeof raw.title !== "string" || !["open", "closed"].includes(raw.state)) throw new Error();
      result = { number: raw.number, title: raw.title.slice(0,4096), state: raw.state };
    } else if (request.action === "google-drive.file.metadata") {
      const raw = await driveModule.googleDrive.actions().drive_get_file.run({ auth, propsValue: { file_id: request.resource } });
      if (!raw || raw.id !== request.resource || typeof raw.name !== "string" || typeof raw.mimeType !== "string") throw new Error();
      result = { id: raw.id, name: raw.name.slice(0,4096), mimeType: raw.mimeType.slice(0,256) };
    } else throw new Error();
    if (scope && !scope.isDone()) throw new Error();
    if (JSON.stringify(result).includes(token)) throw new Error();
    process.send?.({ ok: true, result });
  } catch {
    // Upstream errors can contain request headers, tokens, and response bodies.
    process.send?.({ ok: false });
  } finally {
    process.disconnect();
  }
});
