// Holds only a navigation callback; protected draft contents remain in the editor.
let guard: ((proceed: () => void) => void) | undefined;
let dirty: (() => boolean) | undefined;
export function ownVaultNavigation(callback: (proceed: () => void) => void, isDirty?: () => boolean) {
  guard = callback;
  dirty = isDirty;
  return () => { if (guard === callback) { guard = undefined; dirty = undefined; } };
}
export function hasUnsavedVaultDraft() { return dirty?.() ?? false; }
export function requestVaultNavigation(proceed: () => void) {
  if (guard) guard(proceed); else proceed();
}
