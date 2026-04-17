import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

interface StubProps {
  titleKey: string;
  descKey?: string;
}

/** Placeholder used by Settings tabs that have not been ported yet (commits 2–5). */
export function TabStub({ titleKey, descKey }: StubProps) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(titleKey)}</CardTitle>
        {descKey && <CardDescription>{t(descKey)}</CardDescription>}
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{t('stub.body')}</p>
      </CardContent>
    </Card>
  );
}
