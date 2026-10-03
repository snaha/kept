<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { T, useTask, useThrelte } from '@threlte/core/webgpu';
  import * as THREE from 'three/webgpu';
  import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
  import { positionWorld, mx_noise_float, vec3, uv, exp } from 'three/tsl';
  import type { Tile } from '../library.svelte';
  import { galleryPose, visibleSlots, type GalleryMode } from './layout';

  let { albums, cursor, mode, active, reduced, zoom, bottomClearance, inCollection, onready, onframe, onmissing }: {
    albums: Tile[]; cursor: number; mode: GalleryMode; active: boolean; reduced: boolean; zoom: number;
    bottomClearance: number; inCollection: boolean;
    onready: () => void; onframe: (cursor: number, count: number, distance: number, bounds: number[]) => void; onmissing: (count: number) => void;
  } = $props();
  const { scene, size, renderer, invalidate } = useThrelte();
  const root = new THREE.Group(), covers = new THREE.Group(), flowRoom = new THREE.Group(), panelRoom = new THREE.Group(), orbitRoom = new THREE.Group();
  root.add(covers, flowRoom, panelRoom, orbitRoom); scene.add(root);
  scene.background = new THREE.Color('#141719');
  scene.fog = new THREE.FogExp2('#141719', 0.012);
  const view = new THREE.PerspectiveCamera(42, 1, 0.1, 150);
  const resources: { dispose: () => void }[] = [];
  function own<T extends { dispose: () => void }>(resource: T) { resources.push(resource); return resource; }
  const plane = own(new THREE.PlaneGeometry(1, 1)), cube = own(new THREE.BoxGeometry(1, 1, 1));
  const sleeve = own(new RoundedBoxGeometry(4.86, 4.86, 0.18, 2, 0.035));
  const metal = own(new THREE.MeshStandardMaterial({ color: '#585752', metalness: 0.65, roughness: 0.35 }));
  const copper = own(new THREE.MeshStandardMaterial({ color: '#806b4e', metalness: 0.72, roughness: 0.4 }));
  const floorMaterial = own(new THREE.MeshStandardNodeMaterial({ metalness: 0.32, roughness: 0.46 }));
  const grain = mx_noise_float(positionWorld.mul(0.16)).mul(0.5).add(0.5);
  floorMaterial.colorNode = vec3(0.027, 0.032, 0.038).add(vec3(0.014, 0.011, 0.008).mul(grain));
  floorMaterial.roughnessNode = grain.mul(0.22).add(0.28);
  const floor = new THREE.Mesh(plane, floorMaterial); floor.rotation.x = -Math.PI / 2; floor.scale.set(180, 180, 1); root.add(floor);
  const shadowMaterial = own(new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false }));
  shadowMaterial.colorNode = vec3(0.003, 0.005, 0.008);
  shadowMaterial.opacityNode = exp(uv().sub(0.5).length().pow(2).mul(-18)).mul(0.6);
  const key = new THREE.DirectionalLight('#fff0cf', 4); key.position.set(8, 12, 10);
  const fill = new THREE.DirectionalLight('#bbdbf3', 2.5); fill.position.set(-10, 3, -3);
  root.add(key, fill, new THREE.HemisphereLight('#c4d7e8', '#1d1c19', 2));
  function beam(parent: THREE.Group, material: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number) {
    const mesh = new THREE.Mesh(cube, material); mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); parent.add(mesh); return mesh;
  }
  // Physical rails and suspended frames establish scale without competing with art.
  for (const side of [-1, 1]) {
    beam(flowRoom, metal, 0, -2.64, side * 5, 100, 0.08, 0.1);
    beam(panelRoom, copper, side * 18, 7, -18, 0.12, 0.12, 80);
    for (let index = 0; index < 7; index++) beam(panelRoom, metal, side * (7 + index * 4), 0, -8 - index * 7, 0.15, 20, 0.15);
  }
  const ringGeometry = own(new THREE.TorusGeometry(9, 0.035, 6, 96));
  for (const y of [-6, 0, 6]) {
    const ring = new THREE.Mesh(ringGeometry, copper); ring.rotation.x = Math.PI / 2; ring.position.set(0, y, -9); orbitRoom.add(ring);
  }
  const starPositions = new Float32Array(120 * 3);
  for (let index = 0; index < 120; index++) {
    starPositions[index * 3] = Math.sin(index * 127.1) * 45;
    starPositions[index * 3 + 1] = Math.cos(index * 311.7) * 25;
    starPositions[index * 3 + 2] = -30 - (index % 11) * 3;
  }
  const stars = own(new THREE.BufferGeometry()); stars.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  orbitRoom.add(new THREE.Points(stars, own(new THREE.PointsMaterial({ color: '#a7bcc8', size: 0.055, transparent: true, opacity: 0.55 }))));
  type Entry = { album: Tile; index: number; group: THREE.Group; image: THREE.Mesh; reflection: THREE.Mesh; shadow: THREE.Mesh; material: THREE.MeshBasicMaterial; reflected: THREE.MeshBasicMaterial; texture?: THREE.Texture; failed: boolean };
  const entries = new Map<string, Entry>(), loader = new THREE.TextureLoader(), raycaster = new THREE.Raycaster();
  const scratch = new THREE.Vector3();
  let disposed = false, first = true, shownCursor = untrack(() => cursor), frameTime = 0;
  function fallback(album: Tile) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
    const context = canvas.getContext('2d')!; context.fillStyle = '#24292c'; context.fillRect(0, 0, 512, 512);
    context.fillStyle = '#e9e9e5'; context.font = '30px sans-serif';
    const words = album.title.split(/\s+/); let line = '', y = 205;
    for (const word of words) {
      if (context.measureText(`${line} ${word}`).width > 420 && line) { context.fillText(line, 36, y); y += 42; line = ''; }
      if (y > 390) break;
      line = `${line} ${word}`.trim();
    }
    context.fillText(line, 36, y); context.font = '18px sans-serif'; context.fillStyle = '#aebcc3'; context.fillText('Artwork unavailable', 36, 470);
    const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace; return map;
  }
  function remove(entry: Entry) {
    covers.remove(entry.group); root.remove(entry.shadow); entry.texture?.dispose(); entry.material.dispose(); entry.reflected.dispose();
  }
  function missing() { onmissing([...entries.values()].filter(entry => entry.failed).length); }
  function create(album: Tile, index: number) {
    const group = new THREE.Group(), material = new THREE.MeshBasicMaterial({ color: '#fff', side: THREE.DoubleSide, toneMapped: false });
    const body = new THREE.Mesh(sleeve, metal), image = new THREE.Mesh(plane, material);
    image.scale.set(4.8, 4.8, 1); image.position.z = 0.101; image.userData.id = album.id;
    group.add(body, image); covers.add(group);
    const reflected = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const reflection = new THREE.Mesh(plane, reflected); reflection.scale.set(4.8, -4.8, 1); reflection.position.set(0, -5.15, 0.1); group.add(reflection);
    const shadow = new THREE.Mesh(plane, shadowMaterial); shadow.rotation.x = -Math.PI / 2; shadow.scale.set(8, 8, 1); root.add(shadow);
    const entry: Entry = { album, index, group, image, reflection, shadow, material, reflected, failed: !album.cover };
    entries.set(album.id, entry);
    if (album.cover) {
      const map = loader.load(album.cover, () => {
        if (disposed || entries.get(album.id) !== entry) { map.dispose(); return; }
        material.map = map; reflected.map = map; material.needsUpdate = reflected.needsUpdate = true; invalidate();
      }, undefined, () => {
        if (disposed || entries.get(album.id) !== entry) return;
        map.dispose(); entry.texture = fallback(entry.album); material.map = entry.texture; material.needsUpdate = true; entry.failed = true; missing(); invalidate();
      });
      map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 2; entry.texture = map;
    } else { entry.texture = fallback(album); material.map = entry.texture; }
    const pose = galleryPose(mode, index - shownCursor); group.position.set(pose.x, pose.y, pose.z); group.rotation.set(0, pose.yaw, pose.roll);
    return entry;
  }
  $effect(() => {
    const list = albums, target = cursor;
    const radius = size.current.width < 700 ? 8 : 12;
    untrack(() => {
      // Retain both ends during a deliberate long jump, bounded by two neighborhoods.
      const slots = new Set([...visibleSlots(list.length, target, radius), ...visibleSlots(list.length, shownCursor, radius)]);
      const keep = new Set([...slots].map(index => list[index].id));
      for (const [id, entry] of entries) if (!keep.has(id)) { remove(entry); entries.delete(id); }
      for (const index of slots) {
        const album = list[index], old = entries.get(album.id);
        if (old && old.album.cover !== album.cover) { remove(old); entries.delete(album.id); }
        const entry = entries.get(album.id) ?? create(album, index); entry.index = index; entry.album = album;
      }
      missing(); invalidate();
    });
  });
  $effect(() => { mode; zoom; reduced; invalidate(); });
  export function pick(x: number, y: number) {
    const rect = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2((x - rect.left) / rect.width * 2 - 1, -(y - rect.top) / rect.height * 2 + 1), view);
    return raycaster.intersectObjects([...entries.values()].map(entry => entry.image))[0]?.object.userData.id as string | undefined;
  }
  useTask(delta => {
    const dt = Math.min(delta, 0.05), damping = reduced ? 1 : 1 - Math.exp(-dt * 11);
    shownCursor = THREE.MathUtils.lerp(shownCursor, cursor, damping);
    if (Math.abs(shownCursor - cursor) < 0.001) shownCursor = cursor;
    const width = size.current.width, height = Math.max(1, size.current.height), narrow = width < 700;
    const topSpace = inCollection ? (narrow ? 128 : 136) : (narrow ? 72 : 76);
    const usableHeight = Math.max(80, height - topSpace - bottomClearance), center = topSpace + usableHeight / 2;
    const tangent = Math.tan(THREE.MathUtils.degToRad(21));
    const distance = Math.max(4.8 / (2 * tangent * (usableHeight / height)), 4.8 / (2 * tangent * (width / height) * (narrow ? 0.82 : 0.62))) * 1.12 / zoom;
    view.aspect = width / height; view.setViewOffset(width, height, 0, height / 2 - center, width, height);
    view.position.set(0, 0.2, distance); view.lookAt(0, 0, 0); view.updateMatrixWorld();
    flowRoom.visible = mode === 'flow'; panelRoom.visible = mode === 'panels'; orbitRoom.visible = mode === 'orbit'; floor.position.y = mode === 'orbit' ? -9 : -2.6;
    for (const entry of entries.values()) {
      const pose = galleryPose(mode, entry.index - shownCursor);
      entry.group.position.lerp(scratch.set(pose.x, pose.y, pose.z), damping);
      const yaw = Math.atan2(Math.sin(pose.yaw - entry.group.rotation.y), Math.cos(pose.yaw - entry.group.rotation.y));
      entry.group.rotation.y += yaw * damping; entry.group.rotation.z = THREE.MathUtils.lerp(entry.group.rotation.z, pose.roll, damping);
      entry.reflection.visible = mode === 'flow'; entry.shadow.visible = mode !== 'orbit'; entry.shadow.position.set(pose.x, -2.58, pose.z);
    }
    frameTime += dt;
    if (frameTime > 0.1 || first) {
      frameTime = 0; root.updateMatrixWorld(true);
      const image = entries.get(albums[Math.round(cursor)]?.id)?.image;
      const corners = image ? [[-.5, -.5], [-.5, .5], [.5, -.5], [.5, .5]].map(([x, y]) => {
        const point = image.localToWorld(new THREE.Vector3(x, y, 0)).project(view);
        return [(point.x + 1) * width / 2, (1 - point.y) * height / 2];
      }) : [];
      const bounds = corners.length ? [Math.min(...corners.map(point => point[0])), Math.min(...corners.map(point => point[1])), Math.max(...corners.map(point => point[0])), Math.max(...corners.map(point => point[1]))] : [0, 0, 0, 0];
      onframe(shownCursor, entries.size, distance, bounds);
    }
    if (first) { first = false; onready(); }
    // Retire the previous neighborhood after a long jump has settled.
    if (shownCursor === cursor) {
      const keep = new Set(visibleSlots(albums.length, cursor, narrow ? 8 : 12).map(index => albums[index].id));
      for (const [id, entry] of entries) if (!keep.has(id)) { remove(entry); entries.delete(id); }
    }
    invalidate();
  }, { autoInvalidate: false, running: () => active });
  onDestroy(() => { disposed = true; scene.remove(root); for (const entry of entries.values()) remove(entry); entries.clear(); for (const resource of resources) resource.dispose(); });
</script>
<T is={view} makeDefault manual />
