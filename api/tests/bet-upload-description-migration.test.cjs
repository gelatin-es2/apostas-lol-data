'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const migration = fs.readFileSync(path.resolve(__dirname, '../../migrations/2026-08-13-bet-upload-description.sql'), 'utf8');

test('migration incremental altera somente bet_upload_jobs', () => {
  assert.match(migration, /alter table public\.bet_upload_jobs[\s\S]*add column if not exists description text/);
  assert.match(migration, /bet_upload_jobs_description_length_check/);
  assert.match(migration, /char_length\(description\) between 1 and 500/);
  assert.doesNotMatch(migration, /alter table public\.bets\b/i);
  assert.doesNotMatch(migration, /create table|drop table|delete from|update public\./i);
});
