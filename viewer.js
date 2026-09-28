// せせらぎのロッジ Web見本
// Unity で焼き込んだ光（ライトマップ）をそのまま使って、ワールドを表示する。
import * as THREE from 'three';

const DATA = '';
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // 色の変換はシェーダー内で行う
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.03, 900);
camera.rotation.order = 'YXZ';
const shared = { time: { value: 0 } };

// ---------------------------------------------------------------- 読み込み
const meter = document.getElementById('meter');
const loadText = document.getElementById('loadText');
let loaded = 0, total = 1;
function progress() { meter.style.width = Math.min(100, (loaded / total) * 100).toFixed(1) + '%'; }

async function fetchBin(urls, size) {
  const chunks = []; let got = 0; total = size;
  for (const url of urls) {
    const res = await fetch(url);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length; loaded = got; progress();
    }
  }
  const out = new Uint8Array(got); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

const texLoader = new THREE.TextureLoader();
const texCache = new Map();
function loadTex(path, srgb) {
  const key = path + (srgb ? ':s' : ':l');
  if (texCache.has(key)) return texCache.get(key);
  const t = texLoader.load(DATA + path);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  texCache.set(key, t);
  return t;
}

// ---------------------------------------------------------------- シェーダー
const common = /* glsl */`
  vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
  // 夜の闇（遠くほど暗く沈む。ワールドの霧と同じ考え方）
  vec3 night(vec3 c, vec3 w) {
    float d = distance(w, cameraPosition);
    float f = 1.0 - exp(-0.085 * max(d - 8.0, 0.0));
    return mix(c, vec3(0.0035, 0.0045, 0.0065), clamp(f, 0.0, 1.0));
  }
`;
const skyDir = /* glsl */`
  const float PI = 3.14159265;
  vec2 equirect(vec3 d) {
    d = normalize(vec3(d.x, d.y, -d.z));
    float u = atan(d.x, d.z) / (2.0 * PI) + 0.5;
    float v = asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5;
    return vec2(u, v);
  }`;
const litVert = /* glsl */`
  attribute vec2 uv2x; attribute vec3 vcol; attribute vec3 nrm; attribute vec4 wts;
  uniform vec4 st;
  varying vec2 vUv; varying vec2 vLm; varying vec3 vCol; varying vec3 vW; varying vec3 vN; varying vec4 vWt;
  void main() {
    vUv = uv * st.xy + st.zw; vLm = uv2x; vCol = vcol; vW = position; vN = nrm; vWt = wts;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const litFrag = /* glsl */`
  uniform sampler2D map; uniform bool hasMap; uniform vec4 color; uniform vec3 emission;
  uniform sampler2D lightmap; uniform bool useLm; uniform float lmRange; uniform float cutoff; uniform float tri;
  uniform int mode; // 0 lit, 1 unlit, 3 terrain, 4 impostor
  uniform sampler2D t0; uniform sampler2D t1; uniform sampler2D t2; uniform sampler2D t3; uniform vec4 tiles; uniform vec3 tint0; uniform vec3 tint1; uniform vec3 tint2; uniform vec3 tint3;
  varying vec2 vUv; varying vec2 vLm; varying vec3 vCol; varying vec3 vW; varying vec3 vN; varying vec4 vWt;
  ${common}
  vec4 triplanar(vec3 p, vec3 n) {
    vec3 b = pow(abs(normalize(n)), vec3(4.0)); b /= max(b.x + b.y + b.z, 1e-4);
    p *= tri;
    return texture2D(map, p.zy) * b.x + texture2D(map, p.xz) * b.y + texture2D(map, p.xy) * b.z;
  }
  void main() {
    vec4 a;
    if (mode == 3) {
      vec2 q = vec2(vW.x, -vW.z);
      vec4 w = vWt / max(dot(vWt, vec4(1.0)), 1e-4);
      a = vec4(texture2D(t0, q / tiles.x).rgb * tint0 * w.x + texture2D(t1, q / tiles.y).rgb * tint1 * w.y
             + texture2D(t2, q / tiles.z).rgb * tint2 * w.z + texture2D(t3, q / tiles.w).rgb * tint3 * w.w, 1.0);
    } else {
      a = hasMap ? (tri > 0.0 ? triplanar(vec3(vW.x, vW.y, -vW.z), vec3(vN.x, vN.y, -vN.z)) : texture2D(map, vUv)) : vec4(1.0);
      a *= color;
    }
    if (cutoff > 0.0 && a.a < cutoff) discard;
    vec3 c;
    if (mode == 1) c = a.rgb + emission;
    else {
      vec3 light;
      if (useLm) { vec4 e = texture2D(lightmap, vLm); light = e.rgb * e.a * lmRange; }
      else light = vCol;
      if (mode == 4) light = vec3(0.012, 0.016, 0.022);
      c = a.rgb * light + emission;
    }
    gl_FragColor = vec4(toSRGB(max(night(c, vW), 0.0)), 1.0);
  }`;

const glassVert = /* glsl */`
  attribute vec3 nrm;
  varying vec3 vN; varying vec3 vW;
  void main() { vN = nrm; vW = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const glassFrag = /* glsl */`
  uniform vec4 color; uniform sampler2D sky; uniform bool water; uniform float time;
  varying vec3 vN; varying vec3 vW;
  ${common}
  ${skyDir}
  void main() {
    vec3 n = normalize(vN);
    if (water) {
      // 川: ゆっくり流れる小さな波で、空（星と天の川）を映す
      vec2 p = vec2(vW.x, -vW.z);
      float t = time;
      n = normalize(vec3(sin(p.x * 3.1 + t * 1.3) * 0.03 + sin(p.y * 4.7 - t * 1.7) * 0.02, 1.0,
                         cos(p.y * 2.9 + t * 1.1) * 0.03 + sin(p.x * 5.3 + p.y * 2.0 - t * 2.1) * 0.02));
    }
    vec3 v = normalize(cameraPosition - vW);
    if (dot(n, v) < 0.0) n = -n;
    float f = 0.02 + 0.98 * pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 5.0);
    vec3 env = pow(texture2D(sky, equirect(reflect(-v, n))).rgb, vec3(2.2));
    if (water) {
      vec3 c = color.rgb * 0.05 + env * (0.25 + 0.75 * f) * 1.2;
      gl_FragColor = vec4(toSRGB(night(c, vW)), 1.0);
    } else {
      float a = clamp(color.a + f * 0.35, 0.0, 1.0);
      gl_FragColor = vec4(toSRGB(env * 0.6 * (0.1 + f)), a);
    }
  }`;

const silVert = /* glsl */`
  uniform vec4 st; varying vec2 vUv; varying vec3 vW;
  void main() { vUv = uv * st.xy + st.zw; vW = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const silFrag = /* glsl */`
  uniform sampler2D map; uniform vec4 color; varying vec2 vUv; varying vec3 vW;
  ${common}
  void main() { vec4 t = texture2D(map, vUv); if (t.a < 0.5) discard; gl_FragColor = vec4(toSRGB(night(color.rgb, vW)), 1.0); }`;

const skyVert = /* glsl */`
  varying vec3 vDir;
  void main() { vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position + cameraPosition, 1.0); gl_Position = p.xyww; }`;
const skyFrag = /* glsl */`
  uniform sampler2D sky; varying vec3 vDir;
  ${skyDir}
  void main() { gl_FragColor = vec4(texture2D(sky, equirect(vDir)).rgb, 1.0); }`;

function makeMaterial(m, info) {
  const st = new THREE.Vector4(...m.st);
  const color = new THREE.Vector4(...m.color);
  if (m.shader === 'glass' || m.shader === 'water') {
    const water = m.shader === 'water';
    return new THREE.ShaderMaterial({
      vertexShader: glassVert, fragmentShader: glassFrag, transparent: !water, depthWrite: water, side: THREE.DoubleSide,
      uniforms: { color: { value: color }, sky: { value: info.skyTex }, water: { value: water }, time: shared.time },
    });
  }
  if (m.shader === 'silhouette') {
    return new THREE.ShaderMaterial({ vertexShader: silVert, fragmentShader: silFrag, side: THREE.DoubleSide,
      uniforms: { map: { value: loadTex(m.tex, true) }, color: { value: color }, st: { value: st } } });
  }
  const mode = m.shader === 'unlit' ? 1 : m.shader === 'terrain' ? 3 : m.shader === 'impostor' ? 4 : 0;
  const u = {
    map: { value: m.tex ? loadTex(m.tex, true) : null }, hasMap: { value: !!m.tex },
    color: { value: color }, emission: { value: new THREE.Vector3(...m.emission) },
    lightmap: { value: info.lmTex }, useLm: { value: false }, lmRange: { value: info.lmRange },
    cutoff: { value: m.cutoff || 0 }, st: { value: st }, mode: { value: mode }, tri: { value: m.tri || 0 },
    t0: { value: null }, t1: { value: null }, t2: { value: null }, t3: { value: null },
    tiles: { value: new THREE.Vector4(1, 1, 1, 1) }, tint0: { value: new THREE.Vector3(1, 1, 1) }, tint1: { value: new THREE.Vector3(1, 1, 1) },
    tint2: { value: new THREE.Vector3(1, 1, 1) }, tint3: { value: new THREE.Vector3(1, 1, 1) },
  };
  if (mode === 3) {
    ['t0', 't1', 't2', 't3'].forEach((k, i) => { u[k].value = m.texs[i] ? loadTex(m.texs[i], true) : null; });
    u.tiles.value.set(...m.tiles);
    ['tint0', 'tint1', 'tint2', 'tint3'].forEach((k, i) => u[k].value.set(m.tints[i * 3], m.tints[i * 3 + 1], m.tints[i * 3 + 2]));
  }
  return new THREE.ShaderMaterial({ vertexShader: litVert, fragmentShader: litFrag, side: m.twoSided || mode === 4 ? THREE.DoubleSide : THREE.FrontSide, uniforms: u });
}

// ---------------------------------------------------------------- 組み立て
async function build() {
  const info = await (await fetch(DATA + 'scene.json')).json();
  const buf = await fetchBin(info.bins.map(b => DATA + b), info.binSize);
  loadText.textContent = 'ワールドを組み立てています…';

  info.lmTex = loadTex(info.lightmap, false);
  info.lmTex.wrapS = info.lmTex.wrapT = THREE.ClampToEdgeWrapping;
  info.lmTex.generateMipmaps = false; info.lmTex.minFilter = THREE.LinearFilter;
  info.skyTex = loadTex(info.sky, false);
  info.skyTex.wrapT = THREE.ClampToEdgeWrapping;

  const sky = new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32),
    new THREE.ShaderMaterial({ vertexShader: skyVert, fragmentShader: skyFrag, side: THREE.BackSide, depthWrite: false,
      uniforms: { sky: { value: info.skyTex } } }));
  sky.renderOrder = -10; sky.frustumCulled = false;
  scene.add(sky);

  const mats = info.materials.map(m => makeMaterial(m, info));
  const matsNoLm = new Map();
  for (const me of info.meshes) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, me.pos, me.vc * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(buf, me.uv, me.vc * 2), 2));
    const useLm = me.uv2 >= 0;
    if (useLm) g.setAttribute('uv2x', new THREE.BufferAttribute(new Float32Array(buf, me.uv2, me.vc * 2), 2));
    else g.setAttribute('vcol', new THREE.BufferAttribute(new Float32Array(buf, me.col, me.vc * 3), 3));
    if (me.nrm >= 0) g.setAttribute('nrm', new THREE.BufferAttribute(new Float32Array(buf, me.nrm, me.vc * 3), 3));
    if (me.w >= 0) g.setAttribute('wts', new THREE.BufferAttribute(new Float32Array(buf, me.w, me.vc * 4), 4));
    for (const p of me.parts) {
      const idx = me.u32 ? new Uint32Array(buf, p.off, p.count) : new Uint16Array(buf, p.off, p.count);
      const gp = g.clone();
      gp.setIndex(new THREE.BufferAttribute(idx, 1));
      const src = info.materials[p.mat];
      let mat = mats[p.mat];
      if (mat.uniforms && 'useLm' in mat.uniforms && useLm) {
        if (!matsNoLm.has(p.mat)) { const c = mat.clone(); c.uniforms.useLm.value = true; c.uniforms.lightmap.value = info.lmTex;
          for (const k of ['map', 't0', 't1', 't2', 't3']) c.uniforms[k].value = mat.uniforms[k].value; matsNoLm.set(p.mat, c); }
        mat = matsNoLm.get(p.mat);
      }
      const mesh = new THREE.Mesh(gp, mat);
      if (src.shader === 'glass') mesh.renderOrder = 10;
      gp.computeBoundingSphere();
      scene.add(mesh);
    }
  }
  return info;
}

// ---------------------------------------------------------------- 操作
let yaw = 0, pitch = 0;
let tween = null;
function lookAtFrom(pos, target) {
  const d = new THREE.Vector3().subVectors(target, pos).normalize();
  return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.asin(d.y) };
}
function goTo(v, instant) {
  const pos = new THREE.Vector3(...v.pos), tgt = new THREE.Vector3(...v.target);
  const a = lookAtFrom(pos, tgt);
  if (instant) { camera.position.copy(pos); yaw = a.yaw; pitch = a.pitch; return; }
  let dy = a.yaw - yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  tween = { t: 0, p0: camera.position.clone(), p1: pos, y0: yaw, y1: yaw + dy, x0: pitch, x1: a.pitch };
}

const keys = new Set();
addEventListener('keydown', e => { keys.add(e.key.toLowerCase()); });
addEventListener('keyup', e => { keys.delete(e.key.toLowerCase()); });

const pointers = new Map(); let pinch0 = 0, fov0 = 62;
canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); hideHint(); tween = null;
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); fov0 = camera.fov; } });
canvas.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return;
  const [px, py] = pointers.get(e.pointerId);
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 1) {
    const s = 0.0042 * (camera.fov / 62);
    yaw += (e.clientX - px) * s; pitch += (e.clientY - py) * s;
    pitch = Math.max(-1.45, Math.min(1.45, pitch));
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    camera.fov = Math.max(30, Math.min(85, fov0 * pinch0 / Math.max(d, 1))); camera.updateProjectionMatrix();
  }
});
const endPtr = e => { pointers.delete(e.pointerId); };
canvas.addEventListener('pointerup', endPtr); canvas.addEventListener('pointercancel', endPtr);
canvas.addEventListener('wheel', e => { e.preventDefault(); hideHint(); tween = null;
  const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  camera.position.addScaledVector(f, -Math.sign(e.deltaY) * 0.4); }, { passive: false });

let hintTimer = setTimeout(hideHint, 9000);
function hideHint() { document.getElementById('hint').style.opacity = 0; clearTimeout(hintTimer); }

// ---------------------------------------------------------------- UI
function setupUI(info) {
  const bar = document.getElementById('views');
  info.views.forEach((v, i) => {
    const b = document.createElement('button'); b.textContent = v.label;
    b.onclick = () => { goTo(v); [...bar.children].forEach(x => x.classList.toggle('on', x === b)); };
    bar.appendChild(b);
    if (i === 0) b.classList.add('on');
  });
  const tracks = [['audio_river.mp3', 0.55], ['audio_forest.mp3', 0.35], ['audio_fire.mp3', 0.3]].map(([f, v]) => { const a = new Audio(f); a.loop = true; a.volume = v; return a; });
  const sb = document.getElementById('sound'); let playing = false;
  sb.onclick = () => {
    playing = !playing;
    tracks.forEach(a => playing ? a.play() : a.pause());
    sb.classList.toggle('on', playing);
  };
}

// ---------------------------------------------------------------- ループ
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h;
  camera.fov = w < h ? 75 : 62; camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

const clock = new THREE.Clock();
let lastFrame = 0, started = false;
function loop() { frame(); requestAnimationFrame(loop); }
setInterval(() => { if (performance.now() - lastFrame > 150 && started) frame(); }, 100);
function frame() {
  lastFrame = performance.now();
  const dt = Math.min(clock.getDelta(), 0.12);
  shared.time.value += dt;
  if (tween) {
    tween.t = Math.min(1, tween.t + dt / 1.6);
    const k = tween.t < 0.5 ? 4 * tween.t ** 3 : 1 - (-2 * tween.t + 2) ** 3 / 2;
    camera.position.lerpVectors(tween.p0, tween.p1, k);
    yaw = tween.y0 + (tween.y1 - tween.y0) * k; pitch = tween.x0 + (tween.x1 - tween.x0) * k;
    if (tween.t >= 1) tween = null;
  }
  const sp = 2.2 * dt;
  const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), r = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  if (keys.has('w') || keys.has('arrowup')) { camera.position.addScaledVector(f, sp); tween = null; }
  if (keys.has('s') || keys.has('arrowdown')) { camera.position.addScaledVector(f, -sp); tween = null; }
  if (keys.has('a') || keys.has('arrowleft')) { camera.position.addScaledVector(r, -sp); tween = null; }
  if (keys.has('d') || keys.has('arrowright')) { camera.position.addScaledVector(r, sp); tween = null; }
  if (keys.has('q')) camera.position.y -= sp; if (keys.has('e')) camera.position.y += sp;
  camera.rotation.set(pitch, yaw, 0);
  renderer.render(scene, camera);
}

build().then(info => {
  setupUI(info);
  resize();
  goTo(info.views[0], true);
  started = true;
  loop();
  const l = document.getElementById('loading'); l.style.opacity = 0; setTimeout(() => l.remove(), 900);
}).catch(err => { loadText.textContent = '読み込みに失敗しました。ページを再読み込みしてください。'; console.error(err); });
