import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getStorageIdentity, isCurrentStorageIdentity, onStorageIdentity } from "./storageIdentity";
import { LatestQuery } from "./latestQuery";
import { useNotesWorkspace } from "../stores/notesWorkspace";
import type { RecordGroup } from "./suiji";
import type { StorageResult } from "../types/note";
import { recordGroupColor } from "./recordColors";
export function useRecordGroups() {
  const [groups, setGroups] = useState<RecordGroup[]>([]);
  const [ready, setReady] = useState(false);
  const [tick, refresh] = useState(0);
  useEffect(() => {
    let alive = true, generation = 0;
    const queue = new LatestQuery<StorageResult<RecordGroup[]>>();
    const load = async () => {
      const current = ++generation, epoch = await getStorageIdentity();
      try {
        const response = await queue.run(`${epoch}:${current}`, () => invoke("get_suiji_groups", { expectedStorageEpoch: epoch }));
        if (alive && current === generation && response && isCurrentStorageIdentity(response.storage_epoch)) { setGroups(response.value.map(group => ({ ...group, color: recordGroupColor(group.id, group.color) }))); setReady(true); }
      } catch (error) {
        if (alive && current === generation && isCurrentStorageIdentity(epoch)) useNotesWorkspace.getState().setError(error);
      }
    };
    void load().catch(useNotesWorkspace.getState().setError);
    const clear = onStorageIdentity(() => { generation++; setGroups([]); setReady(false); void load().catch(useNotesWorkspace.getState().setError); });
    const subscriptions = ["phrase-groups-changed", "notes-changed", "notes-pruned"].map(event => listen<{ storage_epoch: number }>(event, ({ payload }) => {
      if (isCurrentStorageIdentity(payload?.storage_epoch)) void load().catch(useNotesWorkspace.getState().setError);
    }));
    return () => { alive = false; generation++; clear(); subscriptions.forEach(promise => { void promise.then(stop => stop()).catch(() => {}); }); };
  }, [tick]);
  return { groups, ready, refresh: () => refresh(value => value + 1) };
}

