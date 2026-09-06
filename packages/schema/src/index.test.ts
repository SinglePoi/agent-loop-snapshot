import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { schemaFiles, snapshotSchemaVersion } from './index.js';
import { validateSnapshotDirectory } from './validator.js';

test('exports the initial snapshot schema version', () => {
  assert.equal(snapshotSchemaVersion, '0.1.0');
});

test('ships all v0.1.0 JSON Schemas with a versioned root', async () => {
  const schemaDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../schemas');

  for (const fileName of Object.values(schemaFiles)) {
    const rawSchema = await readFile(resolve(schemaDirectory, fileName), 'utf8');
    const schema = JSON.parse(rawSchema) as {
      $schema?: string;
      properties?: { schema_version?: { const?: string } };
    };

    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.properties?.schema_version?.const, snapshotSchemaVersion);
  }
});

test('validates reusable golden fixtures and reports expected failures', async (t) => {
  const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
  const fixtures = [
    { name: 'minimal-success', valid: true },
    { name: 'tool-failure-retry', valid: true },
    { name: 'parallel-calls', valid: true },
    { name: 'corrupted-reference', valid: false, code: 'ARTIFACT_DIGEST_MISMATCH' },
    { name: 'unknown-version', valid: false, code: 'SCHEMA_CONST' },
  ] as const;

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const result = await validateSnapshotDirectory(resolve(fixtureDirectory, fixture.name));

      assert.equal(result.valid, fixture.valid);
      if (!fixture.valid) {
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === fixture.code));
        assert.ok(result.diagnostics.every((diagnostic) => diagnostic.path.startsWith('/')));
      }
    });
  }
});
