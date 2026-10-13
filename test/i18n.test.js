import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, colon, inLanguage, perLanguage } from '../src/i18n.js';
import { ActionFailure, describeError } from '../src/actions.js';
import { ProxmoxError } from '../src/proxmox/client.js';

test('every user-facing text is written in English, French, German and Spanish', () => {
  assert.deepEqual(LANGUAGES, ['en', 'fr', 'de', 'es']);
  assert.deepEqual(
    perLanguage((lang) => `${lang}!`),
    { en: 'en!', fr: 'fr!', de: 'de!', es: 'es!' },
  );
});

test('a missing language falls back to English', () => {
  assert.equal(inLanguage({ en: 'Hello', fr: 'Bonjour' }, 'de'), 'Hello');
  assert.equal(inLanguage({ en: 'Hello', de: 'Hallo' }, 'de'), 'Hallo');
});

test('only French puts a space before the colon', () => {
  assert.equal(colon('fr'), ' : ');
  for (const lang of ['en', 'de', 'es']) {
    assert.equal(colon(lang), ': ');
  }
});

test('every error message is written in every language', () => {
  for (const kind of ['auth', 'permission', 'tls', 'timeout', 'network', 'http']) {
    const message = describeError(new ProxmoxError(kind, 'boom'));
    assert.deepEqual(Object.keys(message), LANGUAGES, kind);
    for (const lang of LANGUAGES) {
      assert.ok(message[lang].length > 0, `${kind}.${lang}`);
    }
  }
});

test('a failed action carries English then French only, one paragraph each', () => {
  const failure = new ActionFailure({ en: 'Broken.', fr: 'Cassé.', de: 'Kaputt.', es: 'Roto.' });
  assert.equal(failure.message, 'Broken.\n\nCassé.');
  // The other languages stay on the object, for whoever reads it as a message.
  assert.equal(failure.localized.de, 'Kaputt.');
});
