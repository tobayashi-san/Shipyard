import { useTranslation } from 'react-i18next';
import { Construction } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

export function StubPage({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t(titleKey)}</h1>
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
          <Construction className="h-8 w-8" />
          <p className="text-sm font-medium text-foreground">{t('stub.title')}</p>
          <p className="text-sm">{t('stub.body')}</p>
        </CardContent>
      </Card>
    </div>
  );
}
