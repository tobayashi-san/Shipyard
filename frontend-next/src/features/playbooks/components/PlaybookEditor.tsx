import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import CodeMirror from '@uiw/react-codemirror';
import { yaml, yamlLanguage } from '@codemirror/lang-yaml';

export function PlaybookEditor({
  value,
  onChange,
  onValidityChange,
  dark,
}: {
  value: string;
  onChange: (value: string) => void;
  onValidityChange: (error: string | null) => void;
  dark: boolean;
}) {
  const { t } = useTranslation();
  const error = useMemo(() => {
    const tree = yamlLanguage.parser.parse(value);
    let invalid = false;
    tree.iterate({ enter: (node) => { if (node.type.isError) invalid = true; } });
    return invalid ? t('pb.yamlInvalid') : null;
  }, [value]);

  useEffect(() => { onValidityChange(error); }, [error, onValidityChange]);

  return (
    <>
      <div className="overflow-hidden rounded-md border">
        <CodeMirror
          value={value}
          onChange={onChange}
          extensions={[yaml()]}
          theme={dark ? 'dark' : 'light'}
          height="clamp(320px, calc(100vh - 28rem), 520px)"
          basicSetup={{ lineNumbers: true, highlightActiveLine: true }}
        />
      </div>
      {error ? <p className="text-xs font-medium text-destructive">{error}</p> : <p className="text-xs text-muted-foreground">{t('pb.yamlValid')}</p>}
    </>
  );
}

export default PlaybookEditor;
