import { useTranslation } from 'react-i18next';
import { Moon, Sun, Monitor, LogOut, Languages } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUi } from '@/lib/store';
import { setLanguage as setI18n } from '@/lib/i18n';
import { setToken } from '@/lib/auth';
import { useEffect } from 'react';

export function Topbar() {
  const { t, i18n } = useTranslation();
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const language = useUi((s) => s.language);
  const setLanguage = useUi((s) => s.setLanguage);

  useEffect(() => {
    if (i18n.language !== language) void i18n.changeLanguage(language);
  }, [language, i18n]);

  const cycleTheme = () => {
    const order = ['light', 'dark', 'system'] as const;
    setTheme(order[(order.indexOf(theme) + 1) % order.length]);
  };

  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center justify-end gap-2 border-b bg-background/80 px-4 backdrop-blur">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => {
          const next = language === 'de' ? 'en' : 'de';
          setLanguage(next);
          setI18n(next);
        }}
        title={t('common.language')}
      >
        <Languages className="h-4 w-4" />
        <span className="ml-1 text-xs">{language.toUpperCase()}</span>
      </Button>

      <Button variant="ghost" size="icon" onClick={cycleTheme} title={t('common.theme')}>
        <ThemeIcon className="h-4 w-4" />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        title={t('common.logout')}
        onClick={() => {
          setToken(null);
          window.location.assign('/next/login');
        }}
      >
        <LogOut className="h-4 w-4" />
      </Button>
    </header>
  );
}
