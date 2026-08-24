import { describe, expect, it } from 'vitest';
import { canAccessDeployments, canAccessOperations, type Profile } from './queries';

const operator: Profile = { role: 'user', permissions: { canManageDeployments: true } };
const deploymentViewer: Profile = { role: 'user', permissions: { canViewDeployments: true } };
const maintenanceOperator: Profile = { role: 'user', permissions: { canViewMaintenance: true } };
describe('navigation access rules', () => {
  it('requires the integrated deployment capability', () => {
    expect(canAccessDeployments(operator)).toBe(true);
    expect(canAccessDeployments(deploymentViewer)).toBe(true);
    expect(canAccessDeployments({ ...operator, permissions: {} })).toBe(false);
    expect(canAccessDeployments({ role: 'user', permissions: { canManageDeploymentPlatforms: true } })).toBe(true);
  });

  it('keeps operations available to maintenance-only roles without exposing deployments', () => {
    expect(canAccessDeployments(maintenanceOperator)).toBe(false);
    expect(canAccessOperations(maintenanceOperator)).toBe(true);
  });
});
