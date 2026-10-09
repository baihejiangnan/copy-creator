import { getStorageIdentity, invokeStorage, isCurrentStorageIdentity, type StorageEvent } from "../lib/storageIdentity";
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useVaultStore } from "../stores/vaultStore";

export default function VaultSession() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let lastActivity = 0;
    listen<StorageEvent<null>>("vault-locked", ({ payload }) => {
      if (isCurrentStorageIdentity(payload?.storage_epoch)) useVaultStore.getState().clearLocked();
    }).then((dispose) => {
      if (disposed) dispose(); else unlisten = dispose;
    });
    const touch = (event: Event) => {
      if (!useVaultStore.getState().status?.unlocked || !(event.target instanceof Element) || !event.target.closest(".vault-page")) return;
      const now = Date.now();
      if (now - lastActivity < 10000) return;
      lastActivity = now;
      void getStorageIdentity().then(async (origin) => {
        try { await invokeStorage("touch_vault", {}, origin); }
        catch (error) {
          if (!disposed && isCurrentStorageIdentity(origin) && String(error) === "vault.locked") useVaultStore.getState().clearLocked();
        }
      }).catch(() => {});
    };
    const copy = (event: ClipboardEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".vault-page")) return;
      event.preventDefault();
      if (!useVaultStore.getState().status?.unlocked) return;
      const target = event.target;
      const input = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null;
      const original = input?.value;
      const start = input?.selectionStart ?? 0;
      const end = input?.selectionEnd ?? 0;
      const text = input
        ? input.value.slice(start, end)
        : window.getSelection()?.toString() || "";
      const cutting = event.type === "cut";
      if (text) void getStorageIdentity().then(async (origin) => {
        try {
          await invokeStorage("copy_vault_text", { text }, origin);
          if (disposed || !isCurrentStorageIdentity(origin)) return;
          if (!cutting || !input || input.readOnly || input.disabled || !input.isConnected
            || input.value !== original || !useVaultStore.getState().status?.unlocked) return;
          const prototype = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, input.value.slice(0, start) + input.value.slice(end));
          input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteByCut" }));
          input.setSelectionRange(start, start);
        } catch (error) {
          if (disposed || !isCurrentStorageIdentity(origin)) return;
          if (String(error) === "vault.locked") useVaultStore.getState().clearLocked();
          else useVaultStore.getState().setError(String(error));
        }
      }).catch(() => {});
    };
    document.addEventListener("pointerdown", touch);
    document.addEventListener("pointermove", touch);
    document.addEventListener("wheel", touch, { passive: true });
    document.addEventListener("keydown", touch);
    document.addEventListener("copy", copy);
    document.addEventListener("cut", copy);
    return () => {
      disposed = true; unlisten?.();
      document.removeEventListener("pointerdown", touch);
      document.removeEventListener("pointermove", touch);
      document.removeEventListener("wheel", touch);
      document.removeEventListener("keydown", touch);
      document.removeEventListener("copy", copy);
      document.removeEventListener("cut", copy);
    };
  }, []);
  return null;
}
