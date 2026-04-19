import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * PageHeader — top of every route page.
 * Big title + optional description + actions on the right.
 */
export interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  badge?: React.ReactNode;
  back?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, badge, back, className }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="flex min-w-0 items-start gap-3">
        {back}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
            {badge}
          </div>
          {description && (
            <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * SectionLabel — uppercase tracking label, used above grouped controls.
 */
export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('section-label', className)}>{children}</div>;
}
