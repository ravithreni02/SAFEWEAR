import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword as firebaseSignInWithEmailAndPassword,
  createUserWithEmailAndPassword as firebaseCreateUserWithEmailAndPassword,
  updateProfile as firebaseUpdateProfile,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  type Auth,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  runTransaction,
  serverTimestamp,
  type Firestore,
} from 'firebase/firestore';
import type { AuthUser, UserProfile } from '../types/wearable';

const LOCAL_USERS_KEY = 'safewear_users_v1';
const LOCAL_SESSION_KEY = 'safewear_session_v1';

interface StoredLocalUser extends UserProfile {
  password: string;
}

class LocalAuthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
};

const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId
);

let firebaseApp: FirebaseApp | null = null;
let firebaseAuth: Auth | null = null;
let firebaseDb: Firestore | null = null;

if (isFirebaseConfigured) {
  firebaseApp =
    getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
  firebaseAuth = getAuth(firebaseApp);
  firebaseDb = getFirestore(firebaseApp);
}

// Local auth state listeners when Firebase env vars are not configured
const localListeners = new Set<(user: AuthUser | null) => void>();

const DEFAULT_DEMO_USER: StoredLocalUser = {
  uid: 'safewear_demo_user',
  name: 'SafeWear User',
  email: 'demo@safewear.app',
  password: 'safewear123',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function getLocalUsers(): Record<string, StoredLocalUser> {
  try {
    const raw = localStorage.getItem(LOCAL_USERS_KEY);
    const stored = raw ? (JSON.parse(raw) as Record<string, StoredLocalUser>) : {};
    if (!stored[DEFAULT_DEMO_USER.email]) {
      stored[DEFAULT_DEMO_USER.email] = DEFAULT_DEMO_USER;
    }
    return stored;
  } catch {
    return { [DEFAULT_DEMO_USER.email]: DEFAULT_DEMO_USER };
  }
}

function saveLocalUsers(users: Record<string, StoredLocalUser>): void {
  localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(users));
}

function getLocalSession(): AuthUser | null {
  try {
    const raw = localStorage.getItem(LOCAL_SESSION_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

function setLocalSession(user: AuthUser | null): void {
  if (user) {
    localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify(user));
  } else {
    localStorage.removeItem(LOCAL_SESSION_KEY);
  }
  localListeners.forEach((cb) => cb(user));
}

export function friendlyAuthError(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const rawCode = String((error as { code: string }).code);
    const code = rawCode.replace(/^auth\//, '');
    switch (code) {
      case 'email-already-in-use':
        return 'This email is already registered. Please log in.';
      case 'invalid-email':
        return 'Please enter a valid email address.';
      case 'weak-password':
        return 'Choose a stronger password (at least 6 characters).';
      case 'user-not-found':
      case 'wrong-password':
      case 'invalid-credential':
        return 'Incorrect email or password.';
      case 'network-request-failed':
        return 'Network error. Check your internet connection.';
      default:
        if ('message' in error && typeof (error as { message: unknown }).message === 'string') {
          return (error as { message: string }).message;
        }
        return 'Authentication failed. Please try again.';
    }
  }
  return `Something went wrong: ${String(error)}`;
}

export function subscribeToAuthState(
  callback: (user: AuthUser | null) => void
): () => void {
  if (firebaseAuth) {
    return onAuthStateChanged(firebaseAuth, (fbUser) => {
      if (fbUser) {
        callback({
          uid: fbUser.uid,
          email: fbUser.email,
          displayName: fbUser.displayName,
        });
      } else {
        callback(null);
      }
    });
  }

  localListeners.add(callback);
  callback(getLocalSession());
  return () => {
    localListeners.delete(callback);
  };
}

async function syncUserProfileToFirestore(
  uid: string,
  name: string,
  email: string
): Promise<void> {
  if (!firebaseDb) return;
  const userRef = doc(firebaseDb, 'users', uid);

  await runTransaction(firebaseDb, async (transaction) => {
    const snapshot = await transaction.get(userRef);
    const data: Record<string, unknown> = {
      uid,
      name,
      email,
      updatedAt: serverTimestamp(),
    };
    if (!snapshot.exists()) {
      data.createdAt = serverTimestamp();
    }
    transaction.set(userRef, data, { merge: true });
  });
}

export async function submitEmailPasswordAuth(params: {
  isLogin: boolean;
  name: string;
  email: string;
  password: string;
}): Promise<void> {
  const email = params.email.trim();
  const password = params.password;
  const name = params.name.trim();

  if (firebaseAuth) {
    if (params.isLogin) {
      await firebaseSignInWithEmailAndPassword(firebaseAuth, email, password);
    } else {
      const credential = await firebaseCreateUserWithEmailAndPassword(
        firebaseAuth,
        email,
        password
      );
      if (name.length > 0) {
        await firebaseUpdateProfile(credential.user, { displayName: name });
        await credential.user.reload();
      }
    }

    const user = firebaseAuth.currentUser;
    if (user) {
      await syncUserProfileToFirestore(
        user.uid,
        name.length > 0 ? name : (user.displayName ?? ''),
        user.email ?? email
      );
    }
    return;
  }

  // LocalStorage fallback auth when Firebase env vars are not configured
  if (!email || !email.includes('@')) {
    throw new LocalAuthError('auth/invalid-email', 'Please enter a valid email address.');
  }
  if (password.length < 6) {
    throw new LocalAuthError(
      'auth/weak-password',
      'Choose a stronger password (at least 6 characters).'
    );
  }

  const normalizedEmail = email.toLowerCase();
  const users = getLocalUsers();
  const now = new Date().toISOString();

  if (params.isLogin) {
    const existing = users[normalizedEmail];
    if (!existing || existing.password !== password) {
      throw new LocalAuthError(
        'auth/invalid-credential',
        'Incorrect email or password.'
      );
    }
    existing.updatedAt = now;
    users[normalizedEmail] = existing;
    saveLocalUsers(users);

    setLocalSession({
      uid: existing.uid,
      email: existing.email,
      displayName: existing.name,
    });
  } else {
    if (users[normalizedEmail]) {
      throw new LocalAuthError(
        'auth/email-already-in-use',
        'This email is already registered. Please log in.'
      );
    }

    const uid =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `user_${Date.now()}`;

    const newUser: StoredLocalUser = {
      uid,
      name,
      email,
      password,
      createdAt: now,
      updatedAt: now,
    };
    users[normalizedEmail] = newUser;
    saveLocalUsers(users);

    setLocalSession({
      uid: newUser.uid,
      email: newUser.email,
      displayName: newUser.name,
    });
  }
}

export async function signInWithGoogleAuth(): Promise<void> {
  if (firebaseAuth) {
    const provider = new GoogleAuthProvider();
    const result = await signInWithPopup(firebaseAuth, provider);
    const user = result.user;
    await syncUserProfileToFirestore(
      user.uid,
      user.displayName ?? '',
      user.email ?? ''
    );
    return;
  }

  // TODO: Configure VITE_FIREBASE_* environment variables to use live Firebase Google OAuth.
  // Local fallback session so the Google Sign-In flow works cleanly without external keys.
  const now = new Date().toISOString();
  const demoEmail = 'safewear.user@gmail.com';
  const users = getLocalUsers();
  const existing = users[demoEmail];

  const userProfile: StoredLocalUser = existing
    ? { ...existing, updatedAt: now }
    : {
        uid: 'google_demo_user',
        name: 'SafeWear User',
        email: demoEmail,
        password: '',
        createdAt: now,
        updatedAt: now,
      };

  users[demoEmail] = userProfile;
  saveLocalUsers(users);

  setLocalSession({
    uid: userProfile.uid,
    email: userProfile.email,
    displayName: userProfile.name,
  });
}

export async function signOutAuth(): Promise<void> {
  if (firebaseAuth) {
    await firebaseSignOut(firebaseAuth);
    return;
  }
  setLocalSession(null);
}
