# Hosted workspace access contract

This draft covers an in-memory authorization contract related to Linear ENG-121.
It does not implement durable storage, authentication, a hosted API, a worker,
or a browser console, and does not complete ENG-121. The hosted service,
migrations, and deployment configuration are implemented separately in
[PR #47](https://github.com/Driftward-LLC/capykit/pull/47). Reconcile this contract
with that implementation before treating it as a service integration.

Public catalog metadata stays in the existing registry paths. Hosted membership,
credentials, and runtime configuration belong in private application storage;
this module does not read or write that storage.

## Snapshot contract

`src/core/hosted-state.ts` accepts a trusted snapshot of workspace, principal, and
membership rows. It resolves an already authenticated external subject to an
active principal, then includes only active memberships in active workspaces.
Missing and disabled workspaces cannot be selected or authorized through the
resulting context. The default selection is the first accessible workspace;
request-supplied workspace IDs are selectors and never grant access.

Principal kind distinguishes humans from agents. Both use the scoped `owner`
and `member` roles; an agent does not borrow a human principal ID or need a
separate membership role. The helper checks workspace access only; it does not
implement role-specific operations or agent credential authentication.

`requireHostedWorkspaceAccess` checks the memberships resolved into this context.
`selectHostedWorkspaceRecords` filters supplied records to the selected workspace.
Neither helper queries a database or authenticates a request. A service must
construct this context from trusted, current rows on each protected request,
never from client-supplied rows or a cached context that survives deactivation.

## Service integration requirements

The hosted implementation must resolve authenticated identity and current
workspace membership on the server, enforce workspace scope in its database
queries, and reject disabled principals, memberships, and workspaces. In-memory
filtering alone is not a database isolation boundary.

The same-origin API and console must use secure HTTP-only session cookies and
enforce a session-bound CSRF token for unsafe browser requests. These are service
requirements, not functionality provided by this module. Use the hosted service's
migrations and bootstrap commands rather than a separate schema from this draft.

## Local verification scope

`tests/hosted-state.test.ts` covers subject-to-principal resolution, human/agent
distinction, cross-workspace rejection, disabled principals and memberships,
disabled or missing workspaces, and fallback to an accessible workspace. These
tests verify the snapshot contract only; they do not demonstrate persistence,
OTP login, sessions, CSRF enforcement, or browser behavior.
