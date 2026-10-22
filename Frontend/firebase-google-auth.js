import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  inMemoryPersistence,
  setPersistence,
  signInWithPopup
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';

const firebaseConfig = {
  apiKey: 'AIzaSyBbHB3sq-aq954tQfaq_Fk-0oh0ZzquZzY',
  authDomain: 'kieltech-71377.firebaseapp.com',
  projectId: 'kieltech-71377',
  storageBucket: 'kieltech-71377.firebasestorage.app',
  messagingSenderId: '449847035074',
  appId: '1:449847035074:web:b3e6684983e28ca339675b',
  measurementId: 'G-ZPY8KWKPT1'
};

const isLocal = ['localhost', '127.0.0.1', ''].includes(window.location.hostname);
const apiBase = window.KIELTECH_API_BASE_URL
  || (isLocal
    ? `http://${window.location.hostname || 'localhost'}:8000`
    : 'https://kieltech-backend.onrender.com');
const button = document.getElementById('googleSignInButton');
const message = document.getElementById('authMessage');

if (button && message) {
  const firebaseApp = initializeApp(firebaseConfig);
  const auth = getAuth(firebaseApp);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    message.className = 'demo-response form-status is-loading';
    message.textContent = 'Opening Google sign-in…';

    try {
      await setPersistence(auth, inMemoryPersistence);
      const credential = await signInWithPopup(auth, provider);
      const idToken = await credential.user.getIdToken();
      const response = await fetch(`${apiBase}/v1/auth/firebase/google`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_token: idToken })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || 'Google sign-in could not be completed.');

      localStorage.setItem('kieltechToken', payload.token);
      message.className = 'demo-response form-status is-success';
      message.textContent = `Welcome, ${payload.user?.name || 'back'}!`;
      const returnTo = new URLSearchParams(window.location.search).get('return_to');
      const safeReturnTo = returnTo && /^[-a-zA-Z0-9_/]+\.html(?:[?#].*)?$/.test(returnTo);
      window.location.assign(safeReturnTo ? returnTo : 'index.html');
    } catch (error) {
      const messages = {
        'auth/popup-closed-by-user': 'Google sign-in was closed before it completed.',
        'auth/cancelled-popup-request': 'A Google sign-in window is already open.',
        'auth/operation-not-allowed': 'Google sign-in is not enabled for this Firebase project.',
        'auth/unauthorized-domain': 'This website domain is not authorized in Firebase Authentication.',
        'auth/network-request-failed': 'Unable to reach Google sign-in. Check your connection and try again.'
      };
      message.className = 'demo-response form-status is-error';
      message.textContent = messages[error.code] || error.message || 'Google sign-in could not be completed.';
    } finally {
      button.disabled = false;
    }
  });
}
