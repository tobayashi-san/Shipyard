export interface Playbook {
  filename: string;
  description?: string;
  category?: string;
  isInternal?: boolean;
}

export interface AnsibleVar {
  id: string;
  key: string;
  value: string;
  description?: string;
  is_secret?: boolean;
  value_set?: boolean;
  environment_id?: string;
}

export interface Schedule {
  id: string;
  name: string;
  playbook: string;
  targets?: string;
  cron_expression: string;
  enabled: boolean;
  last_run?: string;
  last_status?: string;
  environment_id?: string;
  extra_vars?: Record<string, string | number | boolean>;
  check_mode?: boolean | number;
  forks?: number;
  next_run?: string | null;
  timezone?: string;
}

export interface HistoryEntry {
  id: string;
  schedule_id?: string | null;
  schedule_name?: string;
  playbook: string;
  targets?: string;
  started_at: string;
  status: string;
  output?: string;
  check_mode?: boolean | number;
  triggered_by?: string;
}

export interface PlaybookVersion {
  version: number;
  modifiedAt?: string;
  content?: string;
}


