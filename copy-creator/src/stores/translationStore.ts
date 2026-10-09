import { create } from "zustand";
import { invokeStorage, onStorageIdentity } from "../lib/storageIdentity";
let generation = 0;

interface TranslationResult {
  source_text: string;
  target_text: string;
  engine: string;
}

interface TranslationState {
  inputText: string;
  targetLang: string;
  result: string | null;
  engine: string | null;
  loading: boolean;
  error: string | null;

  setInputText: (text: string) => void;
  setTargetLang: (lang: string) => void;
  translate: () => Promise<void>;
}

export const useTranslationStore = create<TranslationState>((set, get) => ({
  inputText: "",
  targetLang: "zh",
  result: null,
  engine: null,
  loading: false,
  error: null,

  setInputText: (text: string) => set({ inputText: text }),
  setTargetLang: (lang: string) => set({ targetLang: lang }),

  translate: async () => {
    const current = ++generation;
    const { inputText, targetLang } = get();
    if (!inputText.trim()) return;

    set({ loading: true, error: null });
    try {
      const res = await invokeStorage<TranslationResult>("translate", {
        text: inputText,
        targetLang,
      });
      if (current !== generation) return;
      set({ result: res.target_text, engine: res.engine });
    } catch (e) {
      if (current === generation) set({ error: String(e) });
    } finally {
      if (current === generation) set({ loading: false });
    }
  },
}));
onStorageIdentity(() => { generation++; useTranslationStore.setState({ result: null, engine: null, error: null, loading: false }); });
