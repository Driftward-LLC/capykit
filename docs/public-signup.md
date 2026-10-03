# Public Google signup

Customers open the public Capykit URL, select Continue with Google, and choose
an account. A verified new account receives its own workspace and human owner
membership. Existing accounts retain their workspace and current role. Nobody
joins Driftward based on an email address or domain. Customers never register
OAuth clients or enter credentials in Capykit.

Signup requests only identity scopes (`openid email profile`). Google Drive
access remains a separate, explicitly consented connection. Native GoTrue owns
Google state, provider verification, code expiry and one-time PKCE exchange.
Capykit keeps the browser verifier in a short-lived, private cookie, validates
native sessions, and provisions through a restricted database function.

## Platform configuration

This is operator work. Public signup remains unavailable until the dedicated
Google Web client is registered and enabled in GoTrue; an installed connector
package does not supply that registration. ENG-141 tracks that prerequisite.
Use an External Google audience for customers outside the organization. Testing restricts Drive consent to registered test users. Google documents an
exception for identity-only login scopes; publish and complete applicable
verification before offering Drive connections broadly. See
[Google audience settings](https://support.google.com/cloud/answer/15549945).

1. Register the Google Web client for the public origin. With a public origin of
   `https://srv1379035.tail5c6a78.ts.net:10000`, the **login** callback is:

   ```text
   https://srv1379035.tail5c6a78.ts.net:10000/v1/auth/google/provider/callback
   ```

   Also register `/v1/connections/google/callback` on each origin where Drive
   connection is offered, including the private preview if retained. Import
   Google's downloaded file using `scripts/configure-google-oauth.mjs` as
   described in [app integrations](app-integrations.md#google-operator-setup).
2. Keep credentials private. Compose needs both the deployment environment file
   and the Google environment file through `--env-file` so it can map the Google
   client into GoTrue. Set these non-secret values in operator configuration:

   ```text
   CAPYKIT_PUBLIC_SIGNUP_BASE_URL=https://srv1379035.tail5c6a78.ts.net:10000
   CAPYKIT_PUBLIC_HTTP_PORT=19124
   CAPYKIT_AUTH_GOOGLE_ENABLED=true
   CAPYKIT_DISABLE_SIGNUP=false
   CAPYKIT_AUTH_GOOGLE_REDIRECT_URI=https://srv1379035.tail5c6a78.ts.net:10000/v1/auth/google/provider/callback
   CAPYKIT_AUTH_REDIRECT_ALLOW_LIST=https://srv1379035.tail5c6a78.ts.net:19121,https://srv1379035.tail5c6a78.ts.net:10000/v1/auth/google/callback
   ```

   An actual public hostname can replace this preview origin. Only the fixed
   callback proxy is exposed; GoTrue admin, signup and token endpoints stay on
   the private Docker network. Email-code endpoints are disabled on public-app.
3. Back up PostgreSQL and apply migration `007_public_google_signup.sql` with the
   schema owner after migrations 001–006. Fresh deployments apply all seven in
   `deploy/init-postgres.sh`. Runtime gains EXECUTE on one narrow function, not
   direct identity/membership writes or schema-owner credentials. The function
   serializes callbacks for each verified account ID, creates random workspace
   IDs, and rejects existing inactive, unverified or agent bindings.
4. Validate Compose with the existing deployment arguments and both private env
   files. Recreate the auth service to enable the native Google provider, and
   start only `public-app` using `--profile public`. The public app reuses the
   existing image and database. It does not inherit the private GitHub credentials
   or provider volume, whose registered callback belongs to the private origin. Preserve the private app,
   PostgreSQL and inbox. Public session/refresh cookies have distinct names,
   so private preview sessions do not silently bypass customer signup.
5. Configure the HTTPS public route. Before changing Tailscale, capture the
   current configuration and verify every existing handler. Port 10000 currently
   belongs to Capykit's webhook ingress: preserve `/v1/webhooks/github` on its
   existing loopback target before routing `/` to public-app on port 19124.
   Never replace another service's route or expose the private sign-in service,
   inbox, auth port, or database. Google availability in the UI is checked from
   GoTrue settings; missing configuration shows a customer retry state.

## Acceptance

Verify the public URL from outside the tailnet, in a new browser. With a Google
account not previously invited, select Continue with Google, authorize identity
access, and confirm its own empty workspace. Reload and revisit to verify the
remembered native session; log out and confirm it cannot renew. Verify a second
account cannot see the first workspace's capabilities or connections. Confirm
returning members retain their role and revoked users cannot provision again.

At phone widths, check readable signup/cancellation/unavailable states, usable
touch targets and no horizontal overflow. Test Google Drive consent separately.
Native-provider fixtures and local database tests do not establish successful
live Google login. Record that claim only after an actual customer callback.
