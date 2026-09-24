export type ProviderTone = "green" | "blue" | "violet" | "orange" | "teal" | "rose" | "slate";

const KNOWN_TONES: Record<string, ProviderTone> = {
  openai: "green",
  deepseek: "blue",
  kimi: "violet",
  moonshot: "violet",
  claude: "orange",
  anthropic: "orange",
  gemini: "teal",
  google: "teal",
  grok: "slate",
  xai: "slate",
  "通义千问": "orange",
  "智谱 glm": "blue",
  github: "violet",
  gitlab: "orange",
};

const CUSTOM_TONES: ProviderTone[] = ["green", "blue", "violet", "orange", "teal", "rose"];

export function providerTone(name: string | null | undefined): ProviderTone {
  if (!name) return "slate";
  const normalized = name.trim().toLowerCase();
  if (KNOWN_TONES[normalized]) return KNOWN_TONES[normalized];
  let hash = 0;
  for (const char of normalized) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return CUSTOM_TONES[hash % CUSTOM_TONES.length];
}
