export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue | undefined }

export interface OpenTofuWorkspace {
  id: string;
  name: string;
  path: string;
  environment_id: string;
  provider?: string | null;
  env_vars: Record<string, string>;
  proxmox_connection_id?: string | null;
}

export interface ProxmoxConnection {
  base: URL;
  apiToken: string;
  insecure: boolean;
}

export interface PlanSummary {
  create: number;
  update: number;
  delete: number;
  replace: number;
  no_op: number;
  read: number;
}

export interface ManagedServerCandidate {
  key: string;
  name: string;
  ip_address: string;
  ssh_user?: string;
  ssh_port?: number;
  provider?: string;
  resource_address?: string;
}
