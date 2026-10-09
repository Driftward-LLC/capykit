/* global process */
// Only pinned, trusted connector actions run here. This is not an uploaded-code sandbox.
// Nock intercepts the connector's HTTP request and relays it to the authenticated
// parent broker. Provider credentials and environment variables never enter here.
import nock from 'nock';
import { randomUUID } from 'node:crypto';
nock.disableNetConnect();
process.once('message', async ({ action, resource, issueNumber, name, folderId }) => {
  try {
    const github = action === 'github.get-issue';
    const origin = github ? 'https://api.github.com' : 'https://www.googleapis.com';
    const search = action === 'drive.search-files';
    const path = search ? '/drive/v3/files' : github ? `/repos/${resource}/issues/${issueNumber}` : `/drive/v3/files/${resource}`;
    let requested = false;
    const query = `name contains '${name ?? ''}'${folderId ? ` and '${folderId}' in parents` : ''}`;
    let continuation;
    nock(origin).get(path).query(search ? params => params.q === query && params.pageSize === '1000' && params.supportsAllDrives === 'true' && Object.keys(params).every(k => ['q','fields','supportsAllDrives','includeItemsFromAllDrives','corpora','pageSize'].includes(k)) : github ? {} : { supportsAllDrives: 'true' }).reply(async () => {
      if (requested) throw new Error('Only one provider request is allowed');
      requested = true;
      return await new Promise((resolve, reject) => {
        process.once('message', message => {
          if (message.type !== 'response') return reject(new Error('Broker denied request'));
          // Deliberately execute one bounded page. Return continuation explicitly rather than
          // letting the upstream action's pagination loop consume the entire account.
          continuation = message.body.nextPageToken ?? null;
          resolve([200, search ? { files: message.body.files } : message.body]);
        });
        process.send({ type: 'request' });
      });
    });
    const auth = { type: 'OAUTH2', access_token: randomUUID() };
    let result;
    if (github) {
      const module = await import('@activepieces/piece-github');
      const [owner, repo] = resource.split('/');
      const value = await module.default.github.actions().get_issue_ai.run({ auth, propsValue: { owner, repo, issue_number: issueNumber } });
      if (value.number !== issueNumber || typeof value.title !== 'string' || !['open', 'closed'].includes(value.state)) throw new Error('Invalid issue');
      result = { number: value.number, title: value.title.slice(0, 4096), state: value.state };
    } else if (search) {
      const module = await import('@activepieces/piece-google-drive');
      const values = await module.default.googleDrive.actions().drive_search_files.run({auth,propsValue:{query_term:'name',operator:'contains',value:name ?? '',type:'all',parent_folder_id:folderId,include_team_drives:false}});
      if (!Array.isArray(values) || values.length > 25 || (continuation !== null && (typeof continuation !== 'string' || !/^[A-Za-z0-9_+=/-]{1,2048}$/.test(continuation)))) throw new Error('Invalid page');
      const files = values.map(value => {
        if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value.id) || typeof value.name !== 'string' || value.name.length > 4096 || typeof value.mimeType !== 'string' || value.mimeType.length > 256) throw new Error('Invalid file');
        return {id:value.id,name:value.name,mimeType:value.mimeType};
      });
      result = {files,nextPageToken:continuation};
    } else {
      const module = await import('@activepieces/piece-google-drive');
      const value = await module.default.googleDrive.actions().drive_get_file.run({ auth, propsValue: { file_id: resource } });
      if (value.id !== resource || typeof value.name !== 'string' || typeof value.mimeType !== 'string') throw new Error('Invalid file');
      result = { id: value.id, name: value.name.slice(0, 4096), mimeType: value.mimeType.slice(0, 256) };
    }
    if (!requested) throw new Error('No provider request');
    process.send({ type: 'result', result });
  } catch { process.send({ type: 'error' }); }
});
