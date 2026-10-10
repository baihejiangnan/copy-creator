import { LatestQuery } from "./latestQuery.ts";
import type { Note, NotePage, NoteSummary, StorageResult } from "../types/note.ts";
import type { RecordGroup } from "./suiji.ts";

export const RADIAL_ALL = "all";
export const RADIAL_UNGROUPED = "ungrouped";
const PAGE_SIZE = 50;
const MAX_ITEMS = 2000;
interface Transport {
  epoch(): Promise<number>;
  current(epoch: number): boolean;
  invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
  flush(id: string, epoch: number): Promise<void>;
  paste(command: "paste_text" | "paste_file", args: Record<string, unknown>, epoch: number): Promise<unknown>;
}
interface State {
  groups: readonly RecordGroup[]; records: readonly NoteSummary[];
  group: string; epoch: number | null; loading: boolean; error: string | null;
  cursor: NotePage["next_cursor"];
}
function failure(error: unknown): string {
  const code = typeof error === "string" ? error : error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof code === "string" && /^(notes|lifecycle|clipboard)\.[A-Za-z]+$/.test(code) ? code : "notes.loadFailed";
}
/** Read-only radial state: no editing coordinator, settings store or lifecycle session. */
export class RadialNotes {
  private state: State = { groups: [], records: [], group: RADIAL_ALL, epoch: null, loading: false, error: null, cursor: null };
  private listeners = new Set<() => void>();
  private groups = new LatestQuery<StorageResult<RecordGroup[]>>();
  private pages = new LatestQuery<StorageResult<NotePage>>();
  private generation = 0;
  private visible = false;
  private readonly transport: Transport;
  constructor(transport: Transport) { this.transport = transport; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<State>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  private valid(generation: number, epoch: number) { return this.visible && generation === this.generation && this.transport.current(epoch); }
  hide() { this.visible = false; this.generation++; this.publish({ groups: [], records: [], epoch: null, cursor: null, loading: false, error: null }); }
  show() { this.visible = true; return this.refresh(); }
  async refresh() {
    if (!this.visible) return;
    const generation = ++this.generation;
    this.publish({ records: [], cursor: null, loading: true, error: null });
    try {
      const epoch = await this.transport.epoch();
      if (!this.valid(generation, epoch)) return;
      const result = await this.groups.run(`${generation}:${epoch}`, () => this.transport.invoke<StorageResult<RecordGroup[]>>("get_suiji_groups", { expectedStorageEpoch: epoch }));
      if (!result || !this.valid(generation, epoch) || result.storage_epoch !== epoch) return;
      const group = [RADIAL_ALL, RADIAL_UNGROUPED].includes(this.state.group) || result.value.some(group => group.id === this.state.group) ? this.state.group : RADIAL_ALL;
      this.publish({ groups: result.value, group, epoch });
      await this.page(false, generation, epoch);
    } catch (error) { if (generation === this.generation) this.publish({ error: failure(error) }); }
    finally { if (generation === this.generation) this.publish({ loading: false }); }
  }
  async select(group: string) {
    const generation = ++this.generation;
    this.publish({ group, records: [], cursor: null, loading: true, error: null });
    try { const epoch = await this.transport.epoch(); await this.page(false, generation, epoch); }
    catch (error) { if (generation === this.generation) this.publish({ error: failure(error) }); }
    finally { if (generation === this.generation) this.publish({ loading: false }); }
  }
  async more() {
    if (!this.visible || this.state.loading || !this.state.cursor || this.state.records.length >= MAX_ITEMS || this.state.epoch === null) return;
    const generation = this.generation;
    this.publish({ loading: true, error: null });
    try { await this.page(true, generation, this.state.epoch); }
    catch (error) { if (generation === this.generation) this.publish({ error: failure(error) }); }
    finally { if (generation === this.generation) this.publish({ loading: false }); }
  }
  private async page(append: boolean, generation: number, epoch: number) {
    if (!this.valid(generation, epoch)) return;
    const group = this.state.group;
    const cursor = append ? this.state.cursor : null;
    const result = await this.pages.run(JSON.stringify([generation, epoch, group, cursor]), () => this.transport.invoke<StorageResult<NotePage>>("list_suiji", {
      expectedStorageEpoch: epoch, filter: group === RADIAL_UNGROUPED ? "ungrouped" : "active", search: "",
      groupId: [RADIAL_ALL, RADIAL_UNGROUPED].includes(group) ? null : group, sort: "updated", cursor, limit: PAGE_SIZE,
    }));
    if (!result || !this.valid(generation, epoch) || result.storage_epoch !== epoch) return;
    const records = [...new Map([...(append ? this.state.records : []), ...result.value.records].map(record => [record.id, record])).values()].slice(0, MAX_ITEMS);
    this.publish({ records, epoch, cursor: records.length < MAX_ITEMS ? result.value.next_cursor : null });
  }
  async paste(id: string, epoch: number) {
    if (!this.transport.current(epoch)) throw "notes.storageChanged";
    await this.transport.flush(id, epoch);
    if (!this.transport.current(epoch)) throw "notes.storageChanged";
    const result = await this.transport.invoke<StorageResult<Note>>("get_note", { expectedStorageEpoch: epoch, id });
    if (!this.transport.current(epoch) || result.storage_epoch !== epoch) throw "notes.storageChanged";
    const note = result.value;
    if (note.id !== id || note.deleted_at_ms !== null || note.archived_at_ms !== null) throw "notes.invalidState";
    if (!note.body && note.refs.length === 1 && note.refs[0].kind === "file") {
      await this.transport.paste("paste_file", { path: note.refs[0].target }, epoch);
    } else {
      const text = note.body || note.refs.map(ref => ref.target).join("\n");
      if (text) await this.transport.paste("paste_text", { text }, epoch);
    }
  }
}
