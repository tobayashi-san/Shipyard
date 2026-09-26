export interface CustomTaskDraft {
  name: string; type: string; github_repo: string; check_command: string;
  update_command: string; trigger_output: string; latest_command: string;
  snapshot_before_run: boolean;
}
export function customTaskDraft(task?: Partial<Omit<CustomTaskDraft, 'snapshot_before_run'>> & { snapshot_before_run?: boolean | number | null } | null): CustomTaskDraft {
  return { name: task?.name || '', type: task?.type || 'script', github_repo: task?.github_repo || '', check_command: task?.check_command || '', update_command: task?.update_command || '', trigger_output: task?.trigger_output || '', latest_command: task?.latest_command || '', snapshot_before_run: !!task?.snapshot_before_run };
}
export function customTaskDirty(draft: CustomTaskDraft, task?: Parameters<typeof customTaskDraft>[0]): boolean {
  return JSON.stringify(customTaskDraft(draft)) !== JSON.stringify(customTaskDraft(task));
}

/**
 * Check commands for an app installed by a Proxmox VE community script
 * (community-scripts/ProxmoxVE). The script records the installed version in
 * ~/.<slug> (older installs: /opt/<slug>_version.txt). The desired version is
 * the release the script pins after testing, or the latest GitHub release
 * when it pins none. `update` refuses to prompt without a terminal.
 */
export function communityScriptTask(slug: string, name?: string): Pick<CustomTaskDraft, 'name' | 'type' | 'check_command' | 'latest_command' | 'update_command' | 'github_repo' | 'trigger_output'> {
  const app = slug.trim().toLowerCase();
  const script = `https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/${app}.sh`;
  return {
    name: name?.trim() || app.charAt(0).toUpperCase() + app.slice(1),
    type: 'script',
    check_command: `for f in ~/.${app} /opt/${app}_version.txt; do [ -s "$f" ] && exec cat "$f"; done; exit 1`,
    latest_command: `s=$(curl -fsSL ${script}) || exit 1; v=$(printf '%s\\n' "$s" | sed -n 's/^ *RELEASE="\\(v\\?[^"$]*\\)".*/\\1/p' | head -1); if [ -z "$v" ]; then r=$(printf '%s\\n' "$s" | sed -n 's/.*check_for_gh_release "[^"]*" "\\([^"]*\\)".*/\\1/p' | head -1); [ -n "$r" ] && v=$(curl -fsSL "https://api.github.com/repos/$r/releases/latest" | sed -n 's/.*"tag_name": *"\\([^"]*\\)".*/\\1/p' | head -1); fi; [ -n "$v" ] && echo "$v"`,
    update_command: 'update </dev/null',
    github_repo: '',
    trigger_output: '',
  };
}
export const COMMUNITY_SCRIPT_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
