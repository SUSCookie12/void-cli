import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import { getFirestore, type Firestore } from 'firebase/firestore';

// Borgov Dev main site Firebase configuration (cookiemovie-27669)
const firebaseConfig = {
  apiKey: "AIzaSyAxkQA5tBqp_5fco6Y_8i2mhI15ECJeNh0",
  authDomain: "cookiemovie-27669.firebaseapp.com",
  databaseURL: "https://cookiemovie-27669-default-rtdb.firebaseio.com",
  projectId: "cookiemovie-27669",
  storageBucket: "cookiemovie-27669.appspot.com",
  messagingSenderId: "845488313573",
  appId: "1:845488313573:web:e4928462b97eb4dda4300c",
  measurementId: "G-YSQ6FLGCH1",
};

let _app: FirebaseApp | null = null;
let _db: Firestore | null = null;

export function initFirebase(): void {
  if (_app) return;
  _app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
  _db = getFirestore(_app);
}

export function getDb(): Firestore {
  if (!_db) {
    initFirebase();
  }
  return _db!;
}
