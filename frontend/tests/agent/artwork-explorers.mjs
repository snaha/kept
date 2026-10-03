import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve(import.meta.dirname, '../../../.audit-results', `artwork-explorers-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(output, { recursive: true });
const cli = process.env.MUSIC_AGENT_BROWSER || 'agent-browser', session = 'music-artwork-explorers';
let started = false;
const run = (...command) => {
  const env = { ...process.env }; if (started) delete env.AGENT_BROWSER_EXECUTABLE_PATH; started = true;
  return execFileSync(cli, ['--session', session, ...command], { encoding: 'utf8', timeout: 30000, env }).trim();
};
const evaluate = code => run('eval', code);
const assert = (condition, message) => evaluate(`(() => { if (!(${condition})) throw new Error(${JSON.stringify(message)}); return 'PASS'; })()`);
const button = name => `button[aria-label="${name}"]`;
const field = '.artwork-explorer:not(.concealed)';
const settled = () => { run('wait', '--fn', `(() => { const node=document.querySelector('${field}'); return Number(node.dataset.cursor)===Number(node.querySelector('.position').textContent.split('/')[0])-1 && Number(node.dataset.meshCount)<=(innerWidth<700?17:25); })()`); run('wait', '1000'); };
const framing = () => assert(`(() => {
  const node=document.querySelector('${field}'), r=node.getBoundingClientRect(), [left,top,right,bottom]=node.dataset.artBounds.split(',').map(Number);
  const console=document.querySelector('${field} .album-console').getBoundingClientRect();
  const clear=bottom+r.top<console.top-8 || right+r.left<console.left-8 || left+r.left>console.right+8;
  const strip=node.querySelector('.collection-strip')?.getBoundingClientRect();
  return left>=12 && right<=r.width-12 && top>=60 && bottom<=r.height-12 && clear && (!strip || top+r.top>strip.bottom+8) && right-left>80;
})()`, 'The complete selected artwork must stay clear of heading and album controls');
const capture = name => run('screenshot', path.join(output, `${name}.png`));
const url = process.env.MUSIC_AUDIT_URL || `http://127.0.0.1:${process.env.MUSIC_AUDIT_PORT || 4178}`;
const results = [];
const modes = [['flow', 'Cover flow'], ['panels', 'Panels'], ['orbit', 'Orbit']];
try {
  const sizes = process.env.MUSIC_AUDIT_SIZES ? JSON.parse(process.env.MUSIC_AUDIT_SIZES) : [[1920,1080], [1440,900], [1024,768], [390,844]];
  for (const [width, height] of sizes) {
    const size = `${width}x${height}`;
    run('set', 'viewport', String(width), String(height)); run('open', url); run('wait', '.tile-wrap');
    evaluate('document.querySelector(".scroll").scrollTop=600; window.__galleryWallScroll=document.querySelector(".scroll").scrollTop');
    for (const [mode, name] of modes) {
      run('click', button(`Explore artwork in ${name}`)); run('wait', `${field}[data-ready="true"]`);
      assert(`document.querySelector('${field}').dataset.mode === '${mode}' && !!document.querySelector('${field} canvas')`, 'Each view must render a real 3D canvas');
      assert(`document.documentElement.scrollWidth<=innerWidth && document.querySelector('.scroll').inert`, 'The scene must fit and leave the preserved wall inert');
      evaluate(`(() => { const el=document.querySelector('${field} select'); el.value='1980'; el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      run('wait', '--fn', `document.querySelector('${field} .album-title').textContent==='Album 010'`);
      settled(); framing(); capture(`${size}-${mode}`);
      evaluate(`window.__gallerySelected=document.querySelector('${field}').dataset.selected; window.__galleryDistance=Number(document.querySelector('${field}').dataset.cameraDistance); document.querySelector('${field}').focus()`);
      run('press', 'ArrowRight');
      assert(`document.querySelector('${field}').dataset.selected!==window.__gallerySelected`, 'Keyboard selection must respond without playback shortcuts');
      run('press', 'ArrowLeft'); settled();
      evaluate(`document.querySelector('${field} canvas').dispatchEvent(new WheelEvent('wheel',{deltaY:160,bubbles:true,cancelable:true}))`);
      run('wait', '400');
      assert(`document.querySelector('${field}').dataset.selected!==window.__gallerySelected`, 'Wheel input must browse the gallery');
      run('click', button('Zoom into artwork')); run('wait', '200');
      assert(`Number(document.querySelector('${field}').dataset.cameraDistance)<window.__galleryDistance`, 'Zoom must move the perspective camera closer');
      run('click', `${field} .view-options button:last-child`); settled();
      evaluate(`window.__galleryBeforeRefresh=document.querySelector('${field}').dataset.selected; window.__auditRefresh()`);
      assert(`document.querySelector('${field}').dataset.selected===window.__galleryBeforeRefresh`, 'Background metadata must preserve the selected artwork');
      run('click', `${field} .album-actions button:nth-child(2)`); run('wait', '.album-view');
      assert(`document.querySelector('.artwork-explorer').dataset.running==='false'`, 'Track details must pause the gallery');
      run('press', 'Escape'); run('wait', '--fn', `document.querySelector('${field}').dataset.running==='true'`);
    }
    run('click', `${field} .album-actions .collection-play`); run('wait', '--fn', 'window.__auditCommands.some(command=>command[0]==="play")');
    run('click', `${field} .album-actions .collection-play`); run('wait', '--fn', 'window.__auditCommands.some(command=>command[0]==="pause")');
    evaluate('window.__galleryCommands=window.__auditCommands.length');
    run('click', `${field} .album-actions button[aria-label^="Add "]`); run('wait', '#player-tab-queue');
    assert('window.__auditCommands.length===window.__galleryCommands', 'Queueing artwork must not restart playback');
    run('press', 'Escape');
    run('click', button('Explore artwork in Orbit'));
    assert('!document.querySelector(".scroll").inert && document.querySelector(".scroll").scrollTop===window.__galleryWallScroll', 'Returning to the same album wall must preserve its scroll');
    run('click', button('Explore artwork in Orbit'));
    run('click', '[aria-label="Open Collection type"]'); run('click', '[role="option"][data-value="playlists"]');
    run('wait', '--fn', `document.querySelector('${field} .album-title')?.textContent==='Liked Songs'`);
    evaluate('window.__galleryWallScroll=document.querySelector(".scroll").scrollTop');
    run('click', button('Next artwork'));
    run('wait', '--fn', `document.querySelector('${field} .album-title').textContent==='Night flights'`);
    run('click', `${field} .album-actions button:last-child`); run('wait', `${field}[data-artworks="6"]`);
    assert(`document.querySelector('${field}').dataset.collection==='spotify:playlist:artworks' && document.querySelector('${field} .album-title').textContent==='Afterimage'`, 'A paged playlist must expand into six actual album identities');
    run('click', button('Next artwork')); run('click', button('Next artwork'));
    for (const [mode, name] of modes) {
      if (mode !== 'orbit') run('click', button(`Explore artwork in ${name}`));
      else if (!evaluate(`document.querySelector('${field}').dataset.mode==='orbit'`).includes('true')) run('click', button(`Explore artwork in ${name}`));
      settled();
      assert(`document.querySelector('${field}').dataset.collection==='spotify:playlist:artworks' && document.querySelector('${field} .album-title').textContent==='Glass horizon'`, 'Switching gallery layouts must preserve the playlist and selected member');
      framing(); capture(`${size}-${mode}-playlist`);
    }
    evaluate(`document.querySelector('${field}').focus()`); run('press', 'Escape');
    assert(`document.querySelector('${field}').dataset.collection==='' && document.querySelector('${field} .album-title').textContent==='Night flights'`, 'Leaving a playlist must restore its parent selection');
    run('click', button('Explore artwork in Orbit'));
    assert('!document.querySelector(".scroll").inert && document.querySelector(".scroll").scrollTop===window.__galleryWallScroll', 'Returning to the cover wall must preserve its scroll');
    results.push({ viewport:size, assertions:'pass', visual:'pending image inspection', renderer:JSON.parse(evaluate('document.querySelector(".artwork-explorer").dataset.renderer')) });
  }
  run('set','viewport','1440','900'); run('open', `${url}?chronocity-backend=webgl`); run('wait','.tile-wrap');
  for (const [mode,name] of modes) {
    run('click',button(`Explore artwork in ${name}`)); run('wait',`${field}[data-ready="true"]`); settled(); framing();
    assert(`document.querySelector('${field}').dataset.renderer==='webgl'`, 'Each explorer must support the WebGL2 fallback'); capture(`webgl-${mode}`);
  }
  // Exercise the MediaQueryList contract: the installed media CLI rejects its own payload.
  // Mount a fresh gallery so its reduced-motion subscription reads the synthetic preference.
  run('open',`${url}?chronocity-backend=webgl`); run('wait','.tile-wrap');
  evaluate(`(() => { const original=window.matchMedia; window.matchMedia=q=>q==='(prefers-reduced-motion: reduce)'?{matches:true,media:q,addEventListener:()=>{},removeEventListener:()=>{}}:original(q); })()`);
  run('click',button('Explore artwork in Cover flow')); run('wait',`${field}[data-reduced="true"][data-ready="true"]`);
  run('click',button('Next artwork')); run('wait','150');
  assert(`Number(document.querySelector('${field}').dataset.cursor)===1`, 'Reduced motion must remove selection easing');
  results.push({scenario:'webgl and simulated reduced motion',assertions:'pass',visual:'pending image inspection'});
} catch (error) {
  results.push({assertions:'fail',error:error.message}); try{capture('failure');}catch{} process.exitCode=1;
} finally {
  try {run('set','viewport','1280','720');run('close');}catch{}
  await writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2)); console.log(output);
}
