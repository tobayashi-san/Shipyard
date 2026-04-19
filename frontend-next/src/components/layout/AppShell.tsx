import { type ReactNode, useEffect } from 'react';
import { Sidebar } from './Sidebar';
import { CommandPalette } from '@/components/CommandPalette';
import { useSettings } from '@/lib/queries';
import { applyWhiteLabel, type WhiteLabelSettings } from '@/lib/whitelabel';

export function AppShell({ children }: { children: ReactNode }) {
  const { data: settings } = useSettings();

  useEffect(() => {
    if (settings) applyWhiteLabel(settings as unknown as WhiteLabelSettings);
  }, [settings]);

  return (
    <div className="flex min-h-screen surface-2 text-foreground">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-auto px-5 py-6 lg:px-8 lg:py-7">{children}</main>
      <CommandPalette />
    </div>
  );
}
