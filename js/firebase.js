import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  collection,
  deleteDoc,
  disableNetwork,
  doc,
  getDocFromCache,
  getDocFromServer,
  getDocsFromCache,
  getDocsFromServer,
  initializeFirestore,
  memoryLocalCache,
  onSnapshot,
  persistentLocalCache,
  persistentMultipleTabManager,
  query,
  serverTimestamp,
  setDoc,
  writeBatch
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const LEGACY_CACHE_MIGRATION_KEY = "calstat-firestore-cache-migrated-v1";
const firebaseApp = initializeApp(firebaseConfig);

function legacyMigrationComplete() {
  try {
    return localStorage.getItem(LEGACY_CACHE_MIGRATION_KEY) === "1";
  } catch {
    return true;
  }
}

export const needsLegacyCacheMigration = !legacyMigrationComplete();

// On the first 2.3 launch, open the old persistent cache with networking
// disabled. The store copies that device state into CalStat's explicit device
// snapshot before reloading with memory-only Firestore.
export const db = initializeFirestore(firebaseApp, {
  localCache: needsLegacyCacheMigration
    ? persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    : memoryLocalCache()
});

export const firestoreStartup = needsLegacyCacheMigration
  ? disableNetwork(db)
  : Promise.resolve();

export function completeLegacyCacheMigration() {
  try {
    localStorage.setItem(LEGACY_CACHE_MIGRATION_KEY, "1");
  } catch {
    throw new Error("CalStat could not preserve the device copy because browser storage is unavailable.");
  }
  window.location.reload();
}

export const auth = getAuth(firebaseApp);

export async function initializeAuthPersistence() {
  await setPersistence(auth, browserLocalPersistence);
}

export {
  collection,
  createUserWithEmailAndPassword,
  deleteDoc,
  doc,
  getDocFromCache,
  getDocFromServer,
  getDocsFromCache,
  getDocsFromServer,
  onAuthStateChanged,
  onSnapshot,
  query,
  sendPasswordResetEmail,
  serverTimestamp,
  setDoc,
  signInWithEmailAndPassword,
  signOut,
  writeBatch
};
