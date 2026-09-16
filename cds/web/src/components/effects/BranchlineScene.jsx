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
 *  - 卸载时释放 renderer 与几何体。
 *
 * 与 reactbits 下的 Hyperspeed 同一接入方式（.jsx + types/reactbits-js.d.ts 里声明），
 * 不为 three 额外引类型包。
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';

const CHAPTERS = 5; // Push / Build / Preview / Observe / Ship
const SEGMENTS = CHAPTERS - 1;
const BEADS = [0.18, 0.3, 0.38, 0.57, 0.72, 0.9];

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smooth = (x) => x * x * (3 - 2 * x);
const local = (p, a, b) => clamp01((p - a) / (b - a));
const weight = (p, i, w) => smooth(1 - clamp01(Math.abs(p - i / SEGMENTS) / w));
// 弹出：带一点过冲再落定
const pop = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : 1 - Math.pow(1 - u, 3) * Math.cos(u * 6.5));

function buildScene(canvas) {
  const ACCENT = new THREE.Color('hsl(24, 100%, 60%)');
  const OK = new THREE.Color('hsl(152, 62%, 56%)');
  const BG = new THREE.Color('#120f17');

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(BG, 1);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(BG.getHex(), 0.022);
  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 260);
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.PointLight(0xffb27a, 1.4, 60);
  scene.add(key);

  const disposables = [];
  const track = (obj) => { disposables.push(obj); return obj; };

  // 主分支：一条贯穿全程的曲线
  const pts = [];
  for (let i = 0; i <= 14; i++) {
    pts.push(new THREE.Vector3(-42 + i * 6, Math.sin(i * 0.85) * 2.4, Math.cos(i * 0.65) * 3.2));
  }
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);

  function filament(c, radius, color, opacity, segs) {
    const g = track(new THREE.TubeGeometry(c, segs || 420, radius, 8, false));
    const m = track(new THREE.MeshBasicMaterial({
      color, transparent: opacity < 1, opacity,
      blending: opacity < 1 ? THREE.AdditiveBlending : THREE.NormalBlending, depthWrite: opacity >= 1,
    }));
    const mesh = new THREE.Mesh(g, m);
    scene.add(mesh);
    return mesh;
  }
  filament(curve, 0.08, ACCENT, 1);
  filament(curve, 0.32, ACCENT, 0.12);

  const beadGeo = track(new THREE.SphereGeometry(0.34, 20, 20));
  const beadMat = track(new THREE.MeshStandardMaterial({ color: 0xfff1e6, emissive: ACCENT, emissiveIntensity: 0.55, roughness: 0.35, metalness: 0.1 }));
  const beads = BEADS.map((t) => {
    const m = new THREE.Mesh(beadGeo, beadMat);
    m.position.copy(curve.getPointAt(t));
    scene.add(m);
    return m;
  });

  // 星尘
  {
    const n = 2600; const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = (Math.random() - 0.5) * 160; a[i * 3 + 1] = (Math.random() - 0.5) * 70; a[i * 3 + 2] = (Math.random() - 0.5) * 80; }
    const g = track(new THREE.BufferGeometry()); g.setAttribute('position', new THREE.BufferAttribute(a, 3));
    scene.add(new THREE.Points(g, track(new THREE.PointsMaterial({ color: 0xffffff, size: 0.09, transparent: true, opacity: 0.42 }))));
  }

  // Push：脉冲
  const pulse = new THREE.Mesh(track(new THREE.SphereGeometry(0.22, 14, 14)), track(new THREE.MeshBasicMaterial({ color: 0xffffff })));
  const pulseGlow = new THREE.Mesh(track(new THREE.SphereGeometry(0.7, 14, 14)), track(new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false })));
  pulse.add(pulseGlow); scene.add(pulse);

  // Build / Preview：容器环
  function ring(center, color, radius, count, tiltX) {
    const grp = new THREE.Group();
    const geo = track(new THREE.BoxGeometry(0.54, 0.54, 0.54));
    const mat = track(new THREE.MeshStandardMaterial({ color: 0x2a2233, emissive: color, emissiveIntensity: 0.7, roughness: 0.45, metalness: 0.2 }));
    const cubes = [];
    for (let i = 0; i < count; i++) {
      const c = new THREE.Mesh(geo, mat);
      c.userData.angle = (i / count) * Math.PI * 2;
      cubes.push(c); grp.add(c);
    }
    const orbit = new THREE.Mesh(track(new THREE.TorusGeometry(radius, 0.02, 6, 80)), track(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35 })));
    grp.add(orbit);
    grp.position.copy(center);
    grp.rotation.x = tiltX;
    grp.userData = { cubes, radius, scale: 0, spin: 0 };
    scene.add(grp);
    return grp;
  }
  const ringBuild = ring(beads[2].position, ACCENT, 1.9, 4, 0);
  const ringPreview = ring(beads[3].position, OK, 1.9, 4, Math.PI / 2);

  function burst(center, color) {
    const n = 220; const pos = new Float32Array(n * 3); const dir = [];
    for (let i = 0; i < n; i++) {
      dir.push(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 3));
      pos[i * 3] = center.x; pos[i * 3 + 1] = center.y; pos[i * 3 + 2] = center.z;
    }
    const g = track(new THREE.BufferGeometry()); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const p = new THREE.Points(g, track(new THREE.PointsMaterial({ color, size: 0.12, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })));
    p.userData = { center, dir, n }; scene.add(p); return p;
  }
  const burstBuild = burst(beads[2].position, ACCENT);
  const burstPreview = burst(beads[3].position, OK);
  function setBurst(b, life) {
    const a = b.geometry.attributes.position.array; const { center, dir, n } = b.userData;
    const e = 1 - Math.pow(1 - Math.min(life, 1), 3);
    for (let i = 0; i < n; i++) { a[i * 3] = center.x + dir[i].x * e; a[i * 3 + 1] = center.y + dir[i].y * e; a[i * 3 + 2] = center.z + dir[i].z * e; }
    b.geometry.attributes.position.needsUpdate = true;
    b.material.opacity = life <= 0 || life >= 1 ? 0 : (1 - life) * 0.9;
  }

  // 域名牌：canvas 画字贴成 sprite
  function label(text, dotCss) {
    const c = document.createElement('canvas'); c.width = 768; c.height = 128; const x = c.getContext('2d');
    x.fillStyle = 'rgba(18,15,23,0.85)'; x.strokeStyle = 'rgba(255,255,255,0.14)'; x.lineWidth = 3;
    const r = 40;
    x.beginPath(); x.moveTo(r, 8); x.lineTo(768 - r, 8); x.quadraticCurveTo(760, 8, 760, 8 + r); x.lineTo(760, 120 - r);
    x.quadraticCurveTo(760, 120, 760 - r, 120); x.lineTo(r, 120); x.quadraticCurveTo(8, 120, 8, 120 - r); x.lineTo(8, 8 + r);
    x.quadraticCurveTo(8, 8, r, 8); x.closePath(); x.fill(); x.stroke();
    x.fillStyle = dotCss; x.beginPath(); x.arc(60, 64, 10, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#f6f6f8'; x.font = '500 40px "JetBrains Mono", Menlo, monospace'; x.textBaseline = 'middle'; x.fillText(text, 96, 66);
    const tex = track(new THREE.CanvasTexture(c)); tex.minFilter = THREE.LinearFilter;
    const s = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false })));
    s.scale.set(6, 1, 1); scene.add(s); return s;
  }
  const domain = label('auth-flow.example.test', 'hsl(152, 62%, 56%)');
  domain.position.copy(beads[3].position).add(new THREE.Vector3(0, 3.1, 0));

  // Observe：集群视角的平行分支
  const cluster = new THREE.Group();
  const clusterMats = [];
  for (let k = 0; k < 8; k++) {
    const off = new THREE.Vector3(0, (k % 2 ? 1 : -1) * (2.5 + k * 0.9), (k < 4 ? 1 : -1) * (5 + k * 1.6));
    const cpts = pts.map((p, i) => p.clone().add(off).add(new THREE.Vector3(0, Math.sin(i * 0.5 + k) * 0.8, 0)));
    const cc = new THREE.CatmullRomCurve3(cpts, false, 'catmullrom', 0.5);
    const g = track(new THREE.TubeGeometry(cc, 260, 0.05, 8, false));
    const m = track(new THREE.MeshBasicMaterial({ color: 0x9a9aa4, transparent: true, opacity: 0 }));
    cluster.add(new THREE.Mesh(g, m)); clusterMats.push(m);
    for (let j = 0; j < 2; j++) {
      const bm = track(new THREE.MeshBasicMaterial({ color: j ? OK : ACCENT, transparent: true, opacity: 0 }));
      const b = new THREE.Mesh(track(new THREE.SphereGeometry(0.22, 12, 12)), bm);
      b.position.copy(cc.getPointAt(0.3 + j * 0.34 + (k % 3) * 0.05)); cluster.add(b); clusterMats.push(bm);
    }
  }
  scene.add(cluster);

  const camPos = new THREE.Vector3(); const look = new THREE.Vector3(); const tmp = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0); const side = new THREE.Vector3(); const over = new THREE.Vector3();

  function resize(w, h) {
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  function render(p, t) {
    // 镜头沿曲线推进；Observe 那章抬起来看全局
    const camT = 0.1 + p * 0.78;
    curve.getPointAt(camT, camPos);
    curve.getTangentAt(camT, tmp);
    side.crossVectors(tmp, up).normalize();
    camPos.addScaledVector(side, 2.6).addScaledVector(up, 1.35);
    curve.getPointAt(Math.min(1, camT + 0.07), look);
    const w4 = weight(p, 3, 0.16);
    over.set(0, 14, 0).addScaledVector(side, -6);
    camPos.addScaledVector(over, w4);
    tmp.copy(beads[4].position); look.lerp(tmp, w4 * 0.9);
    camera.position.copy(camPos); camera.lookAt(look);
    key.position.copy(camPos);

    beads.forEach((b, i) => b.scale.setScalar(1 + Math.sin(t * 2 + i) * 0.05));

    // Push
    const pt = BEADS[0] + (BEADS[1] - BEADS[0]) * smooth(local(p, 0, 0.2));
    curve.getPointAt(pt, pulse.position);
    pulse.visible = p < 0.24;
    pulseGlow.scale.setScalar(1 + Math.sin(t * 9) * 0.18);

    // Build
    ringBuild.userData.scale = pop(local(p, 0.15, 0.3)); ringBuild.userData.spin = t * 0.5;
    setBurst(burstBuild, local(p, 0.16, 0.28));

    // Preview
    ringPreview.userData.scale = pop(local(p, 0.4, 0.55)); ringPreview.userData.spin = -t * 0.35;
    setBurst(burstPreview, local(p, 0.41, 0.53));
    domain.material.opacity = smooth(local(p, 0.45, 0.55)) * (1 - w4 * 0.7);
    domain.position.y = beads[3].position.y + 3.1 + Math.sin(t * 1.4) * 0.12;

    [ringBuild, ringPreview].forEach((g) => {
      const { cubes, radius, scale, spin } = g.userData;
      g.visible = scale > 0.001;
      cubes.forEach((c) => {
        const a = c.userData.angle + spin;
        c.position.set(Math.cos(a) * radius, Math.sin(a) * radius, 0);
        c.rotation.set(spin, a, 0);
        c.scale.setScalar(Math.max(0.001, scale));
      });
      g.children[cubes.length].scale.setScalar(Math.max(0.001, scale));
    });

    // Observe
    const cw = smooth(local(p, 0.62, 0.78)) * (1 - smooth(local(p, 0.9, 1)) * 0.6);
    clusterMats.forEach((m, i) => { m.opacity = cw * (i % 3 === 0 ? 0.55 : 0.9); });
    cluster.visible = cw > 0.01;

    renderer.render(scene, camera);
  }

  function dispose() {
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

    let raf = 0; let prog = 0; let railOn = -1; let sized = false; let hidden = document.hidden;

    const onResize = () => { sized = false; };
    const onVis = () => { hidden = document.hidden; if (!hidden && !raf) raf = requestAnimationFrame(frame); };

    function frame(now) {
      raf = 0;
      if (hidden) return;
      const rect = root.getBoundingClientRect();
      const vh = window.innerHeight;
      const inView = rect.bottom > 0 && rect.top < vh;
      if (inView) {
        if (!sized) { built.resize(window.innerWidth, vh); sized = true; }
        const target = clamp01(-rect.top / Math.max(1, rect.height - vh));
        prog += (target - prog) * (reduced ? 1 : 0.075);
        const p = prog;
        for (let i = 0; i < copies.length; i++) {
          const w = weight(p, i, 0.14);
          copies[i].style.opacity = (0.06 + 0.94 * w).toFixed(3);
          copies[i].style.transform = `translateY(${((1 - w) * 1.4).toFixed(2)}rem)`;
        }
        const nearest = Math.round(p * SEGMENTS);
        if (nearest !== railOn) { railOn = nearest; rails.forEach((a, i) => a.classList.toggle('is-on', i === nearest)); }
        built.render(p, now * 0.001);
      }
      raf = requestAnimationFrame(frame);
    }

    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('visibilitychange', onVis);
    raf = requestAnimationFrame(frame);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
      built.dispose();
    };
  }, [rootRef]);

  return <canvas ref={canvasRef} className="cdsh-scene" aria-hidden />;
}
