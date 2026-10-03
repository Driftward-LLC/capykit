# Code-free sign-in for the private preview

The Tailscale-hosted preview can use the device owner's existing Tailscale
identity instead of an email code. First visits open the workspace
automatically. Sign out revokes the current browser's GoTrue session and shows
**Continue with Tailscale**. Refreshing or opening a new visit can sign in again
while that device remains authenticated to Tailscale. This does not sign the
device out of Tailscale.

This optional mode requires Tailscale Serve, an HTTPS `.ts.net` origin, and a
backend published **only on host loopback**. Serve strips and replaces
caller-provided `Tailscale-User-Login` headers. The API additionally requires
the exact configured socket peer IP; it never trusts `X-Forwarded-For` for
authentication. With Docker's loopback port publishing, this peer is normally
the dedicated Compose network's host gateway. Other local services and
privileged host operators remain within the trusted host boundary. Do not expose
the backend on a LAN address, join it to an untrusted shared Docker network, use
Funnel for this preview route, or enable this mode behind an arbitrary proxy.

Configure all five server-only values together:

- `CAPYKIT_TAILSCALE_LOGIN`: exact verified Tailscale user login,
  including its identity-provider suffix.
- `CAPYKIT_TAILSCALE_EMAIL`: existing confirmed Capykit/GoTrue email.
- `CAPYKIT_TAILSCALE_SUBJECT`: existing GoTrue user UUID, bound to an invited
  human principal.
- `CAPYKIT_TAILSCALE_PROXY_ADDRESS`: exact trusted local proxy peer IP;
  no CIDR or wildcard.
- `CAPYKIT_TAILSCALE_SERVICE_KEY`: private GoTrue service-role JWT signed
  using that auth deployment's key. Track expiration and rotate before expiry.

Never put the service key in a browser bundle, URL, committed env file, log, PR,
or Linear issue. Store operator env files with mode 0600. Leave these values
unset to retain the existing email sign-in for other deployments. A partial
configuration fails startup.

The mapping currently supports one explicitly configured preview user. It grants
no membership or owner role and creates no Capykit accounts. The API checks
active human membership, asks GoTrue for the mapped, already confirmed user,
exchanges a native server-only magic-link hash, then verifies the resulting
subject and current membership again. No email is sent and no hash or credential
is returned to the browser. Each sign-in gets ordinary GoTrue access/refresh
cookies, its own session identifier, rotation and revocation. Existing bearer
APIs, CSRF protections and browser-session-bound provider setup are retained. A
new sign-in discards callbacks bound to an expired prior session.

Unmapped users, shared-node visitors with other identities, and tagged devices
do not inherit the preview user's access. Their browser shows an access message
and a retry action. Inactivity or account revocation still prevents workspace
access.

Sources:

- [Tailscale Serve identity headers][serve]
- [GoTrue generateLink][generate-link]
- [GoTrue verifyOtp][verify-otp]

[serve]: https://tailscale.com/docs/features/tailscale-serve
[generate-link]:
  https://supabase.com/docs/reference/javascript/auth-admin-generatelink
[verify-otp]: https://supabase.com/docs/reference/javascript/auth-verifyotp

Validation: `npm run factory:verify` and `scripts/test-tailscale-sign-in.mjs`
with the authorized Playwright installation. Browser coverage includes fresh
phone/desktop access, remembered reload, sign out, continuing without codes,
identity denial, outages/retries, existing-session expiry, and sign out during a
sign-in-method outage.
