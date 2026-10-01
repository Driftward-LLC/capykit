/* global process */
// Only pinned, trusted connector actions run here. This is not an uploaded-code sandbox.
// Nock intercepts the connector's HTTP request and relays it to the authenticated
// parent broker. Provider credentials and environment variables never enter here.
import nock from 'nock';
nock.disableNetConnect();
process.once('message', async ({ action, resource, issueNumber }) => {
  try {
    const github = action === 'github.get-issue';
    const origin = github ? 'https://api.github.com' : 'https://www.googleapis.com';
    const path = github ? `/repos/${resource}/issues/${issueNumber}` : `/drive/v3/files/${resource}`;
    let requested = false;
    nock(origin).get(path).query(github ? {} : { supportsAllDrives: 'true' }).reply(async () => {
      if (requested) throw new Error('Only one provider request is allowed');
      requested = true;
      return await new Promise((resolve, reject) => {
        process.once('message', message => message.type === 'response' ? resolve([200, message.body]) : reject(new Error('Broker denied request')));
        process.send({ type: 'request' });
      });
    });
    const auth = { type: 'OAUTH2', access_token: 'capykit-brokered-transport' };
    let result;
    if (github) {
      const module = await import('@activepieces/piece-github');
      const [owner, repo] = resource.split('/');
      const value = await module.default.github.actions().get_issue_ai.run({ auth, propsValue: { owner, repo, issue_number: issueNumber } });
      if (value.number !== issueNumber || typeof value.title !== 'string' || !['open', 'closed'].includes(value.state)) throw new Error('Invalid issue');
      result = { number: value.number, title: value.title.slice(0, 4096), state: value.state };
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
