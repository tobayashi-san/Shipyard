import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Paintbrush, Save, Image as ImageIcon, X, Anchor, Server, Terminal, Shield, Boxes, Network } from 'lucide-react';
import { api } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { useSettings } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { SettingsRow, SettingsSection } from '../_row';

export const LOGO_ICONS: Array<{ value: string; label: string; Icon: React.ComponentType<{ className?: string }> }> = [
  { value: 'anchor', label: 'Anchor', Icon: Anchor },
  { value: 'server', label: 'Server', Icon: Server },
  { value: 'terminal', label: 'Terminal', Icon: Terminal },
  { value: 'shield', label: 'Shield', Icon: Shield },
  { value: 'boxes', label: 'Boxes', Icon: Boxes },
  { value: 'network', label: 'Network', Icon: Network },
];

const DEFAULTS = {
  appName: '',
  appTagline: '',
  accentColor: '#3b82f6',
  showIcon: true,
  logoIcon: 'anchor',
  logoImage: '',
};

interface WhiteLabel {
  appName?: string;
  appTagline?: string;
  accentColor?: string;
  showIcon?: boolean;
  logoIcon?: string;
  logoImage?: string;
}

export function AppearanceTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const wl = (settings as unknown as WhiteLabel) || {};

  const [appName, setAppName]       = useState(wl.appName || '');
  const [tagline, setTagline]       = useState(wl.appTagline || '');
  const [color, setColor]           = useState(wl.accentColor || DEFAULTS.accentColor);
  const [showIcon, setShowIcon]     = useState(wl.showIcon !== false);
  const [logoIcon, setLogoIcon]     = useState(wl.logoIcon || DEFAULTS.logoIcon);
  const [logoImage, setLogoImage]   = useState(wl.logoImage || '');
  const fileRef = useRef<HTMLInputElement>(null);

  // Hydrate when settings load
  useEffect(() => {
    setAppName(wl.appName || '');
    setTagline(wl.appTagline || '');
    setColor(wl.accentColor || DEFAULTS.accentColor);
    setShowIcon(wl.showIcon !== false);
    setLogoIcon(wl.logoIcon || DEFAULTS.logoIcon);
    setLogoImage(wl.logoImage || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const save = useMutation({
    mutationFn: (data: Record<string, unknown>) => api.saveSettings(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      showToast(t('set.toastSaved'), 'success');
    },
    onError: () => showToast(t('set.toastErrorSave'), 'error'),
  });

  const reset = useMutation({
    mutationFn: () =>
      api.saveSettings({ appName: '', appTagline: '', accentColor: '', logoIcon: '', logoImage: '', showIcon: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      setAppName(''); setTagline(''); setColor(DEFAULTS.accentColor);
      setShowIcon(true); setLogoIcon(DEFAULTS.logoIcon); setLogoImage('');
      showToast(t('set.toastReset'), 'success');
    },
    onError: () => showToast(t('set.toastErrorReset'), 'error'),
  });

  const handleSave = () => {
    save.mutate({
      appName: appName.trim() || undefined,
      appTagline: tagline.trim() || undefined,
      accentColor: color,
      showIcon,
      logoIcon,
      logoImage: logoImage || '',
    });
  };

  const handleFile = (file: File | null) => {
    if (!file) return;
    if (file.size > 150 * 1024) {
      showToast(t('set.logoTooLarge'), 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setLogoImage(reader.result);
        showToast(t('set.logoLoaded'), 'success');
      }
    };
    reader.onerror = () => showToast(t('set.logoReadError'), 'error');
    reader.readAsDataURL(file);
  };

  return (
    <SettingsSection
      icon={<Paintbrush className="h-4 w-4" />}
      title={t('set.whiteLabel')}
      description={t('set.brandingDesc')}
    >
      <SettingsRow label={t('set.appName')} hint={t('set.appNameHint')}>
        <Input
          value={appName}
          onChange={(e) => setAppName(e.target.value)}
          placeholder="Shipyard"
          className="max-w-xs"
        />
      </SettingsRow>

      <SettingsRow label={t('set.tagline')} hint={t('set.taglineHint')}>
        <Input
          value={tagline}
          onChange={(e) => setTagline(e.target.value)}
          placeholder="Infrastructure"
          className="max-w-xs"
        />
      </SettingsRow>

      <SettingsRow label={t('set.accentColor')} hint={t('set.accentColorHint')}>
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="h-9 w-12 cursor-pointer rounded border border-input bg-background"
        />
        <Input
          value={color}
          onChange={(e) => {
            const v = e.target.value;
            setColor(v);
          }}
          className="max-w-[140px] font-mono"
          placeholder="#3b82f6"
        />
      </SettingsRow>

      <SettingsRow label={t('set.sidebarIcon')} hint={t('set.sidebarIconHint')}>
        <div className="flex flex-wrap items-center gap-3">
          <Switch checked={showIcon} onCheckedChange={setShowIcon} />
          <select
            value={logoIcon}
            onChange={(e) => setLogoIcon(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            {LOGO_ICONS.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
          />
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
            <ImageIcon className="h-4 w-4" /> {t('set.logoUpload')}
          </Button>
          {logoImage && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => { setLogoImage(''); if (fileRef.current) fileRef.current.value = ''; }}
            >
              <X className="h-4 w-4" /> {t('set.removeLogo')}
            </Button>
          )}
        </div>
      </SettingsRow>

      <SettingsRow label={null} noBorder>
        <Button onClick={handleSave} disabled={save.isPending} size="sm">
          <Save className="h-4 w-4" /> {save.isPending ? t('set.saving') : t('set.saveApply')}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => reset.mutate()} disabled={reset.isPending}>
          {t('common.reset')}
        </Button>
      </SettingsRow>
    </SettingsSection>
  );
}
