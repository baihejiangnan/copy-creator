import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getStorageIdentity, invokeStorage, isCurrentStorageIdentity, onStorageIdentity } from "../lib/storageIdentity";
import type { VaultAutoLock, VaultEntry, VaultStatus, VaultSummary } from "../types/vault";
import { normalizeVaultAutoLock, VAULT_AUTO_LOCK_OPTIONS } from "../types/vault";

let epoch = 0;
let listRequest = 0;
let detailRequest = 0;

interface VaultState {
  status: VaultStatus | null;
  entries: VaultSummary[];
  selected: VaultEntry | null;
  search: string;
  busy: boolean;
  settingBusy: boolean;
  error: string | null;
  notice: string | null;
  initialize: () => Promise<void>;
  authenticate: (password: string, setup: boolean) => Promise<void>;
  clearLocked: () => void;
  lock: () => Promise<void>;
  setAutoLock: (value: VaultAutoLock) => Promise<void>;
  setSearch: (search: string) => void;
  refresh: () => Promise<void>;
  openEntry: (id: string) => Promise<boolean>;
  clearSelected: () => void;
  saveEntry: (entry: VaultEntry) => Promise<boolean>;
  deleteEntry: (id: string) => Promise<boolean>;
  copyField: (id: string, field: string) => Promise<void>;
  pasteField: (id: string, field: string) => Promise<void>;
  setError: (error: string | null) => void;
}

export const useVaultStore = create<VaultState>((set, get) => {
  const handleError = (error: unknown, requestEpoch: number) => {
    if (requestEpoch !== epoch) return;
    const message = String(error);
    if (message === "vault.locked") get().clearLocked();
    else set({ error: message, busy: false });
  };
  return {
    status: null, entries: [], selected: null, search: "", busy: false, settingBusy: false, error: null, notice: null,
    initialize: async () => {
      const current = epoch;
      try {
        const status = await invokeStorage<VaultStatus>("get_vault_status");
        // Older running backends may omit the new status field during a UI update.
        if (!VAULT_AUTO_LOCK_OPTIONS.includes(status.auto_lock)) {
          const settings = await invoke<Record<string, string>>("get_all_settings").catch(() => ({} as Record<string, string>));
          status.auto_lock = normalizeVaultAutoLock(settings.vault_auto_lock ?? get().status?.auto_lock);
        }
        if (current !== epoch) return;
        set({ status, error: null });
        if (status.unlocked) await get().refresh();
      } catch (error) { handleError(error, current); }
    },
    authenticate: async (masterPassword, setup) => {
      const current = epoch;
      set({ busy: true, error: null });
      try {
        await invokeStorage(setup ? "setup_vault" : "unlock_vault", { masterPassword });
        if (current === epoch) await get().initialize();
      } catch (error) { handleError(error, current); }
      finally { if (current === epoch) set({ busy: false }); }
    },
    clearLocked: () => {
      epoch++; listRequest++; detailRequest++;
      set({ status: { configured: get().status?.configured ?? true, unlocked: false, auto_lock: get().status?.auto_lock ?? "3hours" }, entries: [], selected: null, search: "", error: null, notice: null, busy: false });
    },
    lock: async () => {
      get().clearLocked();
      const current = epoch;
      await invokeStorage("lock_vault").catch((error) => handleError(error, current));
    },
    setAutoLock: async (value) => {
      if (get().settingBusy) return;
      set({ settingBusy: true, error: null });
      let origin: number | undefined;
      try {
        origin = await getStorageIdentity();
        await invokeStorage("set_setting", { key: "vault_auto_lock", value }, origin);
        if (!isCurrentStorageIdentity(origin)) return;
        const status = get().status;
        if (status) set({ status: { ...status, auto_lock: value } });
      } catch {
        if (origin !== undefined && isCurrentStorageIdentity(origin)) set({ error: "vault.autoLockSaveFailed" });
      } finally { if (origin === undefined || isCurrentStorageIdentity(origin)) set({ settingBusy: false }); }
    },
    setSearch: (search) => set({ search }),
    setError: (error) => set({ error }),
    refresh: async () => {
      const current = epoch; const request = ++listRequest;
      try {
        const entries = await invokeStorage<VaultSummary[]>("list_vault_entries", { search: get().search });
        if (current === epoch && request === listRequest && get().status?.unlocked) set({ entries });
      } catch (error) { handleError(error, current); }
    },
    openEntry: async (id) => {
      const current = epoch; const request = ++detailRequest;
      set({ selected: null, busy: true, error: null });
      try {
        const selected = await invokeStorage<VaultEntry>("get_vault_entry", { id });
        if (current !== epoch || request !== detailRequest || !get().status?.unlocked) return false;
        set({ selected }); return true;
      } catch (error) { handleError(error, current); return false; }
      finally { if (current === epoch && request === detailRequest) set({ busy: false }); }
    },
    clearSelected: () => { detailRequest++; set({ selected: null, busy: false, error: null, notice: null }); },
    saveEntry: async (entry) => {
      const current = epoch;
      set({ busy: true, error: null });
      try {
        const id = await invokeStorage<string>("save_vault_entry", { entry });
        if (current !== epoch) return false;
        await get().refresh();
        return await get().openEntry(id);
      } catch (error) { handleError(error, current); return false; }
      finally { if (current === epoch) set({ busy: false }); }
    },
    deleteEntry: async (id) => {
      const current = epoch; set({ busy: true, error: null });
      try {
        await invokeStorage("delete_vault_entry", { id });
        if (current !== epoch) return false;
        get().clearSelected(); await get().refresh(); return true;
      } catch (error) { handleError(error, current); return false; }
      finally { if (current === epoch) set({ busy: false }); }
    },
    copyField: async (id, field) => {
      const current = epoch;
      try {
        await invokeStorage("copy_vault_field", { id, field });
        if (current !== epoch) return;
        set({ notice: "vault.copied", error: null });
        setTimeout(() => { if (current === epoch) set({ notice: null }); }, 2500);
      } catch (error) { handleError(error, current); }
    },
    pasteField: async (id, field) => {
      if (get().busy || !get().status?.unlocked) return;
      const current = epoch;
      set({ busy: true, error: null, notice: null });
      let origin: number | undefined;
      try {
        origin = await getStorageIdentity();
        await invokeStorage("paste_vault_field", { id, field }, origin);
        if (current !== epoch) return;
        set({ notice: "vault.pasteSent" });
        setTimeout(() => { if (current === epoch) set({ notice: null }); }, 2500);
      } catch (error) {
        if (current === epoch) handleError(error, current);
        // The vault may have timed out during a failed focus handoff.
        // Surface the failure on the unlock screen after the backend reopens it.
        else if (origin !== undefined && isCurrentStorageIdentity(origin) && !get().status?.unlocked && String(error) !== "vault.locked") set({ error: String(error) });
      } finally { if (current === epoch) set({ busy: false }); }
    },
  };
});

onStorageIdentity(() => {
  if (!useVaultStore.getState().status) return;
  useVaultStore.getState().clearLocked(); useVaultStore.setState({ status: null, settingBusy: false });
  void useVaultStore.getState().initialize();
});
