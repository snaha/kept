export type GalleryMode = 'flow' | 'panels' | 'orbit';
export const galleryNames: Record<GalleryMode, string> = { flow: 'Cover flow', panels: 'Panels', orbit: 'Orbit' };

export function galleryPose(mode: GalleryMode, offset: number) {
  const distance = Math.abs(offset);
  if (mode === 'orbit') {
    const angle = offset * 0.62;
    return { x: Math.sin(angle) * 9, y: offset * 0.72, z: (Math.cos(angle) - 1) * 9, yaw: angle, roll: 0 };
  }
  if (mode === 'panels') {
    return { x: offset * 4.6, y: Math.sin(offset * 0.65) * 1.6, z: -distance * 3.4, yaw: -Math.tanh(offset * 1.8) * 0.58, roll: Math.sin(offset * 0.7) * 0.035 };
  }
  return { x: offset * 1.6 + Math.tanh(offset * 2) * 2.8, y: 0, z: -Math.min(distance, 1) * 2.6 - distance * 0.35, yaw: -Math.tanh(offset * 3) * 1.08, roll: 0 };
}

export function visibleSlots(length: number, cursor: number, radius = 12) {
  const center = Math.max(0, Math.min(length - 1, Math.round(cursor)));
  const start = Math.max(0, center - radius), end = Math.min(length, center + radius + 1);
  return Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
}

export function clampCursor(cursor: number, length: number) {
  return Math.max(0, Math.min(Math.max(0, length - 1), Number.isFinite(cursor) ? cursor : 0));
}
