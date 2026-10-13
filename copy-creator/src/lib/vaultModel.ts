import { emptyVaultEntry, type VaultEntry, type VaultField, type VaultFieldType } from "../types/vault.ts";

type FieldPreset = readonly [string, VaultFieldType, boolean?];
export const VAULT_PRESETS: Record<string, readonly FieldPreset[]> = {
  custom: [], login: [["website", "url"], ["username", "text"], ["password", "secret", true]],
  server: [["ip", "text"], ["authPassword", "secret", true]],
  database: [["ip", "text"], ["databaseName", "text"], ["username", "text"], ["password", "secret", true]],
  api: [["serviceUrl", "url"], ["apiKey", "secret", true]], recovery: [["recoveryCodes", "multiline", true]],
  personal: [["fullName", "text"], ["nickname", "text"], ["birthday", "text"], ["country", "text"], ["address", "multiline"]],
  work: [["fullName", "text"], ["company", "text"], ["jobTitle", "text"], ["workEmail", "text"], ["employeeId", "text"]],
  identityPersonal: [["email", "text"], ["phone", "text"], ["mailboxPassword", "secret", true]],
  identityWork: [["workEmail", "text"], ["phone", "text"], ["mailboxPassword", "secret", true], ["company", "text"]],
  identityCustom: [],
};
export const VAULT_ADDITIONAL_FIELDS: readonly FieldPreset[] = [
  ["custom", "text"], ["password", "secret", true], ["website", "url"], ["notes", "multiline"],
  ["username", "text"], ["email", "text"], ["phone", "text"], ["port", "text"],
  ["recoveryCodes", "multiline", true], ["securityAnswer", "multiline", true],
  ["authenticator", "multiline"], ["passkey", "multiline"], ["verification", "multiline", true],
];
export function createVaultField(preset: FieldPreset, translate: (key: string) => string): VaultField {
  return { id: crypto.randomUUID(), label: translate(`vault2.fields.${preset[0]}`), value: "", type: preset[1], sensitive: preset[2] ?? false };
}
export function createVaultEntry(preset: string, translate: (key: string) => string, identityIds: string[] = []): VaultEntry {
  const entry = emptyVaultEntry();
  entry.id = crypto.randomUUID();
  entry.kind = preset.startsWith("identity") ? "identity" : "entry";
  entry.template = preset;
  entry.identity_ids = entry.kind === "entry" ? [...new Set(identityIds)] : [];
  entry.fields = (VAULT_PRESETS[preset] ?? []).map(field => createVaultField(field, translate));
  entry.login_method = preset === "login" ? "password" : "";
  if (entry.kind === "identity") entry.summary_field_id = entry.fields[0]?.id ?? "";
  return entry;
}
export function moveVaultField(fields: VaultField[], id: string, delta: number): VaultField[] {
  const from = fields.findIndex(field => field.id === id); const to = from + delta;
  if (from < 0 || to < 0 || to >= fields.length) return fields;
  const moved = [...fields]; [moved[from], moved[to]] = [moved[to], moved[from]]; return moved;
}
export function vaultSummary(entry: VaultEntry): string {
  return (entry.fields.find(field => field.id === entry.summary_field_id && !field.sensitive && field.value)
    ?? entry.fields.find(field => !field.sensitive && field.value))?.value ?? "";
}
export function vaultFieldLabel(field: VaultField, translate: (key: string) => string): string {
  return field.purpose?.startsWith("legacy_base:") ? translate(`vault2.fields.${field.purpose.slice("legacy_base:".length)}`) : field.label;
}
