import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import de from '../locales/de.json';
import en from '../locales/en.json';

const STORAGE_KEY = 'shipyard_lang';

function detectLanguage(): 'de' | 'en' {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'de' || saved === 'en') return saved;
  } catch { /* ignore */ }
  const nav = (typeof navigator !== 'undefined' ? navigator.language : 'de').toLowerCase();
  return nav.startsWith('en') ? 'en' : 'de';
}

void i18n
  .use(initReactI18next)
  .init({
    resources: { de: { translation: de }, en: { translation: en } },
    lng: detectLanguage(),
    fallbackLng: 'de',
    interpolation: { escapeValue: false },
  });

export function setLanguage(lang: 'de' | 'en'): void {
  void i18n.changeLanguage(lang);
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* ignore */ }
}

export default i18n;
