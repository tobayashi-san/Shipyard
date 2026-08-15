import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en.json';

// Earlier releases stored a per-browser language preference. English is now
// the product language, so a legacy German preference must not leak into API
// messages or reappear in a later session.
try { localStorage.removeItem('shipyard_lang'); } catch { /* storage unavailable */ }

void i18n
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en } },
    lng: 'en',
    fallbackLng: 'en',
    supportedLngs: ['en'],
    interpolation: { escapeValue: false },
  });

export default i18n;
