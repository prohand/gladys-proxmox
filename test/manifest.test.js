// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers, nor which defaults it applies —
// these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../src/config.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('every manifest action has a registered handler', () => {
  for (const action of manifest.actions ?? []) {
    assert.match(
      source,
      new RegExp(`onAction\\('${action.key}'`),
      `manifest action "${action.key}" has no handler in index.js`,
    );
  }
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('every value-carrying config field is known to DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.type === 'section') {
      continue;
    }
    assert.ok(
      field.key in DEFAULT_CONFIG,
      `config field "${field.key}" has no entry in DEFAULT_CONFIG`,
    );
  }
});

test('the section block is purely presentational', () => {
  const sections = manifest.config_schema.filter((field) => field.type === 'section');
  assert.equal(sections.length, 1);
  for (const section of sections) {
    assert.equal(section.required, undefined);
    assert.equal(section.default, undefined);
    assert.equal(section.placeholder, undefined);
    assert.ok(section.label?.en);
    assert.ok(!(section.key in DEFAULT_CONFIG));
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('the token secret is declared as a secret field', () => {
  const secret = manifest.config_schema.find((field) => field.key === 'token_secret');
  assert.equal(secret.type, 'secret');
  // A `secret` field must never declare a default: the value would be shipped
  // in the manifest, and the schema rejects it.
  assert.equal(secret.default, undefined);
});

test('the three credentials are the only required fields', () => {
  const required = manifest.config_schema
    .filter((field) => field.required === true)
    .map((field) => field.key)
    .sort();
  assert.deepEqual(required, ['host', 'token_id', 'token_secret']);
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  const minVersion = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(minVersion, 'gladys_version must declare a minimum version');
  const [, major, minor] = minVersion.map(Number);
  assert.ok(
    major > 4 || (major === 4 && minor >= 86),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

test('the integration declares the local transport only', () => {
  // Proxmox is reached over the LAN: there is no cloud channel, so Gladys must
  // not render the "Prefer the local connection" toggle.
  assert.deepEqual(manifest.transports, ['local']);
});

test('the manifest version matches the docker image tag', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    `docker_image "${manifest.docker_image}" must be tagged with version ${manifest.version}`,
  );
});
