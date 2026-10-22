# KielTech

KielTech is a static AI developer-services website backed by both a FastAPI platform API and a Node.js supporting API.

## Project structure

- Frontend/ - static site assets
- kieltech-backend/ - FastAPI platform API for `/v1/*`
- Backend/ - Node.js supporting API for `/api/*`

## Run locally

The local services use these ports:

- `8000`: FastAPI `/v1/*` API and protected admin pages; `/` and `/index.html` redirect to the main frontend on port 8001
- `8001`: Node `/api/*` API and main frontend entry point

FastAPI backend (`8000`):

```powershell
cd kieltech-backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Node API and main frontend (`8001`):

`Backend/.env` contains a legacy `PORT=8000` value, so override it when starting Node to avoid conflicting with FastAPI.

```powershell
cd Backend
$env:PORT=8001
npm start
```

Then open:

- http://localhost:8001
- http://localhost:8000/health
- http://localhost:8001/api/health

Use `http://localhost:8001` for the main site. Requests to `/` or `/index.html` on port 8000 redirect to the configured `FRONTEND_URL`. The admin dashboard is served by FastAPI at `http://localhost:8000/admin/dashboard` and requires an administrator session.

The signed-in developer dashboard loads its active model inventory from `/v1/models/catalog` and account-scoped request, token, and cost activity from `/v1/dashboard/model-usage`. Usage reporting supports 7-, 30-, and 90-day periods and requires the user's authenticated session.

## Authentication

Email and password sign-in remain available. Google sign-in uses Firebase Authentication for the `kieltech-71377` Firebase project, and the FastAPI backend verifies each Firebase ID token before creating a KielTech session.

Accounts created with Google do not have password sign-in enabled by default. After signing in with Google, users can open **Settings → Edit account credentials** and set a password; they can then sign in using either their username or email and that password. Attempting password sign-in before setting one returns guidance to use Google sign-in.

In Firebase Console, enable **Authentication → Sign-in method → Google** and add each frontend hostname under **Authentication → Settings → Authorized domains** (including `localhost` for local development). Configure `FIREBASE_PROJECT_ID=kieltech-71377` and `FIREBASE_SERVICE_ACCOUNT_JSON` on the FastAPI service. The latter must contain the Firebase Admin service-account JSON as a server-side secret; never put it in the frontend or commit it. Google sign-in is unavailable until the backend credential is configured. The Firebase web-app config in the frontend is client configuration, not a service-account credential.

### Administrator roles

Roles are stored in Firestore at `user_roles/{firebaseAuthUid}` with a string `role` field. The supported privileged roles are `owner` and `admin`; `owner` includes all administrator access. To bootstrap the first owner, sign in to KielTech with Google once, find that account's Firebase UID in **Firebase Console → Authentication → Users**, then create `user_roles/{uid}` in **Firestore Database** with `role` set to the string `owner`. The homepage then shows an **Owner** link to the protected owner console.

From the owner console, the owner can grant or revoke `admin` for Google-linked KielTech accounts. Role writes are performed by the Python backend using its Firebase Admin service account; the browser cannot read or write role documents. The owner console refuses to change owner roles, so owners must be provisioned or changed directly in Firebase Console. To revoke an admin, use the owner console; to revoke an owner, change or remove their Firestore document in Firebase Console. The backend checks Firestore on privileged requests, so role changes take effect without waiting for the user's KielTech session to expire.

In **Firebase Console → Firestore Database → Rules**, publish the rules from [`firestore.rules`](./firestore.rules) so browser clients cannot read or modify role documents. Configure `FIREBASE_SERVICE_ACCOUNT_JSON` on the Python `kieltech-backend` service, and ensure its Firebase service account has permission to read and write the `user_roles` collection. Never grant users permission to write their own role.

The backend serves the owner console at `/owner/admins` and checks owner authorization for both the page and role-management API. The separate static frontend host can still serve legacy admin `.html` files directly; their browser guard redirects unauthorized users, but preventing the raw HTML shell from being fetched requires an edge redirect/proxy or excluding those files from the static host.

## AI Studio project limits

Studio projects support up to 1,000 files, 25 MB per file, and 100 MB total project content. These higher hard limits protect service availability and deployment processing; project storage is intentionally not unbounded.

Studio project files and editable purpose/style/constraint guidance are saved to the signed-in account. The Website Studio link in the service drawer opens the account's searchable project directory; selecting a project resumes it directly in Studio on any device. The directory's New project action opens a creation dialog; submitting a project name saves the project before opening it in Studio. Workspace edits are saved to the server automatically, and conversation history is isolated by project. The save indicator shows pending, saving, and failed states; the successful-save message is hidden. Administrators assign Studio models from the visible **Studio model assignments** table on the Models admin page. Only configured, ready text and vision models can be selected. Studio keeps up to 25 compressed restore points per project, with a 256 MB combined history limit, and creates a checkpoint before a file save changes the server copy. Restore preserves the current workspace as another checkpoint. Deployment history stores prior deployment file snapshots and can queue a new deployment from an earlier version.

Before deployment, Studio can run a server-side preflight that validates the saved files, local asset references, secret-like content, and provider configuration without submitting a deployment. The agent can inspect the actual preview at desktop and mobile viewport sizes, use browser interactions and assertions, and check browser console errors. Screenshots and page navigation are observations rather than proof that a user flow works; the agent must make and report explicit assertions for behavioral verification. **The current backend records deployments as queued and can queue a rollback from a saved deployment snapshot, but it does not connect a live deployment worker or provider status callback.** The UI labels these as queued requests and does not claim that a live site is deployed.

Studio can run the project's declared `test`, `build`, `typecheck`/`type-check`, or `lint` npm script from a temporary copy. It does not install dependencies; missing packages or scripts are reported as unavailable. Script checks are disabled by default in every environment and require `STUDIO_ENABLE_PROJECT_CHECKS=true` on the FastAPI service. They run with a restricted environment, without application secrets, in a temporary directory, with bounded output and a timeout, but **are not OS-sandboxed**. Do not enable them for untrusted projects; production use requires an external sandbox such as a locked-down container or isolated worker. Studio's per-run feature checklist quotes source excerpts as evidence of implementation, not proof of runtime behavior.

## Deploy

The repository includes [render.yaml](render.yaml) for a one-click Render Blueprint deployment. It creates the FastAPI API and static frontend services.

1. Create a Neon PostgreSQL project.
2. Copy Neon’s pooled connection string and use it as `DATABASE_URL` in the Render API service. It must start with `postgresql://`.
3. Create a Neon branch or separate database for tests and use its connection string as `KIELTECH_TEST_DATABASE_URL` only in CI/local test runs.
4. In Render, choose **New → Blueprint**, connect this repository, review `render.yaml`, and deploy.
5. Enter the `sync: false` secrets when Render asks for them.
6. Set `FRONTEND_URL`, `PUBLIC_BASE_URL`, and `CORS_ORIGINS` to the final HTTPS URLs after Render assigns them or after custom domains are attached.
7. Set Paystack's webhook to `{PUBLIC_BASE_URL}/v1/billing/webhook` and redeploy.

After the first setup, pushing to the connected branch automatically redeploys both services. The only recurring manual work is changing secrets or infrastructure settings.

For a Vercel-only frontend deployment, use the same `FRONTEND_URL` in the API service and `CORS_ORIGINS` in Render.

## Production checklist

Set `ENVIRONMENT=production` on the FastAPI service and configure all of these values:

- `DATABASE_URL`: PostgreSQL connection string for the production database
- `FRONTEND_URL` and `PUBLIC_BASE_URL`: HTTPS URLs for the deployed site and API
- `CORS_ORIGINS`: comma-separated HTTPS frontend origins only
- `FIREBASE_PROJECT_ID=kieltech-71377` and `FIREBASE_SERVICE_ACCOUNT_JSON`: Firebase Admin credentials for Google sign-in
- `PAYSTACK_SECRET_KEY`: live Paystack secret; configure Paystack's webhook URL as `{PUBLIC_BASE_URL}/v1/billing/webhook`
- `OPENROUTER_API_KEY` and `ENTERPRISE_PASSKEY_SECRET`
- `TAVILY_API_KEY` to enable Tavily web search in Website Studio
- `SENTRY_DSN`: production error monitoring destination

Production startup fails if required secrets, HTTPS URLs, payment configuration, or monitoring configuration are missing. Do not enable `KIELTECH_USE_MOCK` in production.

To enable KielChat and Website Studio web search, create a Tavily API key and set it as `TAVILY_API_KEY` on the FastAPI backend. The key stays server-side. Both use Tavily's basic search endpoint, which costs one API credit per search; Tavily currently documents 1,000 free credits per month with no credit card required. KielChat adds search context to substantive queries, while Studio can search when requested or when current external facts are needed. Search results are untrusted reference data; assistants should cite relevant source URLs. See [Tavily's credits and pricing](https://docs.tavily.com/documentation/api-credits).

Create a PostgreSQL backup from PowerShell with:

```powershell
$env:DATABASE_URL = 'postgresql://...'
.\scripts\backup_database.ps1
```

Restore only after confirming the target database is correct:

```powershell
.\scripts\restore_database.ps1 -BackupFile .\backups\kieltech-YYYYMMDD-HHMMSS.dump
```

Run tests only against a separate PostgreSQL database:

```powershell
$env:KIELTECH_TEST_DATABASE_URL = 'postgresql://.../kieltech_test'
pytest -q
```

The test suite refuses to start without `KIELTECH_TEST_DATABASE_URL`, preventing destructive test resets against production data.
