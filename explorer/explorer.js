// Ghent parcel explorer: HC-G2 in 3D from the City of Norfolk's own GIS. Pick a lot, see the
// assessor's photo and the rule, then watch the ground floor become a coffee shop, bookshop,
// bistro or design studio. Data: data/ghent.json, built by data/scripts/build_explorer.py.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const $ = (id) => document.getElementById(id);
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
const DARK = matchMedia('(prefers-color-scheme: dark)').matches;

// ── The rule, from Table 3.6.11 and the §4.2 definitions (checked 2026-11-14) ──
const RULES = {
  restaurant: {
    use: 'Restaurant',
    def: 'An establishment whose function is the preparation and selling of unpackaged food and beverages to the customer in a ready-to-consume state, where the customer consumes these foods and beverages while seated at tables or counters primarily located within a building.',
    g3: 'P/C',
  },
  retail: {
    use: 'Retail goods establishment',
    def: 'Establishments that sell consumer goods at retail.',
    g3: 'P/C',
  },
  office: {
    use: 'Office',
    def: 'A building primarily consisting of offices used for conducting the affairs of various businesses, professions, services, nonprofit organizations, or government agencies…',
    g3: 'P',
  },
};

const PALETTE = DARK ? {
  bg: 0x1e1b17, ground: 0x25211b, road: 0x16130f, lot: 0x2f2a22, corner: 0x7a5a2c, picked: 0xd4a060,
  building: 0xc9bfac, context: 0x6f675a, line: 0xd4a060, g3: 0x5d7a59, hover: 0x3a3329,
} : {
  bg: 0xe6dcc3, ground: 0xe0d5ba, road: 0xcfc3a6, lot: 0xf0e9da, corner: 0xe6c088, picked: 0xb07c2a,
  building: 0xfcf9f2, context: 0xe9e1d0, line: 0xb07c2a, g3: 0x8fae8b, hover: 0xf7f1e4,
};

// ── Storefront kits ──
const KITS = [
  { id: 'coffee', label: 'Coffee shop', rule: 'restaurant', sign: 'COFFEE', signFont: '700 120px "Cormorant Garamond", Georgia, serif',
    signBg: '#2f4a3a', signInk: '#f3ede0', stripes: ['#2f4a3a', '#efe6d2'], glow: 0xffb35a, glass: 0x3a2716,
    window: { bg: '#f3d6a6', marks: '#7a4a1e', kind: 'counter' }, props: 'cafe', tables: 3, people: 5 },
  { id: 'books', label: 'Bookshop', rule: 'retail', sign: 'BOOKS', signFont: '700 120px "Cormorant Garamond", Georgia, serif',
    signBg: '#6b2430', signInk: '#f3ede0', stripes: ['#6b2430', '#efe6d2'], glow: 0xffc879, glass: 0x2a1c14,
    window: { bg: '#f1d29a', marks: null, kind: 'shelves' }, props: 'books', tables: 0, people: 4 },
  { id: 'bistro', label: 'Bistro', rule: 'restaurant', sign: 'BISTRO', signFont: 'italic 600 120px "Cormorant Garamond", Georgia, serif',
    signBg: '#1f2a44', signInk: '#f0d9a8', stripes: ['#8a2b1f', '#f0e3c8'], glow: 0xff9e4a, glass: 0x2b1609,
    window: { bg: '#e8b67c', marks: '#5a2b10', kind: 'lamps' }, props: 'bistro', tables: 4, people: 6 },
  { id: 'studio', label: 'Design studio', rule: 'office', sign: 'STUDIO', signFont: '500 96px "DM Mono", monospace',
    signBg: '#f3f1ec', signInk: '#1a1714', stripes: null, glow: 0xdfe9ff, glass: 0x1b2026,
    window: { bg: '#e9eef3', marks: '#5b6670', kind: 'desks' }, props: 'studio', tables: 0, people: 3 },
];

// ── State ──
let data;
const parcels = new Map();          // gpin → parcel (+ plate mesh, building meshes)
const streetsByName = new Map();    // name → [[x, y], …][]
let three = null;                   // { renderer, scene, camera, controls } when WebGL runs
let picked = null;
let activeKit = null;               // { id, group, tweens, start }
let flight = null;

// ── Small helpers ──
const titleCase = (s) => (s || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
const fmt = (n) => n == null ? '—' : n.toLocaleString('en-US');
const ease = (k) => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
const clamp01 = (k) => Math.max(0, Math.min(1, k));
const to3 = (x, y, h = 0) => new THREE.Vector3(x, h, -y);

function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function polyCentroid(poly) {
  let x = 0, y = 0;
  for (const p of poly) { x += p[0]; y += p[1]; }
  return [x / poly.length, y / poly.length];
}

function nearestOnLines(pt, lines) {
  let best = null;
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const [ax, ay] = line[i], [bx, by] = line[i + 1];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((pt[0] - ax) * dx + (pt[1] - ay) * dy) / L2));
      const q = [ax + t * dx, ay + t * dy];
      const d = Math.hypot(pt[0] - q[0], pt[1] - q[1]);
      if (!best || d < best.d) best = { d, q };
    }
  }
  return best;
}

function streetViewUrl(sv) {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${sv[0]},${sv[1]}&heading=${sv[2]}`;
}

// ── Boot ──
async function boot() {
  data = await (await fetch('data/ghent.json')).json();
  for (const p of data.parcels) parcels.set(p.gpin, { ...p, buildings: [], meshes: [] });
  for (const b of data.buildings) if (b.parcel && parcels.has(b.parcel)) parcels.get(b.parcel).buildings.push(b);
  for (const s of data.streets) {
    if (!streetsByName.has(s.name)) streetsByName.set(s.name, []);
    streetsByName.get(s.name).push(s.line);
  }
  buildPanel();
  // Street labels and signs are drawn into canvases, so let the web fonts arrive first (briefly).
  await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2500))]).catch(() => {});
  try {
    initThree();
  } catch (err) {
    three = null;
    const note = $('scene-note');
    note.textContent = "The 3D model needs WebGL, which this browser isn't offering. You can still pick a corner from the list.";
    note.hidden = false;
  }
  readHash();
  addEventListener('hashchange', readHash);
}

// ── Panel ──
function buildPanel() {
  const pick = $('corner-pick');
  const corners = [...parcels.values()].filter((p) => p.corner && p.address)
    .sort((a, b) => {
      const sa = a.address.replace(/^\d+\s+/, ''), sb = b.address.replace(/^\d+\s+/, '');
      return sa.localeCompare(sb) || parseInt(a.address, 10) - parseInt(b.address, 10);
    });
  for (const p of corners) {
    const o = document.createElement('option');
    o.value = p.gpin;
    o.textContent = titleCase(p.address);
    pick.append(o);
  }
  pick.addEventListener('change', () => { if (pick.value) select(pick.value); });
  $('back').addEventListener('click', () => deselect());

  const kits = $('kits');
  for (const kit of KITS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = kit.label;
    b.dataset.kit = kit.id;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => applyKit(kit.id));
    kits.append(b);
  }
  const before = document.createElement('button');
  before.type = 'button';
  before.className = 'before';
  before.textContent = 'Before';
  before.addEventListener('click', () => applyKit(null));
  kits.append(before);
}

function fillLot(p) {
  $('intro').hidden = true;
  $('lot').hidden = false;
  const [s0, s1] = p.streets || [];
  $('lot-corner').textContent = p.corner && s1 ? `Corner of ${titleCase(s0)} and ${titleCase(s1)}` : s0 ? `On ${titleCase(s0)}` : 'HC-G2';
  $('lot-address').textContent = p.address ? titleCase(p.address) : `Lot ${p.gpin}`;
  const facts = [
    ['Use today', p.use || '—'],
    ['Assessed as', (p.cls || '—').replace(/^\d+\s+/, '')],
    ['Built', p.built || '—'],
    ['Lot', p.lot_sqft ? `${fmt(p.lot_sqft)} sq ft` : '—'],
  ];
  $('lot-facts').replaceChildren(...facts.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    return [dt, dd];
  }));
  const fig = $('lot-photo'), img = $('lot-photo-img'), card = $('lot-card');
  if (p.photo) {
    fig.classList.remove('none');
    img.src = p.photo;
    img.alt = `${p.address ? titleCase(p.address) : 'This building'}, photographed from the street by the City of Norfolk's assessor.`;
  } else {
    fig.classList.add('none');
    img.removeAttribute('src');
  }
  card.href = p.pid ? `https://air.norfolk.gov/#/property/${p.pid}` : 'https://air.norfolk.gov/';
  card.textContent = p.photo ? 'property card ↗' : 'see the property card ↗';
  const sv = $('lot-sv');
  if (p.sv) { sv.href = streetViewUrl(p.sv); sv.parentElement.hidden = false; } else sv.parentElement.hidden = true;
  const hasBuilding = p.buildings.length > 0;
  $('no-building').hidden = hasBuilding;
  $('kits').hidden = !hasBuilding;
  $('rule').hidden = true;
  setPressed(null);
  $('panel').scrollTop = 0;
}

function fillRule(kit) {
  if (!kit) { $('rule').hidden = true; return; }
  const r = RULES[kit.rule];
  $('rule-use').textContent = `${kit.label} → ${r.use}`;
  $('rule-def').textContent = `“${r.def}”`;
  const g2 = $('rule-g2'), g3 = $('rule-g3');
  g2.textContent = 'blank: prohibited'; g2.className = 'no';
  g3.textContent = `${r.g3}: allowed`; g3.className = 'yes';
  $('rule').hidden = false;
}

function setPressed(id) {
  for (const b of $('kits').querySelectorAll('button[data-kit]')) b.setAttribute('aria-pressed', String(b.dataset.kit === id));
}

// ── Selection ──
function select(gpin, kitId = null, { fly = true } = {}) {
  const p = parcels.get(gpin);
  if (!p) return;
  if (picked && picked !== p) unhighlight(picked);
  applyKit(null, { silent: true });
  picked = p;
  $('corner-pick').value = p.corner ? gpin : '';
  fillLot(p);
  if (three) {
    highlight(p);
    p.front = frontage(p);
    if (fly) flyTo(p);
  }
  if (kitId) applyKit(kitId);
  else writeHash();
}

function deselect() {
  applyKit(null, { silent: true });
  if (picked) unhighlight(picked);
  picked = null;
  $('intro').hidden = false;
  $('lot').hidden = true;
  $('corner-pick').value = '';
  if (three) flyHome();
  writeHash();
}

function writeHash() {
  const h = picked ? `#p=${picked.gpin}${activeKit ? `&t=${activeKit.id}` : ''}` : ' ';
  if (location.hash !== h.trim()) history.replaceState(null, '', h.trim() || location.pathname + location.search);
}

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  const g = q.get('p');
  if (g && parcels.has(g)) {
    if (!picked || picked.gpin !== g) select(g, q.get('t'), { fly: true });
    else if ((activeKit && activeKit.id) !== q.get('t')) applyKit(q.get('t'));
  }
}

// ── 3D ──
function initThree() {
  const host = $('scene');
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.bg);
  scene.fog = new THREE.Fog(PALETTE.bg, 900, 2200);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 5000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = 1.42;
  controls.minDistance = 12;
  controls.maxDistance = 1800;
  controls.screenSpacePanning = false;

  scene.add(new THREE.HemisphereLight(DARK ? 0x8a8070 : 0xfff6e6, DARK ? 0x1a1610 : 0xb8a888, DARK ? 0.9 : 1.6));
  const sun = new THREE.DirectionalLight(DARK ? 0xb0a8c0 : 0xfff1d6, DARK ? 0.9 : 2.2);
  sun.position.set(-260, 420, 300);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -520, right: 520, top: 520, bottom: -520, near: 50, far: 1500 });
  sun.shadow.bias = -0.0006;
  scene.add(sun);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshLambertMaterial({ color: PALETTE.ground }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  scene.add(ground);

  three = { renderer, scene, camera, controls, host, sun, pickables: [] };
  buildRoads();
  buildLots();
  buildBuildings();
  buildLabels();
  flyHome(true);

  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(host);
  resize();
  wirePicking();
  renderer.setAnimationLoop(tick);
}

function ribbon(line, width, y) {
  const pos = [];
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i], [bx, by] = line[i + 1];
    const L = Math.hypot(bx - ax, by - ay) || 1;
    const nx = -(by - ay) / L * width / 2, ny = (bx - ax) / L * width / 2;
    const a1 = to3(ax + nx, ay + ny, y), a2 = to3(ax - nx, ay - ny, y);
    const b1 = to3(bx + nx, by + ny, y), b2 = to3(bx - nx, by - ny, y);
    pos.push(a1.x, a1.y, a1.z, b1.x, b1.y, b1.z, a2.x, a2.y, a2.z, a2.x, a2.y, a2.z, b1.x, b1.y, b1.z, b2.x, b2.y, b2.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function buildRoads() {
  // Drawn widths only: the city's layer classes streets (residential, arterial/collector) but gives no width.
  const geos = data.streets.map((s) => ribbon(s.line, /arterial|collector/i.test(s.kind || '') ? 13 : 9, 0.01));
  const roads = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshLambertMaterial({ color: PALETTE.road, side: THREE.DoubleSide }));
  roads.receiveShadow = true;
  three.scene.add(roads);
}

function shapeOf(poly) {
  const s = new THREE.Shape();
  poly.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  return s;
}

function flatMesh(poly, color, y) {
  const g = new THREE.ShapeGeometry(shapeOf(poly));
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color }));
  m.position.y = y;
  m.receiveShadow = true;
  return m;
}

function buildLots() {
  const edges = [];
  for (const p of parcels.values()) {
    const plate = flatMesh(p.poly, p.corner ? PALETTE.corner : PALETTE.lot, 0.06);
    plate.userData.gpin = p.gpin;
    p.plate = plate;
    three.scene.add(plate);
    three.pickables.push(plate);
    const pts = [...p.poly, p.poly[0]].map(([x, y]) => to3(x, y, 0.08));
    for (let i = 0; i < pts.length - 1; i++) edges.push(pts[i], pts[i + 1]);
  }
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(edges),
    new THREE.LineBasicMaterial({ color: DARK ? 0x4a4236 : 0xcdbf9f }));
  three.scene.add(lines);
  for (const ring of data.district) {
    three.scene.add(new THREE.Mesh(ribbon([...ring, ring[0]], 1.6, 0.12), new THREE.MeshBasicMaterial({ color: PALETTE.line, side: THREE.DoubleSide })));
  }
  for (const ring of data.g3) {
    three.scene.add(flatMesh(ring, PALETTE.g3, 0.05));
    three.scene.add(new THREE.Mesh(ribbon([...ring, ring[0]], 1.2, 0.13), new THREE.MeshBasicMaterial({ color: PALETTE.g3, side: THREE.DoubleSide })));
  }
}

const MAT = {};
function buildBuildings() {
  MAT.building = new THREE.MeshLambertMaterial({ color: PALETTE.building });
  MAT.picked = new THREE.MeshLambertMaterial({ color: DARK ? 0xe8c890 : 0xf6dcae });
  MAT.context = new THREE.MeshLambertMaterial({ color: PALETTE.context });
  const context = [];
  for (const b of data.buildings) {
    if (b.poly.length < 3) continue;
    const g = new THREE.ExtrudeGeometry(shapeOf(b.poly), { depth: b.h, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    const p = b.parcel && parcels.get(b.parcel);
    if (p) {
      const m = new THREE.Mesh(g, MAT.building);
      m.castShadow = m.receiveShadow = true;
      m.userData.gpin = p.gpin;
      p.meshes.push(m);
      three.scene.add(m);
      three.pickables.push(m);
    } else {
      context.push(g);
    }
  }
  if (context.length) {
    const m = new THREE.Mesh(mergeGeometries(context), MAT.context);
    m.castShadow = m.receiveShadow = true;
    three.scene.add(m);
  }
}

function textTexture(text, font, ink, bg, w = 1024, h = 256) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
  g.fillStyle = ink;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 6);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function buildLabels() {
  for (const [name, lines] of streetsByName) {
    let best = null;
    for (const line of lines) {
      for (let i = 0; i < line.length - 1; i++) {
        const L = Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
        if (!best || L > best.L) best = { L, a: line[i], b: line[i + 1] };
      }
    }
    if (!best || best.L < 70) continue;
    const w = Math.min(best.L * 0.7, 70), h = w / 8;
    const tex = textTexture(titleCase(name), '500 92px "DM Mono", monospace', DARK ? '#cbbfa6' : '#7c6c4f', null);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    let ang = Math.atan2(best.b[1] - best.a[1], best.b[0] - best.a[0]);
    if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
    mesh.rotation.set(-Math.PI / 2, 0, ang);
    const mx = (best.a[0] + best.b[0]) / 2, my = (best.a[1] + best.b[1]) / 2;
    mesh.position.copy(to3(mx, my, 0.2));
    mesh.renderOrder = 2;
    three.scene.add(mesh);
  }
}

function highlight(p) {
  p.plate.material.color.setHex(PALETTE.picked);
  for (const m of p.meshes) m.material = MAT.picked;
}

function unhighlight(p) {
  p.plate.material.color.setHex(p.corner ? PALETTE.corner : PALETTE.lot);
  for (const m of p.meshes) m.material = MAT.building;
}

function wirePicking() {
  const { renderer, camera } = three;
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let down = null, hover = null;
  const hit = (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const h = ray.intersectObjects(three.pickables, false)[0];
    return h ? parcels.get(h.object.userData.gpin) : null;
  };
  renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;
    const p = hit(e);
    if (p) select(p.gpin);
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || e.buttons) return;
    const p = hit(e);
    if (p === hover) return;
    if (hover && hover !== picked) hover.plate.material.color.setHex(hover.corner ? PALETTE.corner : PALETTE.lot);
    hover = p;
    if (p && p !== picked) p.plate.material.color.setHex(p.corner ? PALETTE.picked : PALETTE.hover);
    renderer.domElement.style.cursor = p ? 'pointer' : '';
  });
}

// The facade a storefront goes on: on the lot's largest building, the footprint edges that face
// its nearest named street; of those within 2.5 m of the front-most, the longest. (Length alone
// would pick a long wall set back in a courtyard.)
function frontage(p) {
  if (!p.buildings.length) return null;
  const b = p.buildings.reduce((a, c) => Math.abs(polyArea(c.poly)) > Math.abs(polyArea(a.poly)) ? c : a);
  const lines = p.streets?.length ? streetsByName.get(p.streets[0]) || [] : data.streets.map((s) => s.line);
  const cw = polyArea(b.poly) < 0;
  const edges = [];
  for (let i = 0; i < b.poly.length; i++) {
    const a = b.poly[i], c = b.poly[(i + 1) % b.poly.length];
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (len < 3) continue;
    const dir = [(c[0] - a[0]) / len, (c[1] - a[1]) / len];
    const mid = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
    // Outward normal from the ring's winding: right of travel for a counter-clockwise ring.
    const n = cw ? [-dir[1], dir[0]] : [dir[1], -dir[0]];
    const near = nearestOnLines(mid, lines);
    if (!near) continue;
    const toward = ((near.q[0] - mid[0]) * n[0] + (near.q[1] - mid[1]) * n[1]) / (near.d || 1);
    if (toward < 0.5) continue;  // must face the street, within about 60°
    edges.push({ mid, dir, n, len, h: b.h, street: near.d });
  }
  if (!edges.length) return null;
  const front = Math.min(...edges.map((e) => e.street));
  return edges.filter((e) => e.street <= front + 2.5).reduce((a, c) => (c.len > a.len ? c : a));
}

// ── Camera ──
function flyHome(instant = false) {
  const to = { pos: new THREE.Vector3(240, 560, 640), target: new THREE.Vector3(0, 0, 40) };
  fly(to, instant);
}

function flyTo(p) {
  const f = p.front;
  let target, pos;
  if (f) {
    const mid = to3(f.mid[0], f.mid[1], 0);
    const n = new THREE.Vector3(f.n[0], 0, -f.n[1]);
    const u = new THREE.Vector3(f.dir[0], 0, -f.dir[1]);
    // Stand in the street, a little to one side, at about second-floor height.
    target = mid.clone().add(new THREE.Vector3(0, 3.2, 0)).addScaledVector(n, 2.2);
    const back = Math.max(19, Math.min(36, f.street + 10));
    pos = mid.clone().addScaledVector(n, back).addScaledVector(u, 8).add(new THREE.Vector3(0, 7.5, 0));
  } else {
    const [cx, cy] = polyCentroid(p.poly);
    target = to3(cx, cy, 0);
    pos = target.clone().add(new THREE.Vector3(30, 45, 45));
  }
  fly({ pos, target });
}

function fly(to, instant = false) {
  const { camera, controls } = three;
  if (instant || REDUCE) {
    camera.position.copy(to.pos);
    controls.target.copy(to.target);
    controls.update();
    flight = null;
    return;
  }
  flight = { from: { pos: camera.position.clone(), target: controls.target.clone() }, to, start: performance.now(), dur: 1300 };
}

// ── Kits ──
function std(color, extra = {}) { return new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, ...extra }); }

function stripesTexture([a, b]) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 32;
  const g = c.getContext('2d');
  for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? b : a; g.fillRect(i * 32, 0, 32, 32); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function lamp(g, x, y) {
  g.strokeStyle = 'rgba(40,25,10,0.7)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(x, 0); g.lineTo(x, y - 12); g.stroke();
  const glow = g.createRadialGradient(x, y, 2, x, y, 34);
  glow.addColorStop(0, 'rgba(255,248,220,1)'); glow.addColorStop(1, 'rgba(255,220,150,0)');
  g.fillStyle = glow; g.beginPath(); g.arc(x, y, 34, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff6dc'; g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill();
}

function windowTexture(w) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = w.bg; g.fillRect(0, 0, 512, 256);
  if (w.kind === 'shelves') {
    const colors = ['#7a2430', '#2f4a3a', '#d9b46a', '#3d4f7a', '#a8643a', '#efe6d2', '#5b3a5e'];
    for (let row = 0; row < 4; row++) {
      let x = 6;
      while (x < 506) {
        const bw = 6 + Math.random() * 10;
        g.fillStyle = colors[Math.floor(Math.random() * colors.length)];
        g.fillRect(x, 18 + row * 58, bw, 40 + Math.random() * 10);
        x += bw + 1;
      }
      g.fillStyle = '#5a3a1e'; g.fillRect(0, 60 + row * 58, 512, 6);
    }
  } else if (w.kind === 'counter') {
    // A coffee bar: pendant lamps, a menu board, the machine on the counter.
    g.fillStyle = '#3a2a1c'; g.fillRect(180, 22, 152, 70);
    g.fillStyle = '#efe6d2'; for (let i = 0; i < 4; i++) g.fillRect(196, 36 + i * 13, 70 + (i % 2) * 40, 4);
    lamp(g, 100, 40); lamp(g, 412, 40);
    g.fillStyle = '#6b4526'; g.fillRect(0, 186, 512, 70);
    g.fillStyle = '#b9b2a6'; g.fillRect(300, 150, 70, 38);
    g.fillStyle = '#e8e2d6'; for (let i = 0; i < 5; i++) g.fillRect(60 + i * 26, 172, 14, 14);
  } else if (w.kind === 'lamps') {
    // A bistro: low pendant light over tables, bottles along the back.
    g.fillStyle = '#7a3c18';
    for (let i = 0; i < 18; i++) g.fillRect(40 + i * 24, 92 + (i % 3) * 2, 9, 30);
    g.fillStyle = '#5a2b10'; g.fillRect(0, 124, 512, 8);
    for (let i = 0; i < 5; i++) lamp(g, 50 + i * 103, 52);
    g.fillStyle = '#4a2410';
    for (let i = 0; i < 4; i++) { g.fillRect(40 + i * 125, 200, 70, 8); g.fillRect(71 + i * 125, 208, 8, 48); }
  } else if (w.kind === 'desks') {
    // A studio: drawings pinned up, long desks with screens.
    g.strokeStyle = '#9aa4ad'; g.lineWidth = 2;
    for (let i = 0; i < 4; i++) {
      g.fillStyle = '#ffffff'; g.fillRect(28 + i * 122, 26, 96, 70); g.strokeRect(28 + i * 122, 26, 96, 70);
      g.beginPath(); g.moveTo(40 + i * 122, 80); g.lineTo(70 + i * 122, 46); g.lineTo(110 + i * 122, 70); g.stroke();
    }
    g.fillStyle = '#5b6670';
    for (let i = 0; i < 2; i++) {
      g.fillRect(30 + i * 250, 178, 200, 8);
      g.fillRect(40 + i * 250, 186, 6, 70); g.fillRect(214 + i * 250, 186, 6, 70);
      g.fillStyle = '#2a3036'; g.fillRect(70 + i * 250, 134, 52, 38); g.fillRect(140 + i * 250, 134, 52, 38); g.fillStyle = '#5b6670';
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function person(color, seated = false) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.25, seated ? 0.75 : 1.15, 8), std(color));
  body.position.y = seated ? 0.85 : 0.6;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), std(0xd9b38c));
  head.position.y = seated ? 1.38 : 1.36;
  g.add(body, head);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

function table(top = 0xf2ece0) {
  const g = new THREE.Group();
  const t = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.04, 16), std(top));
  t.position.y = 0.74;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.72, 6), std(0x2a2622));
  stem.position.y = 0.37;
  g.add(t, stem);
  for (const s of [-1, 1]) {
    const chair = new THREE.Group();
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.4), std(0x2a2622));
    seat.position.y = 0.45;
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.42, 0.04), std(0x2a2622));
    back.position.set(0, 0.68, 0.2 * s);
    chair.add(seat, back);
    chair.position.z = 0.62 * s;
    g.add(chair);
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

function planter() {
  const g = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 0.6), std(0x6b5a46));
  box.position.y = 0.25;
  const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45, 0), std(0x55704a));
  leaves.position.y = 0.85;
  g.add(box, leaves);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

function aFrame(text) {
  const g = new THREE.Group();
  const tex = textTexture(text, '600 70px "Cormorant Garamond", Georgia, serif', '#f3ede0', '#2b2b2b', 256, 256);
  for (const s of [-1, 1]) {
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.85, 0.03), [std(0x2b2b2b), std(0x2b2b2b), std(0x2b2b2b), std(0x2b2b2b), std(0xffffff, { map: tex }), std(0xffffff, { map: tex })]);
    board.position.set(0, 0.42, 0.13 * s);
    board.rotation.x = 0.2 * s;
    g.add(board);
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

function bookCart() {
  const g = new THREE.Group();
  const cart = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.7, 0.6), std(0x5a3a1e));
  cart.position.y = 0.55;
  g.add(cart);
  const colors = [0x7a2430, 0x2f4a3a, 0xd9b46a, 0x3d4f7a, 0xa8643a, 0xefe6d2];
  for (let i = 0; i < 12; i++) {
    const book = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.26, 0.2), std(colors[i % colors.length]));
    book.position.set(-0.6 + i * 0.11, 1.03, 0);
    g.add(book);
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

function bench() {
  const g = new THREE.Group();
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 0.45), std(0x7a5a3a));
  seat.position.y = 0.45;
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.4, 0.05), std(0x7a5a3a));
  back.position.set(0, 0.72, -0.2);
  g.add(seat, back);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

function bike() {
  const g = new THREE.Group();
  const wheelGeo = new THREE.TorusGeometry(0.33, 0.03, 6, 20);
  for (const x of [-0.5, 0.5]) {
    const w = new THREE.Mesh(wheelGeo, std(0x222222));
    w.position.set(x, 0.34, 0);
    g.add(w);
  }
  const frame = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.05, 0.05), std(0x2f6b8a));
  frame.position.y = 0.62;
  g.add(frame);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

function stringLights(W, color) {
  const g = new THREE.Group();
  const bulb = new THREE.SphereGeometry(0.07, 8, 6);
  const mat = new THREE.MeshStandardMaterial({ color: 0xfff1c9, emissive: color, emissiveIntensity: 2.2 });
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6), std(0x2a2622));
    post.position.set(sx * W / 2, 1.6, 4.6);
    post.castShadow = true;
    g.add(post);
  }
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const k = i / 24;
    const x = -W / 2 + k * W;
    const y = 3.15 - Math.sin(k * Math.PI) * 0.45;
    pts.push(new THREE.Vector3(x, y, 4.6));
  }
  for (let i = 0; i <= 10; i++) {
    const k = i / 10;
    pts.push(new THREE.Vector3(-W / 2 + k * W, 3.1 - Math.sin(k * Math.PI) * 0.3, 2.4));
  }
  for (const p of pts) {
    const m = new THREE.Mesh(bulb, mat);
    m.position.copy(p);
    g.add(m);
  }
  g.userData.bulbs = mat;
  return g;
}

function buildKit(kit, f) {
  const group = new THREE.Group();
  const W = Math.max(3, Math.min(f.len - 1, 11));
  const u = new THREE.Vector3(f.dir[0], 0, -f.dir[1]);
  const n = new THREE.Vector3(f.n[0], 0, -f.n[1]);
  const up = new THREE.Vector3(0, 1, 0);
  if (new THREE.Vector3().crossVectors(u, up).dot(n) < 0) u.negate();
  group.matrixAutoUpdate = true;
  group.position.copy(to3(f.mid[0], f.mid[1], 0));
  group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, up, n));

  const tweens = [];
  const at = (t0, t1, fn) => tweens.push({ t0, t1, fn });

  // Glass and its frame.
  const glassMat = std(kit.glass, { emissive: 0xffffff, emissiveIntensity: 0, emissiveMap: windowTexture(kit.window), roughness: 0.25 });
  const glass = new THREE.Mesh(new THREE.BoxGeometry(W, 2.8, 0.1), glassMat);
  glass.position.set(0, 1.5, 0.12);
  glass.scale.y = 0.001;
  group.add(glass);
  const frameMat = std(0x1d1a17);
  const frame = new THREE.Group();
  for (const x of [-W / 2, -W / 6, W / 6, W / 2]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.9, 0.16), frameMat);
    bar.position.set(x, 1.5, 0.14);
    frame.add(bar);
  }
  const head = new THREE.Mesh(new THREE.BoxGeometry(W + 0.12, 0.14, 0.18), frameMat);
  head.position.set(0, 2.95, 0.14);
  frame.add(head);
  frame.visible = false;
  group.add(frame);
  at(0, 0.28, (k) => { glass.scale.y = Math.max(0.001, ease(k)); glass.position.y = 0.1 + 1.4 * ease(k); frame.visible = k > 0.05; });
  at(0.15, 0.5, (k) => { glassMat.emissiveIntensity = 0.82 * ease(k); });

  // Awning (or a flat canopy for the studio).
  const pivot = new THREE.Group();
  pivot.position.set(0, 3.12, 0.16);
  const awnMat = kit.stripes ? std(0xffffff, { map: stripesTexture(kit.stripes), side: THREE.DoubleSide })
    : std(0x2a2d31, { metalness: 0.4, roughness: 0.5 });
  const awning = new THREE.Mesh(new THREE.BoxGeometry(W * 0.96, 0.05, kit.stripes ? 1.8 : 1.1), awnMat);
  awning.position.z = kit.stripes ? 0.9 : 0.55;
  awning.castShadow = true;
  pivot.add(awning);
  pivot.rotation.x = -Math.PI / 2;
  pivot.visible = false;
  group.add(pivot);
  const awnEnd = kit.stripes ? 0.34 : 0.04;
  at(0.22, 0.52, (k) => { pivot.visible = k > 0; pivot.rotation.x = -Math.PI / 2 + (Math.PI / 2 + awnEnd) * ease(k); });

  // Sign.
  const signW = Math.min(W * 0.62, 4.2);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(signW, signW / 4), new THREE.MeshStandardMaterial({
    map: textTexture(kit.sign, kit.signFont, kit.signInk, kit.signBg), emissive: 0xffffff, emissiveIntensity: 0.15,
    emissiveMap: null, roughness: 0.6,
  }));
  sign.position.set(0, 3.25 + signW / 8 + (kit.stripes ? 0.35 : 0.2), 0.2);
  sign.scale.setScalar(0.001);
  group.add(sign);
  at(0.42, 0.6, (k) => { const s = Math.max(0.001, k < 0.7 ? ease(k / 0.7) * 1.08 : 1.08 - 0.08 * ((k - 0.7) / 0.3)); sign.scale.setScalar(s); });

  // Warm light spilling out.
  const lamp = new THREE.PointLight(kit.glow, 0, 16, 1.6);
  lamp.position.set(0, 2.3, 1.6);
  group.add(lamp);
  at(0.2, 0.6, (k) => { lamp.intensity = (DARK ? 45 : 22) * ease(k); });

  // On the sidewalk.
  const props = [];
  const place = (obj, x, z, rotY = 0) => { obj.position.set(x, 0, z); obj.rotation.y = rotY; obj.scale.setScalar(0.001); group.add(obj); props.push(obj); };
  const span = W - 1.2;
  if (kit.tables) for (let i = 0; i < kit.tables; i++) place(table(kit.id === 'bistro' ? 0xf4ead6 : 0xf2ece0), -span / 2 + (span * (i + 0.5)) / kit.tables, 2.6 + (i % 2) * 0.6, Math.PI / 2);
  if (kit.props === 'cafe') { place(aFrame('espresso'), W / 2 + 0.6, 1.4, -0.4); place(planter(), -W / 2 - 0.5, 0.8); place(planter(), W / 2 + 0.5, 0.8); }
  if (kit.props === 'books') { place(bookCart(), -W / 4, 1.9, 0); place(bench(), W / 4, 2.2, Math.PI); place(planter(), -W / 2 - 0.5, 0.8); place(aFrame('used & new'), W / 2 + 0.6, 1.4, -0.4); }
  if (kit.props === 'bistro') { place(planter(), -W / 2 - 0.5, 0.8); place(planter(), W / 2 + 0.5, 0.8); place(aFrame('tonight'), W / 2 + 0.7, 1.6, -0.4); }
  if (kit.props === 'studio') { place(bike(), -W / 3, 2.2, 0.1); place(bike(), -W / 3 + 0.8, 2.3, 0.1); place(bench(), W / 4, 2.0, Math.PI); place(planter(), W / 2 + 0.5, 0.8); }
  props.forEach((obj, i) => at(0.48 + i * 0.035, 0.66 + i * 0.035, (k) => obj.scale.setScalar(Math.max(0.001, ease(k)))));

  if (kit.props === 'bistro') {
    const lights = stringLights(W, kit.glow);
    lights.visible = false;
    group.add(lights);
    at(0.55, 0.8, (k) => { lights.visible = k > 0; lights.userData.bulbs.emissiveIntensity = 2.2 * ease(k); });
  }

  // People arriving from along the street.
  const colors = [0x8a2b1f, 0x2f4a3a, 0x3d4f7a, 0xd9b46a, 0x5b3a5e, 0x6b5a46];
  for (let i = 0; i < kit.people; i++) {
    const seated = kit.tables && i < kit.tables;
    const p = person(colors[i % colors.length], seated);
    const side = i % 2 ? 1 : -1;
    const from = new THREE.Vector3(side * (W / 2 + 9 + i * 1.5), 0, 4.9 + (i % 3) * 0.3);
    // Seated people take the chair on the table's west side (tables are turned a quarter, so
    // their chairs sit 0.62 m either side along the facade) and face it; others mill about.
    let to, face;
    if (seated) {
      to = new THREE.Vector3(-span / 2 + (span * (i + 0.5)) / kit.tables - 0.62, 0, 2.6 + (i % 2) * 0.6);
      face = Math.PI / 2;
    } else {
      to = new THREE.Vector3((Math.random() - 0.5) * (W - 1), 0, 1.3 + Math.random() * 2.4);
      face = Math.PI + (Math.random() - 0.5) * 0.8;
    }
    p.position.copy(from);
    p.visible = false;
    group.add(p);
    const t0 = 0.5 + i * 0.05, t1 = Math.min(1, t0 + 0.38);
    at(t0, t1, (k) => {
      p.visible = k > 0;
      p.position.lerpVectors(from, to, ease(k));
      p.position.y = k < 1 ? Math.abs(Math.sin(k * 18)) * 0.06 : 0;
      const d = new THREE.Vector3().subVectors(to, from);
      p.rotation.y = k < 1 ? Math.atan2(d.x, d.z) : face;
    });
  }
  return { group, tweens };
}

function applyKit(id, { silent = false } = {}) {
  if (activeKit && three) three.scene.remove(activeKit.group);
  activeKit = null;
  const kit = KITS.find((k) => k.id === id) || null;
  if (!silent) { setPressed(kit ? kit.id : null); fillRule(kit); }
  if (!kit || !picked) { if (!silent) writeHash(); return; }
  if (three && picked.front) {
    const built = buildKit(kit, picked.front);
    three.scene.add(built.group);
    activeKit = { id: kit.id, ...built, start: performance.now(), dur: 3400 };
    if (REDUCE) for (const t of built.tweens) t.fn(1);
    if (!flight) flyTo(picked);
  } else {
    activeKit = { id: kit.id, group: new THREE.Group(), tweens: [], start: 0, dur: 0 };
  }
  writeHash();
}

// ── Frame ──
function tick(now) {
  const { renderer, scene, camera, controls } = three;
  if (flight) {
    const k = clamp01((now - flight.start) / flight.dur), e = ease(k);
    camera.position.lerpVectors(flight.from.pos, flight.to.pos, e);
    controls.target.lerpVectors(flight.from.target, flight.to.target, e);
    if (k >= 1) flight = null;
  }
  if (activeKit && activeKit.tweens.length && !REDUCE) {
    const k = clamp01((now - activeKit.start) / activeKit.dur);
    for (const t of activeKit.tweens) t.fn(clamp01((k - t.t0) / (t.t1 - t.t0)));
  }
  controls.update();
  renderer.render(scene, camera);
}

boot().catch((err) => {
  const note = $('scene-note');
  note.textContent = `The explorer couldn't load its data (${err.message}).`;
  note.hidden = false;
});
