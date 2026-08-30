import { useBlocker } from "@tanstack/react-router";

/** Keeps both SPA navigation and browser unload from silently discarding a draft. */
export function useUnsavedChanges(dirty: boolean) {
  useBlocker({
    disabled: !dirty,
    enableBeforeUnload: dirty,
    shouldBlockFn: () =>
      dirty && !window.confirm("You have unsaved changes. Leave this page and discard them?"),
  });
}
