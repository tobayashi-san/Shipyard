import type { ToastKind } from '@/lib/toast';
export function imageCheckSummary(results: ReadonlyArray<{ status: string }>): { message: string; description: string; kind: ToastKind } {
  const available = results.filter(row => row.status === 'update_available').length;
  const ignored = results.filter(row => row.status === 'ignored').length;
  const verified = results.filter(row => ['update_available', 'up_to_date', 'updated'].includes(row.status)).length;
  const unresolved = results.length - verified - ignored;
  if (!results.length) return { message: 'No image results returned', description: 'No image freshness could be verified. Check the container inventory and try again.', kind: 'warning' };
  return {
    message: unresolved ? 'Image check completed with unresolved results' : 'Image check completed',
    description: `${verified} of ${results.length - ignored} results verified · ${available} updates available · ${unresolved} unresolved${ignored ? ` · ${ignored} excluded` : ''}.${unresolved ? ' See container rows for reasons and next steps.' : ''}`,
    kind: unresolved || available ? 'warning' : 'success',
  };
}
