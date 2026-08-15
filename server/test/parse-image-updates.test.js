'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseImageUpdateOutput, parseImageUpdateReport } = require('../utils/parse-image-updates');

test('image update parser accepts Ansible callback whitespace and container-scoped results', () => {
  const result = parseImageUpdateOutput('ok: [hms] => {"msg" : ["sonarr|lscr.io/linuxserver/sonarr:latest|update_available", "media-manager|media_manager-media-manager:latest|not_checkable"]}');
  assert.deepEqual(result, [
    { container_name: 'sonarr', image: 'lscr.io/linuxserver/sonarr:latest', status: 'update_available' },
    { container_name: 'media-manager', image: 'media_manager-media-manager:latest', status: 'not_checkable' },
  ]);
});

test('image update parser keeps legacy image-scoped results compatible', () => {
  assert.deepEqual(parseImageUpdateOutput('{"msg":["nginx:latest|up_to_date"]}'), [
    { image: 'nginx:latest', status: 'up_to_date' },
  ]);
});

test('marked results survive Ansible callback formatting and report completion', () => {
  const report = parseImageUpdateReport('ok: [hms] => {"msg": ["__SHIPYARD_IMAGE_UPDATE__sonarr|lscr.io/linuxserver/sonarr:latest|update_available"]}\nok: [hms] => {"msg": "__SHIPYARD_IMAGE_UPDATE_DONE__"}');
  assert.equal(report.complete, true);
  assert.deepEqual(report.results, [
    { container_name: 'sonarr', image: 'lscr.io/linuxserver/sonarr:latest', status: 'update_available' },
  ]);
});

test('a partial result is never considered a completed image update check', () => {
  const report = parseImageUpdateReport('__SHIPYARD_IMAGE_UPDATE__sonarr|lscr.io/linuxserver/sonarr:latest|up_to_date');
  assert.equal(report.complete, false);
  assert.equal(report.results.length, 1);
});
