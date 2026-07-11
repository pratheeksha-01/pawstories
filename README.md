# pawstories.fun

Upload a photo of your pet and Gemini generates a satirical "undercover secret agent"
dossier — codename, secret weapon, arch-rival, zoomies trigger — plus an optional AI-generated
spy portrait. Google sign-in gates a 3-generation/month free quota (enforced server-side),
with a request-more-credits flow that emails the creator.

## Stack

- **Frontend:** React 19 + TypeScript, Vite, Tailwind CSS
- **Backend:** Express (`server.ts`), talking to Gemini via Vertex AI
- **Auth + data:** Firebase Auth (Google sign-in) + Firestore, enforced through
  `firebase-admin` on the server — the client is never trusted for quota or auth
- **Admin:** `/admin` — a KPI dashboard (users, generations, cost, reliability) gated to
  emails on the `ADMIN_EMAILS` allowlist

## Project structure

- App entry points: [index.html](index.html), [server.ts](server.ts), [src/App.tsx](src/App.tsx)
- Application source: [src](src) — pet generator ([src/features/pet-generator](src/features/pet-generator)),
  admin dashboard ([src/features/admin](src/features/admin)), Firebase client ([src/lib/firebase.ts](src/lib/firebase.ts))
- Firestore security rules: [firestore.rules](firestore.rules)
- GCP/Firebase setup + deployment runbook: [docs/GCP_SETUP.md](docs/GCP_SETUP.md)

## Run locally

**Prerequisites:** Node.js, a GCP project with Vertex AI + Firebase set up (see
[docs/GCP_SETUP.md](docs/GCP_SETUP.md) if you're starting from scratch).

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and fill in the Firebase (`VITE_FIREBASE_*`), Vertex AI
   (`GCP_PROJECT_ID`, `GCP_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`), and Firebase
   Admin (`FIREBASE_PROJECT_ID`) values — every var is documented inline in that file
3. Run the app: `npm run dev`

## Deploying

See [docs/GCP_SETUP.md](docs/GCP_SETUP.md) for the full Console-based GCP + Firebase
setup and Cloud Run deployment path (connected to GitHub, redeploys on every push).
