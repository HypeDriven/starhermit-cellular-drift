// Localization: the browser build's string tables (js/strings.js, the nine
// StarHermit locales; English text is the key) in the interface language the
// runtime reports (preferences().language: the player's choice in Options ›
// Language, else the account's preferred language or the device's). The
// runtime's Options replaced the game's own Language menu (sh-language.js),
// and this module replaced js/i18n.js, which translated the DOM in place:
// the interface is drawn every frame, so a language change shows at once.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { STRINGS } from "./classic.ts";

export const LOCALES = ["en-US", "en-GB", "es-419", "es-ES", "de-DE", "fr-FR", "fr-CA", "pt-BR", "it-IT"];
const PARENT: Record<string, string> = { "en-GB": "en-US", "es-ES": "es-419", "fr-CA": "fr-FR" };
const PRIMARY: Record<string, string> = { en: "en-US", es: "es-419", de: "de-DE", fr: "fr-FR", pt: "pt-BR", it: "it-IT" };

/** The shipped locale nearest a BCP 47 tag (en-GB, es-ES and fr-CA by region; es-MX → es-419, pt-PT → pt-BR). */
export function pickLocale(tag: string): string {
  const t = String(tag || "en-US");
  const exact = LOCALES.find((l) => l.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const lang = t.split("-")[0]!.toLowerCase();
  if (lang === "en" && /-(gb|uk|ie|au|nz|za|in)$/i.test(t)) return "en-GB";
  if (lang === "es" && /-es$/i.test(t)) return "es-ES";
  if (lang === "fr" && /-ca$/i.test(t)) return "fr-CA";
  return PRIMARY[lang] ?? "en-US";
}

let locale = "en-US";
function apply(tag: string): void {
  locale = pickLocale(tag);
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => { if (pickLocale(p.language) !== locale) apply(p.language); });

export function currentLocale(): string { return locale; }

type Vars = Record<string, string | number>;
/** Marks an English key that is translated with T() when shown. */
export const N = (s: string): string => s;
/** A game string by its English key in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string {
  let s = key;
  for (let l: string | undefined = locale; l; l = PARENT[l]) {
    const table = STRINGS[l];
    if (table && Object.prototype.hasOwnProperty.call(table, key)) { s = table[key]!; break; }
  }
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
  return s;
}
