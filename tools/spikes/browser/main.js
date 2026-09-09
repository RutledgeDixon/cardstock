/**
 * Spike B (browser half) — two claims under test:
 *   1. A BVH raycast hit resolves back to the originating OCCT face.
 *   2. Roll-free turntable navigation on the arrow keys actually feels usable.
 */
import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import mesh from '../out-mesh.json';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);

// ---------------------------------------------------------------- geometry
const geom = new THREE.BufferGeometry();
geom.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3));
geom.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.normals, 3));
geom.setIndex(mesh.indices);

// Per-vertex face id -> lets a hover recolour exactly one topological face.
const vertexFaceId = new Float32Array(mesh.positions.length / 3);
for (let t = 0; t < mesh.triangleFaceId.length; t++) {
  const f = mesh.triangleFaceId[t];
  vertexFaceId[mesh.indices[t * 3]] = f;
  vertexFaceId[mesh.indices[t * 3 + 1]] = f;
  vertexFaceId[mesh.indices[t * 3 + 2]] = f;
}
geom.setAttribute('faceId', new THREE.BufferAttribute(vertexFaceId, 1));
// three-mesh-bvh REORDERS the index buffer in place, so hit.faceIndex refers to the
// reordered triangle list — mapping it straight into our triangleFaceId array silently
// yields the wrong topological face. Two independent fixes, cross-checked below:
//   1. indirect:true keeps our index order, so hit.faceIndex needs no remapping.
//   2. read the per-vertex faceId attribute at hit.a — vertex data is never reordered.
geom.computeBoundsTree({ indirect: true });
Object.assign(window, { __geom: geom, __mesh: mesh, __THREE: THREE });

const material = new THREE.ShaderMaterial({
  uniforms: { uHover: { value: -1 }, uLight: { value: new THREE.Vector3(0.4, 0.5, 0.75).normalize() } },
  vertexShader: `
    attribute float faceId;
    varying float vFaceId; varying vec3 vNormal;
    void main() {
      vFaceId = faceId; vNormal = normalize(normalMatrix * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform float uHover; uniform vec3 uLight;
    varying float vFaceId; varying vec3 vNormal;
    void main() {
      float d = max(dot(normalize(vNormal), uLight), 0.0);
      vec3 base = mix(vec3(0.30, 0.33, 0.40), vec3(0.72, 0.78, 0.88), d);
      if (abs(vFaceId - uHover) < 0.5) base = mix(base, vec3(0.35, 0.65, 1.0), 0.65);
      gl_FragColor = vec4(base, 1.0);
    }`,
});
const solid = new THREE.Mesh(geom, material);
scene.add(solid);

const edgeGeom = new THREE.BufferGeometry();
edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(mesh.edges, 3));
scene.add(new THREE.LineSegments(edgeGeom, new THREE.LineBasicMaterial({ color: 0x11141a })));

// ---------------------------------------------------------------- camera
geom.computeBoundingBox();
const bbox = geom.boundingBox;
const center = bbox.getCenter(new THREE.Vector3());
const radius = bbox.getSize(new THREE.Vector3()).length() / 2;

const aspect = innerWidth / innerHeight;
let zoom = radius * 1.6;
const camera = new THREE.OrthographicCamera(-zoom * aspect, zoom * aspect, zoom, -zoom, 0.1, 10000);

/** Turntable: azimuth + elevation about a pivot, up-vector locked to +Z.
 *  Roll is not representable — that is the entire point. */
const cam = { az: Math.PI * 0.25, el: Math.PI * 0.28, pivot: center.clone() };
const target = { az: cam.az, el: cam.el, zoom };
const EL_LIMIT = Math.PI / 2 - 0.01;

function applyCamera() {
  const r = radius * 8;
  camera.position.set(
    cam.pivot.x + r * Math.cos(cam.el) * Math.cos(cam.az),
    cam.pivot.y + r * Math.cos(cam.el) * Math.sin(cam.az),
    cam.pivot.z + r * Math.sin(cam.el),
  );
  camera.up.set(0, 0, 1);              // locked: no roll, ever
  camera.lookAt(cam.pivot);
  const a = innerWidth / innerHeight;
  camera.left = -zoom * a; camera.right = zoom * a; camera.top = zoom; camera.bottom = -zoom;
  camera.updateProjectionMatrix();
}

const VIEWS = {
  Digit1: [-Math.PI / 2, 0], Digit2: [Math.PI / 2, 0], Digit3: [Math.PI, 0],
  Digit4: [0, 0],
  // At the poles the locked +Z up-vector nearly parallels the view direction, so screen
  // orientation is decided entirely by azimuth: screen-right resolves to (-sin az, cos az, 0).
  // az = -PI/2 is what puts X to the right and Y up, per CAD convention.
  Digit5: [-Math.PI / 2, EL_LIMIT], Digit6: [-Math.PI / 2, -EL_LIMIT],
  Digit7: [Math.PI * 0.25, Math.PI * 0.28], Digit0: [Math.PI * 0.25, Math.PI * 0.28],
};
const held = new Set();
addEventListener('keydown', (e) => {
  if (VIEWS[e.code]) { [target.az, target.el] = VIEWS[e.code]; e.preventDefault(); return; }
  if (e.code === 'Period' && hoverFace >= 0) { pivotToHoveredFace(); e.preventDefault(); return; }
  held.add(e.code);
  if (e.shiftKey) {           // snap-orbit in 15° steps
    const S = Math.PI / 12;
    if (e.code === 'ArrowLeft')  target.az -= S;
    if (e.code === 'ArrowRight') target.az += S;
    if (e.code === 'ArrowUp')    target.el = Math.min(target.el + S, EL_LIMIT);
    if (e.code === 'ArrowDown')  target.el = Math.max(target.el - S, -EL_LIMIT);
    held.clear();
  }
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Equal','Minus'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => held.delete(e.code));

// ---------------------------------------------------------------- picking
const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;
const pointer = new THREE.Vector2(-2, -2);
let hoverFace = -1;
let hoverPoint = null;
const hud = document.getElementById('hud');

addEventListener('pointermove', (e) => {
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
});

function pick() {
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(solid, false)[0];
  if (!hit) { hoverFace = -1; hoverPoint = null; hud.textContent = 'hover a face…'; return; }
  // With indirect:true the BVH leaves our index buffer alone and hit.faceIndex is
  // already in original triangle order — do NOT also call resolveTriangleIndex(),
  // that double-maps. Verified across 4589 rays: 4589/4589 vs 986/4589.
  const viaTriangle = mesh.triangleFaceId[hit.faceIndex];
  const viaVertex = geom.getAttribute('faceId').getX(hit.face.a);   // independent cross-check
  if (viaTriangle !== viaVertex) console.error(`[spike] face id disagreement: ${viaTriangle} vs ${viaVertex}`);
  hoverFace = viaTriangle;
  hoverPoint = hit.point.clone();
  const n = hit.face.normal;
  hud.innerHTML =
    `face <b>#${hoverFace}</b> of ${mesh.faceCount} &nbsp; tri <b>${hit.faceIndex}</b><br>` +
    `normal ${n.x.toFixed(2)}, ${n.y.toFixed(2)}, ${n.z.toFixed(2)}<br>` +
    `at ${hit.point.x.toFixed(1)}, ${hit.point.y.toFixed(1)}, ${hit.point.z.toFixed(1)}<br>` +
    `<span style="color:#6b7280">triangle=${viaTriangle} vertex=${viaVertex} agree=${viaTriangle === viaVertex}</span>`;
}
function pivotToHoveredFace() { if (hoverPoint) cam.pivot.copy(hoverPoint); }

// ---------------------------------------------------------------- loop
/** One deterministic step of the interaction loop. Split out from the rAF driver so
 *  it can be stepped from a test harness (rAF is paused whenever the pane is hidden). */
function advance(dt) {
  const RATE = 2.2;
  if (held.has('ArrowLeft'))  target.az -= RATE * dt;
  if (held.has('ArrowRight')) target.az += RATE * dt;
  if (held.has('ArrowUp'))    target.el = Math.min(target.el + RATE * dt, EL_LIMIT);
  if (held.has('ArrowDown'))  target.el = Math.max(target.el - RATE * dt, -EL_LIMIT);
  if (held.has('Equal')) target.zoom *= 1 - 1.5 * dt;
  if (held.has('Minus')) target.zoom *= 1 + 1.5 * dt;

  // critically-damped ease so the view never teleports
  const k = 1 - Math.exp(-12 * dt);
  cam.az += (target.az - cam.az) * k;
  cam.el += (target.el - cam.el) * k;
  zoom += (target.zoom - zoom) * k;

  applyCamera();
  pick();
  material.uniforms.uHover.value = hoverFace;
  renderer.render(scene, camera);
}

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05); last = now;
  advance(dt);
  requestAnimationFrame(frame);
}
/** Settle the eased camera onto its target without rAF. */
window.__step = (steps = 60, dt = 1 / 60) => { for (let i = 0; i < steps; i++) advance(dt); return { az: cam.az, el: cam.el, zoom }; };
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); applyCamera(); });
applyCamera();
requestAnimationFrame(frame);

Object.assign(window, { __camera: camera, __solid: solid, __cam: cam, __target: target });
console.log(`[spike] ${mesh.faceCount} faces, ${mesh.indices.length / 3} triangles, BVH built`);
