import { initializeApp, getApp, getApps } from 'firebase/app';
import { getAuth, 
  GoogleAuthProvider, 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged,
  User as FirebaseUser 
} from 'firebase/auth';
import { writeBatch, getFirestore,
  doc,
  getDoc,
  setDoc,
  collection,
  getDocFromServer,
  serverTimestamp,
} from 'firebase/firestore';
// NOTE: Firebase web config (apiKey included) is not a secret — it identifies
// the project and ships inside every Firebase web client bundle by design.
// Access control is enforced by Firestore Security Rules + Google OAuth, not by
// hiding these values. They're still pulled from env so different environments
// (dev/staging/prod) can point at different Firebase projects without code edits.
const env = (import.meta as any).env;
function requireEnv(name: string): string {
  const value = env?.[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. Set it in .env (see .env.example).`);
  }
  return value;
}

const firebaseConfig = {
  apiKey: requireEnv('VITE_FIREBASE_API_KEY'),
  authDomain: requireEnv('VITE_FIREBASE_AUTH_DOMAIN'),
  projectId: requireEnv('VITE_FIREBASE_PROJECT_ID'),
  storageBucket: requireEnv('VITE_FIREBASE_STORAGE_BUCKET'),
  messagingSenderId: requireEnv('VITE_FIREBASE_MESSAGING_SENDER_ID'),
  appId: requireEnv('VITE_FIREBASE_APP_ID'),
  measurementId: env?.VITE_FIREBASE_MEASUREMENT_ID || '',
  firestoreDatabaseId: env?.VITE_FIREBASE_FIRESTORE_DATABASE_ID || '(default)'
};

// --- Types ---
export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

let app;
let db: any;
let auth: any;

if (getApps().length === 0) {
  app = initializeApp(firebaseConfig);
} else {
  app = getApp();
}

// Initialize Firestore with Database ID from configuration
db = getFirestore(app, firebaseConfig.firestoreDatabaseId || '(default)');
auth = getAuth(app);

// Global Error Handler for secure rules debugging
export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth?.currentUser?.uid,
      email: auth?.currentUser?.email,
      emailVerified: auth?.currentUser?.emailVerified,
      isAnonymous: auth?.currentUser?.isAnonymous,
      tenantId: auth?.currentUser?.tenantId,
      providerInfo: auth?.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error details: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Validation function as requested in skill
export async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn("Please check your Firebase configuration: client appears offline.");
    }
  }
}

if (typeof window !== 'undefined') {
  testConnection();
}

// --- Auth Helpers ---
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export async function loginWithGoogle() {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (error) {
    console.error("Google Auth Fail:", error);
    throw error;
  }
}

export async function logoutUser() {
  try {
    await signOut(auth);
  } catch (error) {
    console.error("Logout Fail:", error);
  }
}

export { auth, db, onAuthStateChanged };
export type { FirebaseUser };

// --- Firestore Business Logic Helpers ---
export interface UserProfile {
  email: string;
  displayName: string;
  generationCount: number;
  lastGenerationMonth?: string;
  requestedAmount?: number;
  requestStatus?: 'none' | 'requested';
  createdAt?: unknown; // Firestore server timestamp — used for admin "new users" reporting only
}

/**
 * Reads the user's profile for display purposes, creating a fresh one on first
 * sign-in. This is READ/CREATE only — generationCount and lastGenerationMonth
 * are exclusively owned by the server (server.ts's checkAndIncrementQuota, via
 * the Admin SDK) so the client can no longer forge its own quota. The count
 * shown here may lag by a few seconds after a month rollover until the user's
 * next generation, at which point the server's response carries the fresh count.
 */
export async function getOrCreateUserProfile(user: FirebaseUser): Promise<UserProfile> {
  const userDocRef = doc(db, 'users', user.uid);
  const pathForError = `users/${user.uid}`;

  try {
    const docSnap = await getDoc(userDocRef);
    if (docSnap.exists()) {
      return docSnap.data() as UserProfile;
    }

    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    const defaultProfile: UserProfile = {
      email: user.email || '',
      displayName: user.displayName || 'Anonymous Agent',
      generationCount: 0,
      lastGenerationMonth: currentMonth,
      requestStatus: 'none',
      requestedAmount: 0
    };
    // createdAt must go in this initial CREATE, not a later update — firestore.rules
    // restricts client UPDATEs to only ['requestedAmount', 'requestStatus'], so a
    // separate merge-update adding createdAt afterward would be silently rejected.
    await setDoc(userDocRef, { ...defaultProfile, createdAt: serverTimestamp() });
    return defaultProfile;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, pathForError);
    throw err;
  }
}

/**
 * Creates an entry in requests subcollection and updates user status
 */


export async function submitQuotaRequest(userId: string, email: string, quantity: number) {
  const requestsColRef = doc(collection(db, 'requests'));
  const userDocRef = doc(db, 'users', userId);
  
  try {
    const batch = writeBatch(db);
    const timestampStr = new Date().toISOString();
    
    batch.set(requestsColRef, {
      userId,
      email,
      requestedQuantity: quantity,
      createdAt: timestampStr,
      status: 'pending'
    });

    batch.update(userDocRef, {
      requestStatus: 'requested',
      requestedAmount: quantity
    });
    
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'requests_and_users');
    throw err;
  }
}
