import { test } from 'node:test';
import assert from 'node:assert/strict';
import { galleryPose, visibleSlots, clampCursor, type GalleryMode } from '../src/lib/artwork-space/layout.ts';

test('all explorers frame the selected artwork head-on while neighbors occupy real depth', () => {
  for (const mode of ['flow', 'panels', 'orbit'] as GalleryMode[]) {
    const selected = galleryPose(mode, 0);
    assert.equal(Math.hypot(selected.x, selected.y, selected.z, selected.yaw), 0);
    const neighbors = [-3, -2, -1, 1, 2, 3].map(offset => galleryPose(mode, offset));
    assert.ok(neighbors.every(pose => pose.z < 0 && Math.abs(pose.yaw) > 0));
    assert.equal(new Set(neighbors.map(pose => `${pose.x},${pose.y},${pose.z}`)).size, neighbors.length);
    for (const offset of [-10000, -1.2, 0, 0.8, 10000]) assert.ok(Object.values(galleryPose(mode, offset)).every(Number.isFinite));
  }
  assert.notEqual(galleryPose('panels', 2).y, 0);
  assert.notEqual(galleryPose('orbit', 7).y, galleryPose('orbit', 1).y);
});

test('large and empty libraries retain bounded neighborhoods with no wrapped duplicate artwork', () => {
  assert.deepEqual(visibleSlots(0, 0), []);
  assert.deepEqual(visibleSlots(1, 0), [0]);
  for (const cursor of [0, 1.5, 5000, 99999]) {
    const slots = visibleSlots(100000, cursor);
    assert.ok(slots.length <= 25);
    assert.equal(new Set(slots).size, slots.length);
    assert.ok(slots.every(index => index >= 0 && index < 100000));
    assert.ok(slots.includes(Math.round(cursor)));
    assert.ok(visibleSlots(100000, cursor, 8).length <= 17);
  }
  assert.equal(clampCursor(NaN, 10), 0);
  assert.equal(clampCursor(-1, 10), 0);
  assert.equal(clampCursor(100, 10), 9);
  assert.equal(clampCursor(100, 0), 0);
});
