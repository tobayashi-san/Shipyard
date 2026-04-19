import { create } from 'zustand';

export type ToastKind = 'success' | 'error' | 'warning' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
  description?: string;
  action?: ToastAction;
  duration?: number;
  createdAt: number;
}

interface ToastState {
  toasts: ToastItem[];
  push: (message: string, kindOrOpts?: ToastKind | ToastOptions, kindLegacy?: ToastKind) => number;
  dismiss: (id: number) => void;
  dismissAll: () => void;
}

export interface ToastOptions {
  kind?: ToastKind;
  description?: string;
  action?: ToastAction;
  duration?: number;
}

let counter = 0;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (message, kindOrOpts, kindLegacy) => {
    let opts: ToastOptions;
    if (typeof kindOrOpts === 'string') opts = { kind: kindOrOpts };
    else opts = kindOrOpts || {};
    if (kindLegacy) opts.kind = kindLegacy;

    const id = ++counter;
    const item: ToastItem = {
      id,
      message,
      kind: opts.kind || 'info',
      description: opts.description,
      action: opts.action,
      duration: opts.duration,
      createdAt: Date.now(),
    };
    set({ toasts: [...get().toasts, item] });
    const ttl = opts.duration ?? (opts.kind === 'error' ? 6500 : 4000);
    if (ttl > 0) setTimeout(() => get().dismiss(id), ttl);
    return id;
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  dismissAll: () => set({ toasts: [] }),
}));

/**
 * Imperative helper. Supports old (msg, kind) signature and new (msg, opts) signature.
 */
export function showToast(message: string, kindOrOpts?: ToastKind | ToastOptions): number {
  return useToastStore.getState().push(message, kindOrOpts);
}
