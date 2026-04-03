import '@fortawesome/fontawesome-free/css/all.min.css';
import { boot } from './app/boot.js';

if (document.readyState === 'complete') {
  boot();
} else {
  window.addEventListener('load', boot);
}
