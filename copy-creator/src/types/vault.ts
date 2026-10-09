export const VAULT_AUTO_LOCK_OPTIONS = ["never", "24hours", "3hours", "on_startup"] as const;
export type VaultAutoLock = typeof VAULT_AUTO_LOCK_OPTIONS[number];
export function normalizeVaultAutoLock(value: unknown): VaultAutoLock {
  return VAULT_AUTO_LOCK_OPTIONS.find((option) => option === value) ?? "3hours";
}
export interface VaultStatus { configured: boolean; unlocked: boolean; auto_lock: VaultAutoLock }
export interface VaultField { id: string; label: string; value: string; sensitive: boolean }
export interface VerificationMethod { id: string; kind: string; label: string; value: string; note: string }
export interface VaultEntry {
  id: string;
  title: string;
  website: string;
  username: string;
  email: string;
  phone: string;
  password: string;
  tags: string[];
  fields: VaultField[];
  verification: VerificationMethod[];
  notes: string;
  created_at: string;
  updated_at: string;
}
export interface VaultSummary {
  id: string; title: string; website: string; username: string; email: string;
  tags: string[]; has_password: boolean; verification_count: number; updated_at: string;
}
export interface PasswordOptions {
  length: number; uppercase: boolean; lowercase: boolean; digits: boolean; symbols: boolean; exclude_ambiguous: boolean;
}
export const DEFAULT_PASSWORD_OPTIONS: PasswordOptions = {
  length: 24, uppercase: true, lowercase: true, digits: true, symbols: true, exclude_ambiguous: true,
};
export function emptyVaultEntry(): VaultEntry {
  return { id: "", title: "", website: "", username: "", email: "", phone: "", password: "", tags: [], fields: [], verification: [], notes: "", created_at: "", updated_at: "" };
}

export const PERSONAL_TEMPLATES = {
  personal: ["fullName", "nickname", "birthday", "country", "address"],
  work: ["fullName", "company", "jobTitle", "workEmail", "employeeId"],
} as const;
export const VERIFICATION_KINDS = ["email", "sms", "recovery_codes", "security_question", "authenticator", "passkey", "custom"] as const;
