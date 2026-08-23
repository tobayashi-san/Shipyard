import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * PageHeader — top of every route page.
 * Big title + optional description + actions on the right.
 */
export interface PageHeaderProps {
  title: React.ReactNode;
  /** Short inventory class for object pages, e.g. Platform, Node or VM. */
  eyebrow?: React.ReactNode;
  description?: React.ReactNode;
  /** A compact object path for hierarchical console pages (platform → node → VM). */
  breadcrumbs?: React.ReactNode;
  actions?: React.ReactNode;
  badge?: React.ReactNode;
  back?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, eyebrow, description, breadcrumbs, actions, badge, back, className }: PageHeaderProps) {
  return (
    <div className={cn('flex min-h-[3.75rem] flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-border-strong/70 pb-3', className)}>
      <div className="flex min-w-0 max-w-full items-start gap-3">
        {back}
        <div className="min-w-0">
          {breadcrumbs && <nav aria-label="Object path" className="mb-1.5 flex max-w-full items-center gap-1 overflow-x-auto whitespace-nowrap text-xs text-muted-foreground">{breadcrumbs}</nav>}
          {eyebrow && <div className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground">{eyebrow}</div>}
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="break-words text-xl font-semibold tracking-[-0.018em] text-foreground sm:text-2xl">{title}</h1>
            {badge}
          </div>
          {description && (
            <p className="mt-1 max-w-3xl text-[13px] leading-5 text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex w-full flex-wrap items-center justify-start gap-2 sm:w-auto sm:justify-end">{actions}</div>}
    </div>
  );
}

/**
 * SectionLabel — uppercase tracking label, used above grouped controls.
 */
export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('section-label', className)}>{children}</div>;
}
