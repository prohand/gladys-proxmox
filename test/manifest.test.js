// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers, nor which defaults it applies —
// these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG, DISKS_MONITORING_VALUES } from '../src/config.js';
import { DATE_FORMAT_VALUES } from '../src/format.js';
import { SERVER_IDS, serverConfigKeys } from '../src/servers.js';

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

test('every select offers exactly the values the code accepts', () => {
  // A value the form can produce but `normalizeConfig()` silently rewrites is
  // a setting that does nothing: the two lists have to be the same list.
  const accepted = {
    backup_success_scope: ['ok_only', 'ok_and_warnings'],
    date_format: DATE_FORMAT_VALUES,
    disks_monitoring: DISKS_MONITORING_VALUES,
  };
  const selects = manifest.config_schema.filter((field) => field.type === 'select');
  assert.deepEqual(
    selects.map((field) => field.key).sort(),
    Object.keys(accepted).sort(),
    'a new select must declare which values the code accepts',
  );
  for (const field of selects) {
    const values = field.options.map((option) => option.value);
    assert.deepEqual([...values].sort(), [...accepted[field.key]].sort());
    assert.ok(values.includes(field.default), `the default of "${field.key}" must be an option`);
    for (const option of field.options) {
      assert.ok(option.label?.en && option.label?.fr, 'every option stays bilingual');
    }
  }
});

test('the section blocks are purely presentational', () => {
  const sections = manifest.config_schema.filter((field) => field.type === 'section');
  assert.deepEqual(
    sections.map((section) => section.key),
    ['intro', 'second_server', 'shared_options'],
  );
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

test('every token secret is declared as a secret field', () => {
  const secrets = manifest.config_schema.filter((field) => field.key.startsWith('token_secret'));
  assert.equal(secrets.length, SERVER_IDS.length);
  for (const secret of secrets) {
    assert.equal(secret.type, 'secret');
    // A `secret` field must never declare a default: the value would be shipped
    // in the manifest, and the schema rejects it.
    assert.equal(secret.default, undefined);
  }
});

test('both server blocks declare the same fields, with the same types', () => {
  const byKey = new Map(manifest.config_schema.map((field) => [field.key, field]));
  const [first, ...others] = SERVER_IDS.map((id) => serverConfigKeys(id));

  for (const keys of [first, ...others]) {
    for (const key of keys) {
      assert.ok(byKey.has(key), `config field "${key}" is missing from the manifest`);
    }
  }
  for (const keys of others) {
    keys.forEach((key, index) => {
      assert.equal(
        byKey.get(key).type,
        byKey.get(first[index]).type,
        `"${key}" must have the same type as "${first[index]}"`,
      );
      // Only the first server is mandatory: an empty second block is how a
      // single-Proxmox setup says "there is no second one".
      assert.equal(byKey.get(key).required, false, `"${key}" must stay optional`);
    });
  }
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

test('the store description stays under the 100 character cap', () => {
  // The store schema rejects a longer one (`manifest.description.*: must NOT
  // have more than 100 characters`), and the indexer is the only place that
  // check runs — so it runs here too.
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length <= 100,
      `manifest.description.${lang} is ${text.length} characters, the store allows 100`,
    );
  }
});
