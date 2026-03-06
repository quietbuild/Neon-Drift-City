// ╔══════════════════════════════════════════════════════════╗
// ║           NEON DRIFT CITY — game.js                     ║
// ║     Three.js r128 | Cyberpunk Open-World Racer          ║
// ╚══════════════════════════════════════════════════════════╝

'use strict';

// ── CONSTANTS ────────────────────────────────────────────────
const CITY_HALF    = 270;
const ROAD_SPACING = 90;
const ROAD_WIDTH   = 22;
const BLOCK_GAP    = 6;            // gap between road edge and building
const MAX_SPEED    = 80;           // internal units/s  (~200 km/h at display scale)
const ACCEL        = 40;
const BRAKE_FORCE  = 65;
const STEER_SPEED  = 2.4;
const GRIP_NORMAL  = 0.86;         // lateral grip factor (high = grippy)
const GRIP_DRIFT   = 0.55;         // low grip = drifty
const AI_COUNT     = 14;
const CUBE_COUNT   = 28;
const RAIN_COUNT   = 6000;
const COLLECT_DIST = 7.5;
const KMH_SCALE    = 2.5;          // multiply speed units by this for km/h display

const NEON_COLORS = [0xff00ff, 0x00ffff, 0xaa00ff, 0xff0066, 0x0088ff, 0x00ff99, 0xff6600];

// Road positions (same for X and Z axes)
const ROAD_POS = [];
for (let p = -CITY_HALF; p <= CITY_HALF; p += ROAD_SPACING) ROAD_POS.push(p);

// ── STATE ────────────────────────────────────────────────────
let scene, camera, renderer, clock;
let playerCar;
let aiCars        = [];
let energyCubes   = [];
let rainGeo;
let buildingBoxes = [];   // AABB list for collision {cx,cz,hw,hd}
let score         = 0;
let cubesCollected = 0;
let topSpeed      = 0;
let keys          = {};
let touchInput    = { steerX: 0, steerY: 0, drift: false };

// Camera lerp state
const camPos    = new THREE.Vector3(0, 10, -25);
const camLook   = new THREE.Vector3(0, 1, 0);

// ── ENTRY POINT ──────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  simulateLoading().then(initGame);
});

async function simulateLoading() {
  const steps = [
    [15, 'Generating city layout…'],
    [35, 'Placing buildings…'],
    [55, 'Installing neon lighting…'],
    [70, 'Spawning traffic…'],
    [85, 'Initiating weather systems…'],
    [100, 'Engaging hyperdrive…'],
  ];
  const fill   = document.getElementById('loadingFill');
  const pct    = document.getElementById('loadingPercent');
  const status = document.getElementById('loadingStatus');

  for (const [p, msg] of steps) {
    await new Promise(r => setTimeout(r, 230 + Math.random() * 200));
    fill.style.width   = p + '%';
    pct.textContent    = p + '%';
    status.textContent = msg;
  }
  await new Promise(r => setTimeout(r, 300));
}

// ── INIT ─────────────────────────────────────────────────────
function initGame() {
  // Renderer
  const canvas = document.getElementById('gameCanvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
  renderer.toneMapping       = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;

  // Scene
  scene = new THREE.Scene();
  scene.fog       = new THREE.FogExp2(0x080020, 0.007);
  scene.background = new THREE.Color(0x060015);

  // Camera
  camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 900);
  camera.position.set(0, 10, -22);

  // Clock
  clock = new THREE.Clock();

  // World
  buildGround();
  buildCity();
  buildLighting();
  buildRain();
  spawnEnergyCubes();

  // Cars
  playerCar = new PlayerCar(new THREE.Vector3(0, 0, 45));
  scene.add(playerCar.group);

  // Init camera behind player
  const fwd = playerCar.forwardDir;
  camPos.copy(playerCar.pos).addScaledVector(fwd.clone().negate(), 22).add(new THREE.Vector3(0, 9, 0));
  camera.position.copy(camPos);

  for (let i = 0; i < AI_COUNT; i++) {
    const ai = new AICar();
    aiCars.push(ai);
    scene.add(ai.group);
  }

  // Controls
  setupControls();

  // Resize
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Fade out loading
  const loading = document.getElementById('loading');
  loading.style.opacity = '0';
  setTimeout(() => {
    loading.style.display = 'none';
    document.getElementById('hud').style.display = 'block';
  }, 800);

  animate();
}

// ── GROUND / ROADS ───────────────────────────────────────────
function buildGround() {
  // Dark wet asphalt base
  const geo = new THREE.PlaneGeometry(CITY_HALF * 2 + 200, CITY_HALF * 2 + 200);
  const mat = new THREE.MeshStandardMaterial({
    color:     0x050505,
    roughness: 0.06,
    metalness: 0.92,
    envMapIntensity: 1.0,
  });
  const ground = new THREE.Mesh(geo, mat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Subtle road surface texture lines (asphalt seams)
  const seamMat = new THREE.MeshStandardMaterial({
    color: 0x0d0d1a, roughness: 0.9, metalness: 0.0,
  });
  const sz = CITY_HALF * 2 + 100;
  for (let i = -10; i <= 10; i++) {
    const sg = new THREE.PlaneGeometry(sz, 0.5);
    const sm = new THREE.Mesh(sg, seamMat);
    sm.rotation.x = -Math.PI / 2;
    sm.position.set(i * 28, 0.005, 0);
    scene.add(sm);
    const sg2 = new THREE.PlaneGeometry(0.5, sz);
    const sm2 = new THREE.Mesh(sg2, seamMat);
    sm2.rotation.x = -Math.PI / 2;
    sm2.position.set(0, 0.005, i * 28);
    scene.add(sm2);
  }

  // Road lane markings
  buildLaneMarkings();
}

function buildLaneMarkings() {
  const dashMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.5,
  });
  const centerMat = new THREE.MeshStandardMaterial({
    color: 0xffee00, emissive: 0xffee00, emissiveIntensity: 0.6,
  });
  const dashLen = 8, dashGap = 6, step = dashLen + dashGap;

  for (const rp of ROAD_POS) {
    const halfLen = CITY_HALF;
    const count   = Math.floor(halfLen * 2 / step);

    // Center yellow dashes (NS road)
    for (let i = 0; i < count; i++) {
      const t = -halfLen + i * step + dashLen / 2;
      addDash(rp, 0.012, t, 0.4, dashLen, centerMat);     // NS road: long axis = Z
      addDash(t, 0.012, rp, dashLen, 0.4, dashMat);        // EW road: long axis = X
    }

    // Side white strips at road edges
    for (let side of [-1, 1]) {
      const edgeX = rp + side * (ROAD_WIDTH / 2 - 0.5);
      const edgeZ = rp + side * (ROAD_WIDTH / 2 - 0.5);
      const stripMat = new THREE.MeshStandardMaterial({
        color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.3,
      });
      const sg1 = new THREE.PlaneGeometry(0.35, halfLen * 2);
      const sm1 = new THREE.Mesh(sg1, stripMat);
      sm1.rotation.x = -Math.PI / 2;
      sm1.position.set(edgeX, 0.008, 0);
      scene.add(sm1);

      const sg2 = new THREE.PlaneGeometry(halfLen * 2, 0.35);
      const sm2 = new THREE.Mesh(sg2, stripMat);
      sm2.rotation.x = -Math.PI / 2;
      sm2.position.set(0, 0.008, edgeZ);
      scene.add(sm2);
    }
  }
}

function addDash(x, y, z, w, d, mat) {
  const g = new THREE.PlaneGeometry(w, d);
  const m = new THREE.Mesh(g, mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, y, z);
  scene.add(m);
}

// ── CITY ─────────────────────────────────────────────────────
function buildCity() {
  const hw = ROAD_SPACING / 2 - ROAD_WIDTH / 2 - BLOCK_GAP; // max building half-width

  for (let ri = 0; ri < ROAD_POS.length - 1; ri++) {
    for (let ci = 0; ci < ROAD_POS.length - 1; ci++) {
      const cx = (ROAD_POS[ci] + ROAD_POS[ci + 1]) / 2;
      const cz = (ROAD_POS[ri] + ROAD_POS[ri + 1]) / 2;
      placeBlock(cx, cz, hw * 2);
    }
  }

  // Perimeter mega-towers for skyline depth
  for (let i = 0; i < 30; i++) {
    const angle  = (i / 30) * Math.PI * 2;
    const dist   = CITY_HALF + 60 + Math.random() * 80;
    const bx     = Math.cos(angle) * dist;
    const bz     = Math.sin(angle) * dist;
    const bh     = 100 + Math.random() * 200;
    const bw     = 20  + Math.random() * 35;
    addBuilding(bx, bz, bw, bh, bw);
  }
}

function placeBlock(cx, cz, blockSize) {
  const split = Math.random();

  if (split < 0.35) {
    // Single large building
    const w = blockSize * (0.7 + Math.random() * 0.25);
    const h = 30 + Math.random() * 110;
    addBuilding(cx, cz, w, h, w);
  } else if (split < 0.70) {
    // Two buildings side by side (east-west split)
    const pad = 4;
    const hw  = blockSize / 2 - pad / 2;
    addBuilding(cx - hw / 2 - pad / 4, cz, hw, 25 + Math.random() * 100, blockSize * 0.85);
    addBuilding(cx + hw / 2 + pad / 4, cz, hw, 25 + Math.random() * 100, blockSize * 0.85);
  } else {
    // 2×2 courtyard arrangement
    const pad = 5;
    const qw  = blockSize / 2 - pad / 2;
    const qz  = blockSize / 2 - pad / 2;
    const os  = qw / 2 + pad / 4;
    addBuilding(cx - os, cz - os, qw, 20 + Math.random() * 90, qz);
    addBuilding(cx + os, cz - os, qw, 20 + Math.random() * 90, qz);
    addBuilding(cx - os, cz + os, qw, 20 + Math.random() * 90, qz);
    addBuilding(cx + os, cz + os, qw, 20 + Math.random() * 90, qz);
  }
}

function addBuilding(cx, cz, w, h, d) {
  const neon = NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)];

  // Main body
  const geo = new THREE.BoxGeometry(w, h, d);
  const mat = new THREE.MeshStandardMaterial({
    color:             0x0a0a18,
    emissive:          new THREE.Color(neon).multiplyScalar(0.04),
    roughness:         0.75,
    metalness:         0.25,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(cx, h / 2, cz);
  mesh.castShadow   = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  // Store AABB for collision
  buildingBoxes.push({ cx, cz, hw: w / 2, hd: d / 2 });

  // Window glow rows
  addWindowRows(cx, cz, w, d, h, neon);

  // Neon horizontal sign strip
  if (Math.random() > 0.25) {
    const sh   = h * (0.25 + Math.random() * 0.55);
    const sw   = w * 0.85;
    const side = Math.random() > 0.5 ? 1 : -1;
    const neon2 = NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)];

    const sgeo = new THREE.BoxGeometry(sw, 1.6, 0.4);
    const smat = new THREE.MeshStandardMaterial({
      color: neon2, emissive: neon2, emissiveIntensity: 3.5,
    });
    const sign = new THREE.Mesh(sgeo, smat);
    sign.position.set(cx, sh, cz + side * (d / 2 + 0.25));
    scene.add(sign);

    // Point light from sign (only ~40% of buildings get one to save perf)
    if (Math.random() > 0.6) {
      const pl = new THREE.PointLight(neon2, 2.5, 50);
      pl.position.set(cx, sh, cz + side * (d / 2 + 3));
      scene.add(pl);
    }
  }

  // Roof antenna / light
  if (Math.random() > 0.5) {
    const antennaGeo = new THREE.CylinderGeometry(0.1, 0.1, 8, 4);
    const antennaMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
    const antenna    = new THREE.Mesh(antennaGeo, antennaMat);
    antenna.position.set(cx + (Math.random() - 0.5) * w * 0.4, h + 4, cz + (Math.random() - 0.5) * d * 0.4);
    scene.add(antenna);

    // Blinking roof light
    const blinkColor = Math.random() > 0.5 ? 0xff0033 : 0xffaa00;
    const blinkGeo   = new THREE.SphereGeometry(0.3, 6, 6);
    const blinkMat   = new THREE.MeshStandardMaterial({
      color: blinkColor, emissive: blinkColor, emissiveIntensity: 4,
    });
    const blink = new THREE.Mesh(blinkGeo, blinkMat);
    blink.position.set(antenna.position.x, h + 8.5, antenna.position.z);
    blink.userData.blink      = true;
    blink.userData.blinkPhase = Math.random() * Math.PI * 2;
    blink.userData.blinkMat   = blinkMat;
    scene.add(blink);
  }
}

function addWindowRows(cx, cz, w, d, h, neon) {
  const floorH   = 8;
  const floors   = Math.floor(h / floorH);
  const cols     = Math.max(1, Math.floor(w / 7));
  const winColor = Math.random() > 0.4 ? neon : 0xffffcc;
  const winMat   = new THREE.MeshStandardMaterial({
    color:             winColor,
    emissive:          winColor,
    emissiveIntensity: 1.2,
  });

  for (let fl = 0; fl < floors; fl++) {
    if (Math.random() > 0.55) continue;
    const wy = fl * floorH + floorH / 2;
    for (let col = 0; col < cols; col++) {
      if (Math.random() > 0.5) continue;
      const wx = cx - w / 2 + (col + 0.5) * (w / cols);
      const wg = new THREE.PlaneGeometry(2.2, 3.2);
      const wm = new THREE.Mesh(wg, winMat);
      wm.position.set(wx, wy, cz + d / 2 + 0.01);
      scene.add(wm);
    }
  }
}

// ── LIGHTING ─────────────────────────────────────────────────
function buildLighting() {
  // Deep ambient (very dark purple tint)
  scene.add(new THREE.AmbientLight(0x110022, 0.6));

  // Moonlight (cool blue-white directional)
  const moon = new THREE.DirectionalLight(0x223355, 0.5);
  moon.position.set(-60, 120, 80);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  moon.shadow.camera.left   = -250;
  moon.shadow.camera.right  = 250;
  moon.shadow.camera.top    = 250;
  moon.shadow.camera.bottom = -250;
  moon.shadow.camera.far    = 500;
  scene.add(moon);

  // Street lights at every other intersection
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x222233, roughness: 0.8 });
  for (let ri = 0; ri < ROAD_POS.length; ri += 2) {
    for (let ci = 0; ci < ROAD_POS.length; ci += 2) {
      const x  = ROAD_POS[ci];
      const z  = ROAD_POS[ri];
      const ox = ROAD_WIDTH / 2 + 3;
      const oz = ROAD_WIDTH / 2 + 3;

      // Pole
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 10, 6), poleMat);
      pole.position.set(x + ox, 5, z + oz);
      scene.add(pole);

      // Lamp arm
      const arm = new THREE.Mesh(new THREE.BoxGeometry(3, 0.25, 0.25), poleMat);
      arm.position.set(x + ox - 1.5, 10.3, z + oz);
      scene.add(arm);

      // Point light (warm pink / orange street glow)
      const color = Math.random() > 0.5 ? 0xff5588 : 0xffaa44;
      const pl    = new THREE.PointLight(color, 1.8, 55);
      pl.position.set(x + ox - 3, 11, z + oz);
      scene.add(pl);

      // Lamp head (emissive)
      const lampGeo = new THREE.SphereGeometry(0.5, 8, 8);
      const lampMat = new THREE.MeshStandardMaterial({
        color: color, emissive: color, emissiveIntensity: 5,
      });
      const lamp = new THREE.Mesh(lampGeo, lampMat);
      lamp.position.set(x + ox - 3, 11, z + oz);
      scene.add(lamp);
    }
  }

  // Wide atmospheric neon fills at city-level
  const atmoColors = [0x330066, 0x003366, 0x660033];
  for (let i = 0; i < 3; i++) {
    const al = new THREE.PointLight(atmoColors[i], 0.5, 400);
    al.position.set(
      (Math.random() - 0.5) * CITY_HALF,
      60,
      (Math.random() - 0.5) * CITY_HALF
    );
    scene.add(al);
  }
}

// ── RAIN SYSTEM ──────────────────────────────────────────────
function buildRain() {
  const positions  = new Float32Array(RAIN_COUNT * 3);
  const velocities = new Float32Array(RAIN_COUNT);   // individual fall speed

  for (let i = 0; i < RAIN_COUNT; i++) {
    positions[i * 3]     = (Math.random() - 0.5) * 500;
    positions[i * 3 + 1] = Math.random() * 180;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 500;
    velocities[i]         = 35 + Math.random() * 25;
  }

  rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  rainGeo._vel = velocities;

  const rainMat = new THREE.PointsMaterial({
    color:       0x8899ff,
    size:        0.11,
    transparent: true,
    opacity:     0.45,
    depthWrite:  false,
    sizeAttenuation: true,
  });

  scene.add(new THREE.Points(rainGeo, rainMat));
}

function updateRain(dt, camX, camZ) {
  const pos = rainGeo.attributes.position.array;
  const vel = rainGeo._vel;
  for (let i = 0; i < RAIN_COUNT; i++) {
    pos[i * 3 + 1] -= vel[i] * dt;
    pos[i * 3]     -= 4 * dt;    // slight wind

    if (pos[i * 3 + 1] < -1) {
      pos[i * 3]     = camX + (Math.random() - 0.5) * 250;
      pos[i * 3 + 1] = 120 + Math.random() * 60;          // reset high up
      pos[i * 3 + 2] = camZ + (Math.random() - 0.5) * 250;
    }
  }
  rainGeo.attributes.position.needsUpdate = true;
}

// ── ENERGY CUBES ─────────────────────────────────────────────
function spawnEnergyCubes() {
  for (let i = 0; i < CUBE_COUNT; i++) {
    const cube = createEnergyCube();
    energyCubes.push(cube);
    scene.add(cube.mesh);
  }
}

function createEnergyCube(forcePos) {
  const pos  = forcePos || randomRoadPoint();
  const neon = NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)];
  const geo  = new THREE.BoxGeometry(1.6, 1.6, 1.6);
  const mat  = new THREE.MeshStandardMaterial({
    color:             neon,
    emissive:          neon,
    emissiveIntensity: 2.2,
    transparent:       true,
    opacity:           0.88,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(pos.x, 2.5, pos.z);

  // Inner bright cube
  const inner = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.7, 0.7),
    new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 4 })
  );
  mesh.add(inner);

  // Glow point light
  const light = new THREE.PointLight(neon, 2.5, 16);
  mesh.add(light);

  return { mesh, pos: pos.clone().setY(2.5), alive: true, phase: Math.random() * Math.PI * 2 };
}

function randomRoadPoint() {
  const onX    = Math.random() > 0.5;
  const roadRP = ROAD_POS[Math.floor(Math.random() * ROAD_POS.length)];
  const along  = (Math.random() - 0.5) * (CITY_HALF * 1.8);
  return new THREE.Vector3(
    onX ? along  : roadRP,
    0,
    onX ? roadRP : along
  );
}

function updateEnergyCubes(dt) {
  const t = clock.getElapsedTime();
  for (const cube of energyCubes) {
    if (!cube.alive) continue;

    cube.mesh.rotation.y += dt * 1.6;
    cube.mesh.rotation.x += dt * 0.9;
    cube.mesh.position.y  = 2.5 + Math.sin(t * 2 + cube.phase) * 0.6;

    // Collect check
    const dx = playerCar.pos.x - cube.pos.x;
    const dz = playerCar.pos.z - cube.pos.z;
    if (Math.sqrt(dx * dx + dz * dz) < COLLECT_DIST) {
      collectCube(cube);
    }
  }
}

function collectCube(cube) {
  cube.alive = false;
  scene.remove(cube.mesh);

  score         += 100;
  cubesCollected += 1;
  updateScoreUI(true);
  showScorePop('+100', cube.pos);

  // Respawn elsewhere after 6 s
  setTimeout(() => {
    const newPos  = randomRoadPoint();
    cube.pos      = newPos.clone().setY(2.5);
    cube.mesh.position.set(newPos.x, 2.5, newPos.z);
    cube.alive    = true;
    scene.add(cube.mesh);
  }, 6000);
}

// ── PLAYER CAR ───────────────────────────────────────────────
class PlayerCar {
  constructor(startPos) {
    this.pos          = startPos.clone();
    this.yaw          = 0;       // rotation around Y
    this.speed        = 0;       // forward speed (units/s)
    this.lateralSpeed = 0;       // sideways speed (drift)
    this.isDrifting   = false;
    this.wheelRot     = 0;

    this.group = new THREE.Group();
    this._buildMesh();
    this.group.position.copy(this.pos).setY(0.85);
  }

  get forwardDir() {
    return new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }
  get rightDir() {
    return new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  _buildMesh() {
    // Body (low-poly sports car)
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x0d0d22, roughness: 0.15, metalness: 0.95,
      emissive: 0x220044, emissiveIntensity: 0.25,
    });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x001122, roughness: 0.05, metalness: 0.2,
      transparent: true, opacity: 0.75,
    });
    const chromeMat = new THREE.MeshStandardMaterial({
      color: 0x888899, roughness: 0.1, metalness: 1.0,
    });

    // Lower body chassis
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.55, 4.6), bodyMat);
    chassis.position.y = 0.38;
    chassis.castShadow = true;
    this.group.add(chassis);

    // Hood / nose slope (front wedge)
    const hood = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.3, 1.6), bodyMat);
    hood.position.set(0, 0.7, 1.6);
    hood.rotation.x = 0.2;
    this.group.add(hood);

    // Cabin
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.6, 2.2), bodyMat);
    cabin.position.set(0, 1.0, -0.3);
    cabin.castShadow = true;
    this.group.add(cabin);

    // Windscreen
    const wind = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 0.15), glassMat);
    wind.position.set(0, 0.98, 0.82);
    wind.rotation.x = -0.35;
    this.group.add(wind);

    // Rear window
    const rWind = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 0.15), glassMat);
    rWind.position.set(0, 0.97, -1.4);
    rWind.rotation.x = 0.35;
    this.group.add(rWind);

    // Spoiler
    const spoilerBase = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.12, 0.45), chromeMat);
    spoilerBase.position.set(0, 1.28, -2.1);
    this.group.add(spoilerBase);
    [-0.9, 0.9].forEach(x => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.42, 0.12), chromeMat);
      leg.position.set(x, 1.05, -2.1);
      this.group.add(leg);
    });

    // Side skirts
    [-1.1, 1.1].forEach(x => {
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.22, 4.0), bodyMat);
      skirt.position.set(x, 0.22, 0);
      this.group.add(skirt);
    });

    // Headlights (LED strip style)
    const hlMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 4 });
    [-0.75, 0.75].forEach(x => {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.12, 0.1), hlMat);
      hl.position.set(x, 0.5, 2.35);
      this.group.add(hl);
    });

    // Tail lights
    const tlMat = new THREE.MeshStandardMaterial({ color: 0xff0033, emissive: 0xff0033, emissiveIntensity: 3 });
    [-0.72, 0.72].forEach(x => {
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.08), tlMat);
      tl.position.set(x, 0.5, -2.35);
      this.group.add(tl);
    });

    // Neon underglow strip
    const glowMat = new THREE.MeshStandardMaterial({ color: 0xaa00ff, emissive: 0xaa00ff, emissiveIntensity: 5 });
    const glowStrip = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.05, 4.0), glowMat);
    glowStrip.position.y = -0.26;
    this.group.add(glowStrip);

    // Under car point light
    this.underLight = new THREE.PointLight(0xaa00ff, 2.5, 10);
    this.underLight.position.y = -0.3;
    this.group.add(this.underLight);

    // Headlight spot
    this.headSpot = new THREE.SpotLight(0xffffff, 3, 55, Math.PI * 0.09, 0.25);
    this.headSpot.position.set(0, 0.6, 2.2);
    this.headSpot.target.position.set(0, -1, 30);
    this.group.add(this.headSpot);
    this.group.add(this.headSpot.target);

    // Wheels (4)
    this.wheels = [];
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.85 });
    const rimMat   = new THREE.MeshStandardMaterial({ color: 0x778899, metalness: 0.9, roughness: 0.2 });
    const wPositions = [[-1.12, 0, 1.55], [1.12, 0, 1.55], [-1.12, 0, -1.55], [1.12, 0, -1.55]];

    wPositions.forEach(([wx, wy, wz]) => {
      const wGroup = new THREE.Group();
      const tire   = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.38, 14), wheelMat);
      const rim    = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.42, 10), rimMat);
      tire.rotation.z = Math.PI / 2;
      rim.rotation.z  = Math.PI / 2;
      wGroup.add(tire);
      wGroup.add(rim);
      wGroup.position.set(wx, wy, wz);
      this.group.add(wGroup);
      this.wheels.push(wGroup);
    });
  }

  update(dt) {
    const gas   = keys['w'] || keys['W'] || touchInput.steerY < -0.3;
    const brake = keys['s'] || keys['S'] || touchInput.steerY >  0.3;
    const left  = keys['a'] || keys['A'] || touchInput.steerX < -0.2;
    const right = keys['d'] || keys['D'] || touchInput.steerX >  0.2;
    const drift = keys[' '] || touchInput.drift;

    // ── Engine ──
    if (gas) {
      this.speed = Math.min(this.speed + ACCEL * dt, MAX_SPEED);
    } else if (brake) {
      this.speed = Math.max(this.speed - BRAKE_FORCE * dt, -MAX_SPEED * 0.35);
    } else {
      // Coast
      this.speed *= 1 - 1.8 * dt;
      if (Math.abs(this.speed) < 0.05) this.speed = 0;
    }

    // ── Steering ──
    const steerInput  = (right ? 1 : 0) - (left ? 1 : 0);
    const speedFactor = Math.min(Math.abs(this.speed) / MAX_SPEED, 1);

    if (Math.abs(this.speed) > 0.5) {
      this.yaw += steerInput * STEER_SPEED * speedFactor * dt * Math.sign(this.speed);
    }

    // ── Drift physics ──
    this.isDrifting = drift && Math.abs(this.speed) > 14;
    const grip = this.isDrifting ? GRIP_DRIFT : GRIP_NORMAL;

    if (this.isDrifting && Math.abs(steerInput) > 0) {
      // Build lateral velocity
      this.lateralSpeed += steerInput * this.speed * 0.22 * dt;
    }

    // Clamp and decay
    this.lateralSpeed = Math.max(-MAX_SPEED * 0.55, Math.min(MAX_SPEED * 0.55, this.lateralSpeed));
    this.lateralSpeed *= Math.pow(grip, dt * 60);

    // ── Move ──
    const fwd   = this.forwardDir;
    const right2 = this.rightDir;
    const velX  = fwd.x * this.speed + right2.x * this.lateralSpeed;
    const velZ  = fwd.z * this.speed + right2.z * this.lateralSpeed;

    const newX = this.pos.x + velX * dt;
    const newZ = this.pos.z + velZ * dt;

    // City bounds
    this.pos.x = Math.max(-CITY_HALF + 2, Math.min(CITY_HALF - 2, newX));
    this.pos.z = Math.max(-CITY_HALF + 2, Math.min(CITY_HALF - 2, newZ));

    // ── Update mesh ──
    this.group.position.set(this.pos.x, 0.85, this.pos.z);
    this.group.rotation.y = this.yaw;

    // Body roll from lateral force
    const targetRoll = -this.lateralSpeed * 0.009;
    this.group.rotation.z += (targetRoll - this.group.rotation.z) * 0.12;

    // Wheel spin
    this.wheelRot += this.speed * 0.7 * dt;
    this.wheels.forEach(w => { w.rotation.y = this.wheelRot; });

    // Under glow flicker on drift
    if (this.isDrifting) {
      this.underLight.intensity = 2.5 + Math.sin(Date.now() * 0.02) * 1.2;
      this.underLight.color.setHex(0xff00ff);
    } else {
      this.underLight.intensity = 1.8;
      this.underLight.color.setHex(0xaa00ff);
    }

    // Top speed tracking
    const curKmh = Math.abs(this.speed) * KMH_SCALE;
    if (curKmh > topSpeed) {
      topSpeed = curKmh;
      document.getElementById('topSpeed').textContent = Math.round(topSpeed);
    }
  }
}

// ── AI CAR ───────────────────────────────────────────────────
class AICar {
  constructor() {
    const wp     = this._randomWP();
    this.pos     = wp.clone();
    this.yaw     = Math.random() * Math.PI * 2;
    this.speed   = 18 + Math.random() * 22;
    this.target  = this._randomWP();
    this.color   = NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)];
    this.group   = new THREE.Group();
    this._buildMesh();
    this.group.position.set(this.pos.x, 0.85, this.pos.z);
  }

  _randomWP() {
    const rp = ROAD_POS[Math.floor(Math.random() * ROAD_POS.length)];
    const rq = ROAD_POS[Math.floor(Math.random() * ROAD_POS.length)];
    return new THREE.Vector3(rp, 0, rq);
  }

  _buildMesh() {
    const bm = new THREE.MeshStandardMaterial({
      color:             0x0c0c1e,
      roughness:         0.3,
      metalness:         0.75,
      emissive:          new THREE.Color(this.color).multiplyScalar(0.04),
    });
    const cm = new THREE.MeshStandardMaterial({ color: 0x000d1a, roughness: 0.1, metalness: 0.4 });

    const body   = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.6, 4.2), bm);
    body.position.y = 0.35;
    body.castShadow = true;
    this.group.add(body);

    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.55, 2.0), cm);
    cabin.position.set(0, 0.92, -0.15);
    this.group.add(cabin);

    // Headlights
    const hlm = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 3 });
    [-0.65, 0.65].forEach(x => {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 0.08), hlm);
      hl.position.set(x, 0.38, 2.12);
      this.group.add(hl);
    });

    // Tail lights
    const tlm = new THREE.MeshStandardMaterial({ color: 0xff1122, emissive: 0xff1122, emissiveIntensity: 2.5 });
    [-0.65, 0.65].forEach(x => {
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.12, 0.08), tlm);
      tl.position.set(x, 0.38, -2.12);
      this.group.add(tl);
    });

    // Neon under strip
    const nm = new THREE.MeshStandardMaterial({
      color: this.color, emissive: this.color, emissiveIntensity: 4,
    });
    const ns = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.05, 3.8), nm);
    ns.position.y = -0.24;
    this.group.add(ns);

    const ul = new THREE.PointLight(this.color, 1.4, 8);
    ul.position.y = -0.3;
    this.group.add(ul);
  }

  update(dt) {
    const toTarget = new THREE.Vector3().subVectors(this.target, this.pos).setY(0);
    const dist     = toTarget.length();

    if (dist < 6) {
      this.target = this._randomWP();
      return;
    }

    // Steer toward waypoint
    const targetYaw = Math.atan2(toTarget.x, toTarget.z);
    let diff = targetYaw - this.yaw;
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;

    this.yaw += diff * Math.min(3 * dt, 1);

    // Move
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.pos.x += fwd.x * this.speed * dt;
    this.pos.z += fwd.z * this.speed * dt;

    // Bounds
    this.pos.x = Math.max(-CITY_HALF + 2, Math.min(CITY_HALF - 2, this.pos.x));
    this.pos.z = Math.max(-CITY_HALF + 2, Math.min(CITY_HALF - 2, this.pos.z));

    this.group.position.set(this.pos.x, 0.85, this.pos.z);
    this.group.rotation.y = this.yaw;
  }
}

// ── CAMERA ───────────────────────────────────────────────────
function updateCamera(dt) {
  const car = playerCar;
  const fwd = car.forwardDir;

  // Position: behind and above
  const behind    = fwd.clone().negate();
  const driftLean = car.rightDir.clone().multiplyScalar(-car.lateralSpeed * 0.06);
  const desiredPos = car.pos.clone()
    .addScaledVector(behind, 19)
    .add(new THREE.Vector3(0, 8, 0))
    .add(driftLean);

  camPos.lerp(desiredPos, Math.min(6 * dt, 1));
  camera.position.copy(camPos);

  // Look: slightly ahead of car
  const lookPt = car.pos.clone().addScaledVector(fwd, 6).setY(1.2);
  camLook.lerp(lookPt, Math.min(8 * dt, 1));
  camera.lookAt(camLook);
}

// ── CONTROLS ─────────────────────────────────────────────────
function setupControls() {
  window.addEventListener('keydown', e => {
    keys[e.key] = true;
    // Prevent page scroll on arrow / space
    if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', e => { keys[e.key] = false; });

  setupTouchControls();
}

function setupTouchControls() {
  const zone   = document.getElementById('joystick-zone');
  const stick  = document.getElementById('joystick-stick');
  const base   = document.getElementById('joystick-base');
  const driftB = document.getElementById('touch-drift-btn');

  let touchId  = null;
  let baseRect;

  const getBaseCenter = () => {
    baseRect = base.getBoundingClientRect();
    return { x: baseRect.left + baseRect.width / 2, y: baseRect.top + baseRect.height / 2 };
  };

  zone.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.changedTouches[0];
    touchId  = t.identifier;
    const c  = getBaseCenter();
    updateStick(t.clientX - c.x, t.clientY - c.y);
  }, { passive: false });

  zone.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === touchId) {
        const c = getBaseCenter();
        updateStick(t.clientX - c.x, t.clientY - c.y);
      }
    }
  }, { passive: false });

  zone.addEventListener('touchend', e => {
    e.preventDefault();
    touchInput.steerX = 0; touchInput.steerY = 0;
    stick.style.transform = 'translate(-50%,-50%)';
    touchId = null;
  }, { passive: false });

  function updateStick(dx, dy) {
    const maxR = 42;
    const len  = Math.sqrt(dx * dx + dy * dy);
    const nx   = len > maxR ? dx / len * maxR : dx;
    const ny   = len > maxR ? dy / len * maxR : dy;
    stick.style.transform = `translate(calc(-50% + ${nx}px), calc(-50% + ${ny}px))`;
    touchInput.steerX = nx / maxR;   // -1 to 1 (left/right)
    touchInput.steerY = ny / maxR;   // -1 to 1 (up=gas / down=brake)
  }

  driftB.addEventListener('touchstart', e => { e.preventDefault(); touchInput.drift = true;  driftB.classList.add('pressed'); }, { passive: false });
  driftB.addEventListener('touchend',   e => { e.preventDefault(); touchInput.drift = false; driftB.classList.remove('pressed'); }, { passive: false });
}

// ── UI ───────────────────────────────────────────────────────
const arcFill = document.getElementById('arcFill');

function updateHUD() {
  // Speed
  const kmh = Math.abs(playerCar.speed) * KMH_SCALE;
  document.getElementById('speedValue').textContent = Math.round(kmh);

  // Speedometer arc
  const f = Math.min(kmh / 190, 1);
  if (f < 0.01) {
    arcFill.setAttribute('d', '');
  } else {
    const theta = Math.PI * (1 - f);
    const ex    = 60 + 50 * Math.cos(theta);
    const ey    = 65 - 50 * Math.sin(theta);
    arcFill.setAttribute('d', `M 10 65 A 50 50 0 0 0 ${ex.toFixed(1)} ${ey.toFixed(1)}`);
  }

  // Drift bar
  const driftPct  = Math.min(Math.abs(playerCar.lateralSpeed) / (MAX_SPEED * 0.55), 1) * 100;
  const driftBar  = document.getElementById('driftBar');
  const driftLabel = document.getElementById('driftLabel');
  driftBar.style.width = driftPct + '%';
  if (playerCar.isDrifting) {
    driftLabel.textContent = 'DRIFT!';
    driftLabel.classList.add('active');
    document.getElementById('drift-flash').classList.add('active');
  } else {
    driftLabel.textContent = driftPct > 20 ? 'SLIDE' : 'GRIP';
    driftLabel.classList.remove('active');
    document.getElementById('drift-flash').classList.remove('active');
  }
}

function updateScoreUI(pop) {
  const el = document.getElementById('scoreValue');
  el.textContent = score;
  document.getElementById('cubesCollected').textContent = cubesCollected;
  if (pop) {
    el.classList.add('pop');
    setTimeout(() => el.classList.remove('pop'), 150);
  }
}

function showScorePop(text, worldPos) {
  // Project world position to screen
  const v = worldPos.clone().project(camera);
  const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
  const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;

  const el   = document.createElement('div');
  el.className = 'score-pop-label';
  el.textContent = text;
  el.style.left  = sx + 'px';
  el.style.top   = sy + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1000);
}

// ── BLINK UPDATE (building roof lights) ──────────────────────
function updateBlinks() {
  const t = clock.getElapsedTime();
  scene.traverse(obj => {
    if (obj.userData.blink && obj.userData.blinkMat) {
      obj.userData.blinkMat.emissiveIntensity = Math.sin(t * 2.5 + obj.userData.blinkPhase) > 0.5 ? 5 : 0;
    }
  });
}

// ── GAME LOOP ─────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), 0.05);

  playerCar.update(dt);
  aiCars.forEach(ai => ai.update(dt));
  updateEnergyCubes(dt);
  updateRain(dt, camera.position.x, camera.position.z);
  updateCamera(dt);
  updateHUD();

  // Occasional blink update (every ~10 frames)
  if (Math.random() > 0.9) updateBlinks();

  renderer.render(scene, camera);
}
