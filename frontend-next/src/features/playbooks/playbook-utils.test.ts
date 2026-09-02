import { describe, expect, it } from "vitest";
import { describePlaybookTargets } from "./playbook-utils";

describe("describePlaybookTargets", () => {
  it("translates Ansible all-except syntax for operators", () => {
    expect(describePlaybookTargets("all:!pve001").label).toBe("All hosts except pve001");
  });

  it("condenses long explicit host lists", () => {
    const targets = Array.from({ length: 15 }, (_, index) => `host-${index + 1}`).join(",");
    expect(describePlaybookTargets(targets)).toMatchObject({ label: "15 hosts", raw: targets });
  });
});
