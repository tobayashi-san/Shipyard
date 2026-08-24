import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import CodeMirror from '@uiw/react-codemirror';
import { yaml, yamlLanguage } from '@codemirror/lang-yaml';
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';

const ansibleModules = [
  'ansible.builtin.apt', 'ansible.builtin.dnf', 'ansible.builtin.package',
  'ansible.builtin.service', 'ansible.builtin.systemd_service',
  'ansible.builtin.copy', 'ansible.builtin.template', 'ansible.builtin.file',
  'ansible.builtin.user', 'ansible.builtin.command', 'ansible.builtin.shell',
  'ansible.builtin.get_url', 'ansible.builtin.git', 'ansible.builtin.uri',
  'ansible.builtin.debug', 'ansible.builtin.set_fact', 'ansible.builtin.include_tasks',
];

function ansibleModuleCompletion(context: CompletionContext) {
  const word = context.matchBefore(/[\w.]+/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  return {
    from: word.from,
    options: ansibleModules.map((label) => ({
      label,
      type: 'function',
      detail: 'Ansible module',
      apply: `${label}:`,
    })),
  };
}

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
          extensions={[yaml(), autocompletion({ override: [ansibleModuleCompletion] })]}
          theme={dark ? 'dark' : 'light'}
          height="clamp(320px, calc(100vh - 28rem), 520px)"
          basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, autocompletion: false }}
        />
      </div>
      {error ? <p className="text-xs font-medium text-destructive">{error}</p> : <p className="text-xs text-muted-foreground">{t('pb.yamlValid')}</p>}
    </>
  );
}

export default PlaybookEditor;
