// -----------------------------------------------------------------------------
// The languages every user-facing text is written in.
//
// Gladys picks `text[userLanguage]` and falls back to `en`, so a message is an
// object holding one entry per language below. The helpers here build such an
// object from per-language pieces (a prefix, a join), so adding a language is
// one entry in `LANGUAGES` plus its strings — never a new branch at every call
// site.
// -----------------------------------------------------------------------------

/** The languages of every user-facing text, English first (the fallback). */
export const LANGUAGES = ['en', 'fr', 'de', 'es'];

/**
 * Build a multi-language object, one entry per language.
 * @param {(lang: string) => string} build - The text of one language.
 * @returns {Record<string, string>} `{ en, fr, de, es }`.
 */
export function perLanguage(build) {
  return Object.fromEntries(LANGUAGES.map((lang) => [lang, build(lang)]));
}

/**
 * The text of one language, English when that language is missing.
 * @param {Record<string, string>} text - A multi-language object.
 * @param {string} lang - The language.
 * @returns {string} The text.
 */
export function inLanguage(text, lang) {
  return text[lang] ?? text.en;
}

/**
 * The separator before a colon: French typography puts a space before it.
 * @param {string} lang - The language.
 * @returns {string} `' : '` in French, `': '` otherwise.
 */
export function colon(lang) {
  return lang === 'fr' ? ' : ' : ': ';
}
