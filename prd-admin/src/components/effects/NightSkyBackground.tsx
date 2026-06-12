import { useEffect, useRef } from 'react';

export interface NightSkyBackgroundProps {
  /** viewport: 全屏 fixed；container: 填满父级 absolute */
  mode?: 'viewport' | 'container';
  className?: string;
}

/**
 * 视觉创作智能体同款夜景：星尘横移、流星、靛蓝山峦。
 * 与 VisualAgentWorkspaceListPage 共享实现。
 */
export function NightSkyBackground({ mode = 'viewport', className }: NightSkyBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = 0;
    let height = 0;

    const readSize = () => {
      if (mode === 'viewport') {
        width = window.innerWidth;
        height = window.innerHeight;
      } else {
        const rect = canvas.getBoundingClientRect();
        width = Math.max(1, rect.width);
        height = Math.max(1, rect.height);
      }
      canvas.width = width;
      canvas.height = height;
    };

    class StarObj {
      size: number;
      speed: number;
      x: number;
      y: number;
      opacity: number;

      constructor(x: number, y: number) {
        this.size = Math.random() * 2;
        this.speed = Math.random() * 0.03;
        this.x = x;
        this.y = y;
        this.opacity = Math.random() * 0.5 + 0.3;
      }

      reset() {
        this.size = Math.random() * 2;
        this.speed = Math.random() * 0.03;
        this.x = width;
        this.y = Math.random() * height;
        this.opacity = Math.random() * 0.5 + 0.3;
      }

      update() {
        this.x -= this.speed;
        if (this.x < 0) {
          this.reset();
        } else {
          ctx!.globalAlpha = this.opacity;
          ctx!.fillRect(this.x, this.y, this.size, this.size);
          ctx!.globalAlpha = 1;
        }
      }
    }

    class ShootingStar {
      x: number;
      y: number;
      len: number;
      speed: number;
      size: number;
      waitTime: number;
      active: boolean;

      constructor() {
        this.x = 0;
        this.y = 0;
        this.len = 0;
        this.speed = 0;
        this.size = 0;
        this.waitTime = 0;
        this.active = false;
        this.reset();
      }

      reset() {
        this.x = Math.random() * width;
        this.y = 0;
        this.len = Math.random() * 80 + 10;
        this.speed = Math.random() * 10 + 6;
        this.size = Math.random() * 1 + 0.1;
        this.waitTime = Date.now() + Math.random() * 5000 + 1000;
        this.active = false;
      }

      update() {
        if (this.active) {
          this.x -= this.speed;
          this.y += this.speed;
          if (this.x < 0 || this.y >= height) {
            this.reset();
          } else {
            ctx!.lineWidth = this.size;
            ctx!.beginPath();
            ctx!.moveTo(this.x, this.y);
            ctx!.lineTo(this.x + this.len, this.y - this.len);
            ctx!.strokeStyle = 'rgba(255, 255, 255, 0.6)';
            ctx!.stroke();
          }
        } else if (this.waitTime < Date.now()) {
          this.active = true;
        }
      }
    }

    class Terrain {
      terrainCanvas: HTMLCanvasElement;
      terCtx: CanvasRenderingContext2D;
      scrollDelay: number;
      lastScroll: number;
      fillStyle: string;
      mHeight: number;
      points: number[];

      constructor(options: {
        scrollDelay?: number;
        fillStyle?: string;
        mHeight?: number;
        displacement?: number;
      } = {}) {
        this.terrainCanvas = document.createElement('canvas');
        this.terCtx = this.terrainCanvas.getContext('2d')!;
        this.scrollDelay = options.scrollDelay || 90;
        this.lastScroll = Date.now();
        this.fillStyle = options.fillStyle || '#191D4C';
        this.mHeight = options.mHeight || height;
        this.points = [];
        this.rebuildTerrain(options.displacement || 140);
      }

      rebuildTerrain(displacement: number) {
        this.terrainCanvas.width = width;
        this.terrainCanvas.height = height;
        this.points = [];
        let disp = displacement;
        const power = Math.pow(2, Math.ceil(Math.log(Math.max(width, 2)) / Math.log(2)));
        this.points[0] = this.mHeight;
        this.points[power] = this.points[0];
        for (let i = 1; i < power; i *= 2) {
          for (let j = power / i / 2; j < power; j += power / i) {
            this.points[j] =
              (this.points[j - power / i / 2] + this.points[j + power / i / 2]) / 2 +
              Math.floor(Math.random() * -disp + disp);
          }
          disp *= 0.6;
        }
      }

      resize(mHeight: number, displacement: number) {
        this.mHeight = mHeight;
        this.rebuildTerrain(displacement);
      }

      update() {
        this.terCtx.clearRect(0, 0, width, height);
        this.terCtx.fillStyle = this.fillStyle;

        if (Date.now() > this.lastScroll + this.scrollDelay) {
          this.lastScroll = Date.now();
          this.points.push(this.points.shift()!);
        }

        this.terCtx.beginPath();
        for (let i = 0; i <= width; i++) {
          if (i === 0) {
            this.terCtx.moveTo(0, this.points[0]);
          } else if (this.points[i] !== undefined) {
            this.terCtx.lineTo(i, this.points[i]);
          }
        }
        this.terCtx.lineTo(width, this.terrainCanvas.height);
        this.terCtx.lineTo(0, this.terrainCanvas.height);
        this.terCtx.lineTo(0, this.points[0]);
        this.terCtx.fill();
        ctx!.drawImage(this.terrainCanvas, 0, 0);
      }
    }

    const stars: StarObj[] = [];
    const shootingStars: ShootingStar[] = [];
    let terrains: Terrain[] = [];

    const initScene = () => {
      readSize();
      stars.length = 0;
      shootingStars.length = 0;
      for (let i = 0; i < Math.min(height, 300); i++) {
        stars.push(new StarObj(Math.random() * width, Math.random() * height));
      }
      if (shootingStars.length === 0) {
        shootingStars.push(new ShootingStar(), new ShootingStar(), new ShootingStar());
      } else {
        shootingStars.forEach((s) => s.reset());
      }
      terrains = [
        new Terrain({
          mHeight: height / 2 - 100,
          fillStyle: 'rgba(45, 50, 85, 0.35)',
          displacement: 160,
          scrollDelay: 120,
        }),
        new Terrain({
          displacement: 130,
          scrollDelay: 70,
          fillStyle: 'rgba(30, 35, 60, 0.55)',
          mHeight: height / 2 - 40,
        }),
        new Terrain({
          displacement: 100,
          scrollDelay: 35,
          fillStyle: 'rgba(15, 18, 35, 0.85)',
          mHeight: height / 2 + 20,
        }),
      ];
    };

    initScene();

    const onResize = () => {
      const prevHeight = height;
      readSize();
      if (prevHeight !== height) {
        initScene();
      }
    };

    let ro: ResizeObserver | null = null;
    if (mode === 'viewport') {
      window.addEventListener('resize', onResize);
    } else {
      ro = new ResizeObserver(onResize);
      ro.observe(canvas);
      onResize();
    }

    function animate() {
      const gradient = ctx!.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, '#080808');
      gradient.addColorStop(0.3, '#08080c');
      gradient.addColorStop(0.6, '#0c0c14');
      gradient.addColorStop(1, '#08080e');
      ctx!.fillStyle = gradient;
      ctx!.fillRect(0, 0, width, height);

      ctx!.fillStyle = '#ffffff';
      for (const star of stars) {
        star.update();
      }
      for (const shootingStar of shootingStars) {
        shootingStar.update();
      }
      for (const terrain of terrains) {
        terrain.update();
      }

      animationRef.current = requestAnimationFrame(animate);
    }

    animate();

    return () => {
      if (mode === 'viewport') {
        window.removeEventListener('resize', onResize);
      }
      ro?.disconnect();
      cancelAnimationFrame(animationRef.current);
    };
  }, [mode]);

  const positionClass = mode === 'viewport' ? 'fixed inset-0' : 'absolute inset-0';

  return (
    <canvas
      ref={canvasRef}
      className={`${positionClass} w-full h-full pointer-events-none block ${className ?? ''}`}
      style={{ zIndex: 0 }}
      aria-hidden
    />
  );
}
