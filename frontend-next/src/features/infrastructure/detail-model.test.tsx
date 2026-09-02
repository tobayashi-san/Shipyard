import { describe, expect, it } from "vitest";
import { taskLabel, tasksForObject, type Cluster } from "./detail-model";

const cluster: Cluster = {
  id: "cluster-a",
  endpoint: "https://pve.example.test:8006",
  status: "online",
  connections: [{ id: "connection-a", name: "Primary Proxmox" }],
  nodes: [],
  vms: [],
};

describe("tasksForObject", () => {
  it("groups repeated successful platform synchronization tasks", () => {
    const tasks = tasksForObject([
      { action: "ipam.proxmox_sync", detail: "source=Primary Proxmox", success: 1, created_at: "2026-09-02T12:00:00Z" },
      { action: "ipam.proxmox_sync", detail: "source=Primary Proxmox", success: 1, created_at: "2026-09-02T11:00:00Z" },
    ], cluster);

    expect(tasks).toHaveLength(1);
    expect(taskLabel(tasks[0])).toBe("IPAM sync ×2");
  });

  it("limits node tasks to the requested node", () => {
    const tasks = tasksForObject([
      { action: "node.refresh", detail: "node=pve001", success: 1, created_at: "2026-09-02T12:00:00Z" },
      { action: "node.refresh", detail: "node=pve002", success: 1, created_at: "2026-09-02T11:00:00Z" },
    ], cluster, "pve001");

    expect(tasks).toHaveLength(1);
    expect(tasks[0].detail).toContain("pve001");
  });
});
