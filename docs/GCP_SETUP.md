# Deploying Pawstories to GCP — Console + GitHub, no CLI

You already have a GCP project with billing enabled and code on GitHub. This is the click-path
setup for that exact situation: everything through the Google Cloud / Firebase Console UI, and
Cloud Run redeploys automatically on every push to your connected branch.

Two things in this repo were fixed to make that GitHub-triggered path actually work (details in
Step 1) — without them, the auto-build would silently ship a broken container.

---

## 0. What you end up with

One Cloud Run service on your existing project, connected to your GitHub repo so every push
rebuilds and redeploys automatically. Firebase (Auth + Firestore) lives on the same project. The
running container authenticates to Vertex AI and Firestore using an *attached* service account —
no JSON key file is ever uploaded or committed for production.

## 1. Two repo fixes this deploy path needed (already done)

Cloud Run's "deploy from source" (whether via Console+GitHub or the CLI) uses Google Cloud's
Buildpacks when there's no Dockerfile — as here. Two things buildpacks need that a plain
`gcloud`/local build doesn't:

- **`package.json` now has a `gcp-build` script.** Buildpacks only auto-run a script named exactly
  `gcp-build`, not `build` — without it, the container would start with `npm start` before
  `dist/server.cjs` ever got built, and crash immediately. Fixed: `"gcp-build": "npm run build"`.
- **A new `.env.production` file, deliberately committed to git** (there's a narrow `.gitignore`
  exception for it). Vite bakes `VITE_*` variables into the client bundle at *build* time — with a
  GitHub-triggered build, only committed files exist, so a gitignored `.env` isn't visible to it.
  The Firebase web config isn't a secret (it ships in every Firebase client bundle by design;
  access control is `firestore.rules` + OAuth, not a hidden key), so committing just those values
  is safe and is the standard fix. **Never** put server secrets in this file — read the warning
  comment at its top.

You'll fill in real values for `.env.production` in Step 9.

## 2. Enable the required APIs

Console → APIs & Services → Library, or jump straight to each one (replace `YOUR_PROJECT_ID`):

- `console.cloud.google.com/apis/library/aiplatform.googleapis.com?project=YOUR_PROJECT_ID`
- `console.cloud.google.com/apis/library/firestore.googleapis.com?project=YOUR_PROJECT_ID`
- `console.cloud.google.com/apis/library/identitytoolkit.googleapis.com?project=YOUR_PROJECT_ID`

Click **Enable** on each. Cloud Run, Cloud Build, and Artifact Registry APIs don't need enabling
here — Cloud Run's Console prompts you to enable those automatically the first time you create a
service, in Step 10.

## 3. Add Firebase to the project and register the web app

1. `console.firebase.google.com` → **Add project** → choose **your existing GCP project** from
   the dropdown (don't create a new one) → keep default options → Continue through the wizard.
2. Project Settings (gear icon) → **General** tab → scroll to "Your apps" → click the **Web** icon
   (`</>`) → nickname it (e.g. "Pawstories Web") → Register app.
3. Firebase shows a config object. Copy every field — you'll need it twice: once for local testing
   in Step 9's `.env`, once for the real deploy in Step 9's `.env.production`.

| From (SDK config) | To (env var) |
|---|---|
| `apiKey` | `VITE_FIREBASE_API_KEY` |
| `authDomain` | `VITE_FIREBASE_AUTH_DOMAIN` |
| `projectId` | `VITE_FIREBASE_PROJECT_ID` |
| `storageBucket` | `VITE_FIREBASE_STORAGE_BUCKET` |
| `messagingSenderId` | `VITE_FIREBASE_MESSAGING_SENDER_ID` |
| `appId` | `VITE_FIREBASE_APP_ID` |
| `measurementId` | `VITE_FIREBASE_MEASUREMENT_ID` *(optional)* |

## 4. Enable Google Sign-In

1. Firebase Console → Build → **Authentication** → Get started
2. **Sign-in method** tab → Add new provider → **Google** → Enable
3. Set a project support email (required) → Save

`localhost` is authorized by default. You'll add your live Cloud Run URL here in Step 12, once you
know it.

## 5. Configure the OAuth consent screen

1. `console.cloud.google.com` → APIs & Services → **OAuth consent screen**
2. User type: External → Create
3. App name, support email, developer contact email
4. Scopes: leave defaults (email, profile, openid)
5. While testing: add your own email under **Test users**
6. When ready for the public: **Publish app**

> Left in "Testing," only emails explicitly added as test users can sign in — everyone else sees
> an access-blocked screen.

## 6. Create the Firestore database

1. Firebase Console → Build → **Firestore Database** → Create database
2. Mode: **Native**
3. Location: pick one (e.g. `us-central1`) — **cannot be changed later**
4. Starting rules: either option is fine, since you'll overwrite them in the next step immediately

## 7. Publish the Firestore security rules

No CLI needed here — the Rules tab has a live editor:

1. Firestore Database → **Rules** tab
2. Open `firestore.rules` from this repo, select all, copy it
3. Paste it into the Rules editor, replacing the default content entirely
4. Click **Publish**

Re-do this any time `firestore.rules` changes in the repo — publishing isn't automatic.

## 8. Create the server's service account

One identity, two roles — this is what the running container authenticates as.

1. `console.cloud.google.com` → IAM & Admin → **Service Accounts** → **Create Service Account**
2. Name: `pawstories-app` → Create and continue
3. Grant it these two roles (search each by name in the role picker):
   - **Vertex AI User** (`roles/aiplatform.user`) — lets it call Gemini
   - **Firebase Admin SDK Administrator Service Agent**
     (`roles/firebase.sdkAdminServiceAgent`) — lets it verify sign-in tokens and read/write
     Firestore
4. Done

You do **not** need to download a key for this account unless you also want to test locally first
(optional, see Step 9) — Cloud Run will attach this identity directly to the running container in
Step 10, with no key file involved.

## 9. Fill in your env files

**`.env.production`** (commit and push this — see Step 1 for why that's safe):

```bash
VITE_FIREBASE_API_KEY="..."
VITE_FIREBASE_AUTH_DOMAIN="your-project.firebaseapp.com"
VITE_FIREBASE_PROJECT_ID="your-project"
VITE_FIREBASE_STORAGE_BUCKET="your-project.firebasestorage.app"
VITE_FIREBASE_MESSAGING_SENDER_ID="..."
VITE_FIREBASE_APP_ID="..."
VITE_FIREBASE_MEASUREMENT_ID="..."
VITE_FIREBASE_FIRESTORE_DATABASE_ID="(default)"
VITE_TEST_ACCOUNT_EMAILS=""
```

```bash
git add .env.production
git commit -m "Add production Firebase client config"
git push
```

**`.env`** *(optional — only if you want to test locally before pushing)*. Copy `.env.example` to
`.env`, fill in the same `VITE_FIREBASE_*` values plus the server-side ones:

```bash
GCP_PROJECT_ID="your-project"
GCP_LOCATION="us-central1"
GOOGLE_APPLICATION_CREDENTIALS="service-account.json"   # local-only key, see Step 8
FIREBASE_PROJECT_ID="your-project"
CREATOR_EMAIL="you@example.com"
```

To get `service-account.json` for local testing: Service Accounts → click `pawstories-app` → Keys
tab → Add Key → Create new key → JSON. This file is already covered by `.gitignore` — never commit
it.

## 10. Create the Cloud Run service, connected to GitHub

1. `console.cloud.google.com` → **Cloud Run** → **Create service**
2. Choose **Continuously deploy from a repository (source or function)**
3. **Set up with Cloud Build** → Repository provider: **GitHub** → **Connect new repository** →
   authorize the Google Cloud Build GitHub App → select this repo → grant access
4. Branch: your deploy branch (e.g. `^main$`)
5. Build type: leave on **auto-detect** — with no Dockerfile in the repo, it uses Buildpacks, which
   now works correctly thanks to the `gcp-build` script from Step 1
6. Service name and region (e.g. `us-central1` — same region as Step 6's Firestore database, ideally)
7. Authentication: **Allow unauthenticated invocations** (this is a public web app)
8. Expand **Container(s), Volumes, Networking, Security**:
   - **Security** tab → Service account → select **pawstories-app** (not the default Compute
     Engine service account)
   - **Variables & Secrets** tab → add the runtime environment variables from Step 11
   - **Autoscaling**: leave min instances at **0** (true scale-to-zero, no idle cost)
9. **Create**

The first build takes a few minutes — Cloud Build compiles the container, pushes it, and Cloud Run
starts serving. Every future push to the connected branch triggers this automatically.

## 11. Runtime environment variables to set in Step 10

These go in the Cloud Run service's **Variables & Secrets** tab — not in any file, since they're
read at container runtime, not baked into the build.

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `GCP_PROJECT_ID` | your project ID |
| `GCP_LOCATION` | e.g. `us-central1` |
| `FIREBASE_PROJECT_ID` | your project ID (same project) |
| `CREATOR_EMAIL` | your real email — server refuses to start notify-creator without it |
| `GEMINI_ANALYZE_MODEL` | `gemini-2.5-flash` |
| `GEMINI_IMAGE_MODEL` | `gemini-2.5-flash-image` |
| `LOG_LEVEL` | `info` |

Optional, only if using the SMTP notify-creator feature — `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`,
`SMTP_USER`, `SMTP_PASS`. For `SMTP_PASS` specifically, prefer the **"Reference a secret"** toggle
(Secret Manager) over a plain variable, since it's a real credential.

> Deliberately **do not set** `GOOGLE_APPLICATION_CREDENTIALS` or `FIREBASE_SERVICE_ACCOUNT_PATH`
> here, and never upload `service-account.json` into the container. The service account attached
> in Step 10 is picked up automatically via Cloud Run's metadata server — that's strictly safer
> than a key file baked into the image.

## 12. Finish the authorized-domains loop

Once the first deploy finishes, Cloud Run shows your live URL (`https://SERVICE-NAME-HASH.REGION.run.app`).
Add it to:

- Firebase Console → Authentication → Settings → **Authorized domains**
- Google Cloud Console → OAuth consent screen → **Authorized domains**

Google Sign-In will silently fail on the live URL until both are updated.

## 13. Verify

Open the Cloud Run URL, sign in with Google, upload a pet photo, confirm a dossier generates.

Check logs: Cloud Run → your service → **Logs** tab → confirm a `server.config` line shows your
real `firebaseProjectId`, and that generation requests show `analyze.done` / `image.done` events,
not repeated `analyze.failed`.

Confirm the auth wall is actually live (needs a terminal, the one place `curl` beats clicking):

```bash
curl -i -X POST https://YOUR-SERVICE-URL/api/analyze-pet \
  -H "Content-Type: application/json" -d '{}'
# should return 401, not attempt a Gemini call
```

## 14. How updates work from here

Every push to the connected branch rebuilds and redeploys automatically — no manual redeploy
step. The one thing that stays manual: if `firestore.rules` changes, re-paste and republish it in
the Firebase Console Rules tab (Step 7) — that's not wired to GitHub pushes.

## 15. Final checklist

- [ ] `gcp-build` script present in `package.json`, `.env.production` committed with real Firebase values
- [ ] Vertex AI, Firestore, Identity Toolkit APIs enabled
- [ ] Firebase added to the existing project, web app registered
- [ ] Google Sign-In provider enabled with a support email
- [ ] OAuth consent screen configured — test users added, or published
- [ ] Firestore database created (native mode)
- [ ] `firestore.rules` pasted and published in the Firebase Console Rules tab
- [ ] Service account created with `aiplatform.user` + `firebase.sdkAdminServiceAgent` roles
- [ ] Cloud Run service created, connected to GitHub, using that service account, min instances = 0
- [ ] Runtime env vars set in Cloud Run's Variables & Secrets tab (no credential paths)
- [ ] Live Cloud Run URL added to both Firebase and OAuth authorized domains
- [ ] Verified: sign-in works, a dossier generates, unauthenticated `curl` to `/api/analyze-pet` returns 401
