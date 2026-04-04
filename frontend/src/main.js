import '@fortawesome/fontawesome-free/css/all.min.css';
import { boot } from './app/boot.js';

async function registerPwa() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.warn('PWA service worker registration failed', err);
  }
}

if (document.readyState === 'complete') {
  boot();
  registerPwa();
} else {
  window.addEventListener('load', () => {
    boot();
    registerPwa();
  });
}
