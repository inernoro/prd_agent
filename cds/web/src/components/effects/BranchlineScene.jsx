/*
 * BranchlineScene — 首页第二屏起的滚动叙事场景（2026-09-16）。
 *
 * 语法参照 Corn Revolution：整段只有一个东西——一条分支线；镜头沿着它推进，
 * 用户滚动的不是页面而是镜头。五章各是镜头在线上的一次停留，停留时发生一件事：
 *   Push    一道脉冲沿线跑向下一颗提交珠
 *   Build   四个容器从珠子旁边弹出来围成一圈（带一次粒子爆开）
 *   Preview 另一圈转绿，上方浮起预览域名牌
 *   Observe 镜头抬起，旁边八条平行分支淡入——整个集群
 *   Ship    收束
 *
 * 纪律：
 *  - 一切状态由滚动进度 p ∈ [0,1] 推导，不依赖 IntersectionObserver（rootMargin 只认 px/%，
 *    2026-09-09 就是它写成 rem 把首页整个崩掉的）。
 *  - 只在叙事区进入视口时渲染；离开视口或标签页隐藏时不跑 rAF。
 *  - 文案的淡入淡出直接改 DOM style，不走 setState——60fps 下 React 重渲染是负担。
 *  - prefers-reduced-motion：进度不再插值（滚到哪就是哪），粒子爆开仍随进度、不自动播。
 *  - 卸载时释放 renderer、后期合成器与几何体。
 *
 * 质感层（2026-09-16 第二版，用户看过第一版：「以为是 demo，没想到真是盒子」）：
 *  - 一切发光的东西走 emissive 强度 > 1 + Bloom（HalfFloat 帧缓冲），不再用平涂色块假装发光；
 *  - 容器是深色金属玻璃的圆角模块 + 橙色线框 + 内部发光核，不再是裸 BoxGeometry；
 *  - 主线是有明暗的实体管 + 辉光，星尘是软圆点精灵而非方点；
 *  - RoomEnvironment 做环境反射，ACES 色调映射，SMAA 抗锯齿；
 *  - 镜头带极轻微的呼吸晃动，画面永远不是死的。
 *
 * 与 reactbits 下的 Hyperspeed 同一接入方式（.jsx + types/reactbits-js.d.ts 里声明），
 * 不为 three 额外引类型包。
 */
import { BloomEffect, EffectComposer, EffectPass, RenderPass, SMAAEffect, SMAAPreset } from 'postprocessing';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

const CHAPTERS = 5; // Push / Build / Preview / Observe / Ship
const SEGMENTS = CHAPTERS - 1;
// 最后一颗放到镜头终点（camT 0.88 + 前视 0.07）之外，否则 Ship 章会有一颗贴着镜头的巨球
const BEADS = [0.18, 0.3, 0.38, 0.57, 0.72, 0.985];

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smooth = (x) => x * x * (3 - 2 * x);
const local = (p, a, b) => clamp01((p - a) / (b - a));
const weight = (p, i, w) => smooth(1 - clamp01(Math.abs(p - i / SEGMENTS) / w));
// 弹出：带一点过冲再落定
const pop = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : 1 - Math.pow(1 - u, 3) * Math.cos(u * 6.5));


/** 软圆点精灵：星尘与粒子共用，否则 Points 默认是方块。 */
function softDot() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64; const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function buildScene(canvas) {
  const ACCENT = new THREE.Color('hsl(24, 100%, 60%)');
  const ACCENT_HOT = new THREE.Color('#ffb070');
  const OK = new THREE.Color('hsl(152, 62%, 56%)');
  const BG = new THREE.Color('#120f17');
  const narrow = window.innerWidth < 900;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false, depth: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, narrow ? 1.5 : 2));
  renderer.setClearColor(BG, 1);
  // 不设 toneMapping / exposure：场景经合成器渲染到离屏缓冲，three 只在直出画布时做色调映射，设了也不生效
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(BG.getHex(), 0.025);
  const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 260);

  const disposables = [];
  const track = (obj) => { disposables.push(obj); return obj; };

  // 环境反射：金属与清漆没有它就是死的
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = track(pmrem.fromScene(new RoomEnvironment(), 0.04).texture);
  pmrem.dispose();
  scene.environment = envTex;
  scene.environmentIntensity = 0.42;

  // 灯：暖主光跟着镜头，冷轮廓光从后上方把边缘切出来
  scene.add(new THREE.HemisphereLight(0x3a2f4a, 0x0a080d, 0.22));
  const key = new THREE.PointLight(0xffb27a, 18, 60, 1.6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8a7cff, 0.9);
  rim.position.set(-6, 10, -8);
  scene.add(rim);

  const dot = track(softDot());

  // ── 主分支：有明暗的实体管 + 辉光壳 ──
  const pts = [];
  for (let i = 0; i <= 14; i++) {
    pts.push(new THREE.Vector3(-42 + i * 6, Math.sin(i * 0.85) * 2.4, Math.cos(i * 0.65) * 3.2));
  }
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);

  const coreMat = track(new THREE.MeshStandardMaterial({ color: 0xff8a2a, emissive: 0xff6a12, emissiveIntensity: 2.4, roughness: 0.32, metalness: 0.05 }));
  scene.add(new THREE.Mesh(track(new THREE.TubeGeometry(curve, 640, 0.065, 20, false)), coreMat));
  const haloMat = track(new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(new THREE.Mesh(track(new THREE.TubeGeometry(curve, 320, 0.26, 12, false)), haloMat));

  // 提交珠：清漆球体，核心发光
  const beadGeo = track(new THREE.SphereGeometry(0.34, 48, 48));
  const beadMat = track(new THREE.MeshPhysicalMaterial({ color: 0xfff1e6, emissive: 0xff7a1a, emissiveIntensity: 0.95, roughness: 0.18, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.12 }));
  const beads = BEADS.map((t) => {
    const m = new THREE.Mesh(beadGeo, beadMat);
    m.position.copy(curve.getPointAt(t));
    scene.add(m);
    return m;
  });

  // ── 星尘：远层静止 + 近层缓慢漂 ──
  function dust(n, spread, size, opacity) {
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = (Math.random() - 0.5) * spread[0]; a[i * 3 + 1] = (Math.random() - 0.5) * spread[1]; a[i * 3 + 2] = (Math.random() - 0.5) * spread[2]; }
    const g = track(new THREE.BufferGeometry()); g.setAttribute('position', new THREE.BufferAttribute(a, 3));
    const m = track(new THREE.PointsMaterial({ map: dot, color: 0xffd6b8, size, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }));
    const p = new THREE.Points(g, m); scene.add(p); return p;
  }
  // 星尘要少、要暗：叠着辉光会把背景抬成雾
  dust(900, [170, 80, 90], 0.3, 0.09);
  const motes = dust(140, [120, 40, 50], 0.55, 0.1);

  // ── Push：脉冲彗星（头 + 三节尾巴）──
  const pulseMat = track(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const pulse = new THREE.Mesh(track(new THREE.SphereGeometry(0.19, 24, 24)), pulseMat);
  const pulseGlow = new THREE.Mesh(track(new THREE.SphereGeometry(0.62, 20, 20)), track(new THREE.MeshBasicMaterial({ color: ACCENT_HOT, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false })));
  pulse.add(pulseGlow); scene.add(pulse);
  const tail = [0.72, 0.5, 0.3].map((sz, i) => {
    const m = new THREE.Mesh(track(new THREE.SphereGeometry(0.19 * sz, 16, 16)), track(new THREE.MeshBasicMaterial({ color: ACCENT_HOT, transparent: true, opacity: 0.55 - i * 0.15, blending: THREE.AdditiveBlending, depthWrite: false })));
    scene.add(m); return m;
  });

  // ── 容器模块：圆角深色金属玻璃 + 橙色线框 + 内部发光核 ──
  const modGeo = track(new RoundedBoxGeometry(0.66, 0.66, 0.66, 5, 0.09));
  const edgeGeo = track(new THREE.EdgesGeometry(track(new THREE.BoxGeometry(0.68, 0.68, 0.68))));
  const coreGeo = track(new THREE.BoxGeometry(0.3, 0.3, 0.3));
  function module(color) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(modGeo, track(new THREE.MeshPhysicalMaterial({ color: 0x1a1522, metalness: 0.8, roughness: 0.24, clearcoat: 0.7, clearcoatRoughness: 0.18, envMapIntensity: 1.4 })));
    const frame = new THREE.LineSegments(edgeGeo, track(new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 })));
    const core = new THREE.Mesh(coreGeo, track(new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 2.8, roughness: 1 })));
    g.add(body, frame, core);
    return g;
  }
  function ring(center, color, radius, count, tiltX) {
    const grp = new THREE.Group();
    const cubes = [];
    for (let i = 0; i < count; i++) {
      const c = module(color);
      c.userData.angle = (i / count) * Math.PI * 2;
      cubes.push(c); grp.add(c);
    }
    const orbit = new THREE.Mesh(track(new THREE.TorusGeometry(radius, 0.016, 10, 220)), track(new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.7, roughness: 0.6 })));
    const disc = new THREE.Mesh(track(new THREE.RingGeometry(radius - 0.4, radius + 0.4, 128)), track(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.05, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })));
    grp.add(orbit, disc);
    grp.position.copy(center);
    grp.rotation.x = tiltX;
    grp.userData = { cubes, radius, scale: 0, spin: 0, orbit, disc };
    scene.add(grp);
    return grp;
  }
  const ringBuild = ring(beads[2].position, ACCENT, 2.05, 4, 0);
  const ringPreview = ring(beads[3].position, OK, 2.05, 4, Math.PI / 2);

  function burst(center, color) {
    const n = 260; const pos = new Float32Array(n * 3); const dir = [];
    for (let i = 0; i < n; i++) {
      dir.push(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 3.5));
      pos[i * 3] = center.x; pos[i * 3 + 1] = center.y; pos[i * 3 + 2] = center.z;
    }
    const g = track(new THREE.BufferGeometry()); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const p = new THREE.Points(g, track(new THREE.PointsMaterial({ map: dot, color, size: 0.34, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })));
    p.userData = { center, dir, n }; scene.add(p); return p;
  }
  const burstBuild = burst(beads[2].position, ACCENT_HOT);
  const burstPreview = burst(beads[3].position, OK);
  function setBurst(b, life) {
    const a = b.geometry.attributes.position.array; const { center, dir, n } = b.userData;
    const e = 1 - Math.pow(1 - Math.min(life, 1), 3);
    for (let i = 0; i < n; i++) { a[i * 3] = center.x + dir[i].x * e; a[i * 3 + 1] = center.y + dir[i].y * e; a[i * 3 + 2] = center.z + dir[i].z * e; }
    b.geometry.attributes.position.needsUpdate = true;
    b.material.opacity = life <= 0 || life >= 1 ? 0 : (1 - life) * 0.9;
  }

  // 域名牌：canvas 画字贴成 sprite（文字压暗一点，免得被辉光糊掉）
  function label(text, dotCss) {
    const c = document.createElement('canvas'); c.width = 768; c.height = 128; const x = c.getContext('2d');
    x.fillStyle = 'rgba(18,15,23,0.86)'; x.strokeStyle = 'rgba(255,255,255,0.16)'; x.lineWidth = 3;
    const r = 40;
    x.beginPath(); x.moveTo(r, 8); x.lineTo(768 - r, 8); x.quadraticCurveTo(760, 8, 760, 8 + r); x.lineTo(760, 120 - r);
    x.quadraticCurveTo(760, 120, 760 - r, 120); x.lineTo(r, 120); x.quadraticCurveTo(8, 120, 8, 120 - r); x.lineTo(8, 8 + r);
    x.quadraticCurveTo(8, 8, r, 8); x.closePath(); x.fill(); x.stroke();
    x.fillStyle = dotCss; x.beginPath(); x.arc(60, 64, 10, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#d9d9df'; x.font = '500 40px "JetBrains Mono", Menlo, monospace'; x.textBaseline = 'middle'; x.fillText(text, 96, 66);
    const tex = track(new THREE.CanvasTexture(c)); tex.minFilter = THREE.LinearFilter; tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false })));
    s.scale.set(6, 1, 1); scene.add(s); return s;
  }
  const domain = label('auth-flow.example.test', 'hsl(152, 62%, 56%)');
  domain.position.copy(beads[3].position).add(new THREE.Vector3(0, 3.1, 0));

  // ── Observe：集群视角的平行分支 ──
  const cluster = new THREE.Group();
  const clusterMats = [];
  for (let k = 0; k < 8; k++) {
    const off = new THREE.Vector3(0, (k % 2 ? 1 : -1) * (2.5 + k * 0.9), (k < 4 ? 1 : -1) * (5 + k * 1.6));
    const cpts = pts.map((p, i) => p.clone().add(off).add(new THREE.Vector3(0, Math.sin(i * 0.5 + k) * 0.8, 0)));
    const cc = new THREE.CatmullRomCurve3(cpts, false, 'catmullrom', 0.5);
    const m = track(new THREE.MeshStandardMaterial({ color: 0x4a3f66, emissive: 0x8a78c0, emissiveIntensity: 0.55, roughness: 0.5, transparent: true, opacity: 0 }));
    cluster.add(new THREE.Mesh(track(new THREE.TubeGeometry(cc, 300, 0.05, 12, false)), m)); clusterMats.push(m);
    for (let j = 0; j < 2; j++) {
      const bm = track(new THREE.MeshStandardMaterial({ color: j ? OK : ACCENT, emissive: j ? OK : ACCENT, emissiveIntensity: 1.6, roughness: 0.4, transparent: true, opacity: 0 }));
      const b = new THREE.Mesh(track(new THREE.SphereGeometry(0.2, 24, 24)), bm);
      b.position.copy(cc.getPointAt(0.3 + j * 0.34 + (k % 3) * 0.05)); cluster.add(b); clusterMats.push(bm);
    }
  }
  scene.add(cluster);

  // ── 后期：Bloom（HalfFloat 帧缓冲，让 emissive > 1 真的发光）+ SMAA ──
  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new BloomEffect({ intensity: 0.85, luminanceThreshold: 0.82, luminanceSmoothing: 0.2, mipmapBlur: true, radius: 0.4 });
  composer.addPass(new EffectPass(camera, bloom));
  const finalPass = new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.MEDIUM }));
  composer.addPass(finalPass);
  // three 0.184 直出画布时自己做 sRGB 编码，postprocessing 6.39 的末端 EffectPass 默认再编码一次：
  // 暗部被整体抬亮——清屏色 #120f17 出来是 #4a4256、中灰 #808080 出来是 #bcbcbc，整屏灰蒙蒙。
  // 前六版把雾、环境光、半球光、星尘、辉光半径逐个压暗都没用，消融到最后只有这一处是根因。
  finalPass.fullscreenMaterial.encodeOutput = false;

  const camPos = new THREE.Vector3(); const look = new THREE.Vector3(); const tmp = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0); const side = new THREE.Vector3(); const over = new THREE.Vector3();

  function resize(w, h) {
    renderer.setSize(w, h, false); composer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  function render(p, t, dt) {
    // 镜头沿曲线推进；Observe 那章抬起来看全局；叠一层极轻的呼吸，画面不死
    const camT = 0.1 + p * 0.78;
    curve.getPointAt(camT, camPos);
    curve.getTangentAt(camT, tmp);
    side.crossVectors(tmp, up).normalize();
    camPos.addScaledVector(side, 2.6 + Math.sin(t * 0.31) * 0.12).addScaledVector(up, 1.35 + Math.sin(t * 0.23) * 0.09);
    curve.getPointAt(Math.min(1, camT + 0.07), look);
    const w4 = weight(p, 3, 0.16);
    over.set(0, 14, 0).addScaledVector(side, -6);
    camPos.addScaledVector(over, w4);
    tmp.copy(beads[4].position); look.lerp(tmp, w4 * 0.9);
    camera.position.copy(camPos); camera.lookAt(look);
    key.position.copy(camPos).addScaledVector(up, 1.5);

    beads.forEach((b, i) => b.scale.setScalar(1 + Math.sin(t * 2 + i) * 0.04));
    motes.rotation.y = t * 0.012; motes.position.y = Math.sin(t * 0.2) * 0.4;

    // Push：彗星
    const u1 = smooth(local(p, 0, 0.2));
    const pt = BEADS[0] + (BEADS[1] - BEADS[0]) * u1;
    curve.getPointAt(pt, pulse.position);
    const pv = p < 0.24;
    pulse.visible = pv;
    tail.forEach((m, i) => { m.visible = pv && u1 > 0.02; curve.getPointAt(Math.max(0, pt - (i + 1) * 0.0075), m.position); });
    pulseGlow.scale.setScalar(1 + Math.sin(t * 9) * 0.16);

    // Build
    ringBuild.userData.scale = pop(local(p, 0.15, 0.3)); ringBuild.userData.spin = t * 0.32;
    setBurst(burstBuild, local(p, 0.16, 0.28));

    // Preview
    ringPreview.userData.scale = pop(local(p, 0.4, 0.55)); ringPreview.userData.spin = -t * 0.24;
    setBurst(burstPreview, local(p, 0.41, 0.53));
    domain.material.opacity = smooth(local(p, 0.45, 0.55)) * (1 - w4 * 0.7);
    domain.position.y = beads[3].position.y + 3.1 + Math.sin(t * 1.4) * 0.12;

    [ringBuild, ringPreview].forEach((g) => {
      const { cubes, radius, scale, spin, orbit, disc } = g.userData;
      g.visible = scale > 0.001;
      cubes.forEach((c, i) => {
        const a = c.userData.angle + spin;
        c.position.set(Math.cos(a) * radius, Math.sin(a) * radius, 0);
        // 模块朝外站，自身只慢转——不是陀螺
        c.rotation.set(0, 0, a);
        c.rotation.y = t * 0.35 + i;
        c.scale.setScalar(Math.max(0.001, scale));
      });
      orbit.scale.setScalar(Math.max(0.001, scale));
      disc.scale.setScalar(Math.max(0.001, scale));
    });

    // Observe
    const cw = smooth(local(p, 0.62, 0.78)) * (1 - smooth(local(p, 0.9, 1)) * 0.6);
    clusterMats.forEach((m, i) => { m.opacity = cw * (i % 3 === 0 ? 0.6 : 0.95); });
    cluster.visible = cw > 0.01;

    composer.render(dt);
  }

  function dispose() {
    composer.dispose();
    disposables.forEach((d) => { try { d.dispose(); } catch { /* 已释放 */ } });
    renderer.dispose();
  }

  return { resize, render, dispose };
}

export default function BranchlineScene({ rootRef }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef && rootRef.current;
    if (!canvas || !root) return undefined;

    let built;
    try { built = buildScene(canvas); } catch { return undefined; } // 无 WebGL：退化成纯文字长页
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const copies = Array.from(root.querySelectorAll('[data-cdsh-chapter]'));
    const rails = Array.from(root.querySelectorAll('[data-cdsh-rail]'));

    let raf = 0; let prog = 0; let railOn = -1; let sized = false; let hidden = document.hidden; let last = 0;

    const schedule = () => { if (!raf && !hidden) raf = requestAnimationFrame(frame); };
    const onResize = () => { sized = false; schedule(); };
    const onVis = () => { hidden = document.hidden; last = 0; schedule(); };

    function frame(now) {
      raf = 0;
      if (hidden) return;
      const rect = root.getBoundingClientRect();
      const vh = window.innerHeight;
      const inView = rect.bottom > 0 && rect.top < vh;
      // 离屏就真的停：不再重排帧。留在 hero 或页脚时一帧都不跑，由下面的 IntersectionObserver 叫醒
      if (!inView) { last = 0; return; }
      if (!sized) { built.resize(window.innerWidth, vh); sized = true; }
      const target = clamp01(-rect.top / Math.max(1, rect.height - vh));
      // 按时间插值而不是按帧：低帧率设备（软渲染约 2–3fps）上按帧插值要十几秒才跟上
      const dt = last ? Math.min(100, now - last) : 16; last = now;
      prog += (target - prog) * (reduced ? 1 : 1 - Math.exp(-dt / 140));
      const p = prog;
      for (let i = 0; i < copies.length; i++) {
        const w = weight(p, i, 0.14);
        copies[i].style.opacity = (0.06 + 0.94 * w).toFixed(3);
        copies[i].style.transform = `translateY(${((1 - w) * 1.4).toFixed(2)}rem)`;
      }
      const nearest = Math.round(p * SEGMENTS);
      if (nearest !== railOn) { railOn = nearest; rails.forEach((a, i) => a.classList.toggle('is-on', i === nearest)); }
      // reduced-motion：时钟冻结在 0，镜头呼吸、珠子脉动、星尘漂移、模块自转、域名牌浮动全部静止，只剩滚动本身驱动的变化
      built.render(p, reduced ? 0 : now * 0.001, dt / 1000);
      raf = requestAnimationFrame(frame);
    }

    // 只用它当「进入视口」的门铃；不带 rootMargin（2026-09-09 首页死机的根因就是它被转成 rem）
    const io = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) schedule(); })
      : null;
    if (io) io.observe(root);
    // 没有 IntersectionObserver 的环境退回滚动事件叫醒；帧循环自己会在离屏时停下
    const onScroll = io ? null : () => schedule();
    if (onScroll) window.addEventListener('scroll', onScroll, { passive: true });

    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('visibilitychange', onVis);
    schedule();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (io) io.disconnect();
      if (onScroll) window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
      built.dispose();
    };
  }, [rootRef]);

  return <canvas ref={canvasRef} className="cdsh-scene" aria-hidden />;
}
