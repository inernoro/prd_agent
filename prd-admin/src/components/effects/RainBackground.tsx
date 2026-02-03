import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';

export interface RainBackgroundProps {
  opacity?: number;
  rainCount?: number;
  cloudCount?: number;
  rainSpeed?: number;
}

/**
 * 下雨效果背景组件
 * 使用 Three.js 实现云朵和雨滴动画
 */
export const RainBackground: React.FC<RainBackgroundProps> = ({
  opacity = 0.3,
  rainCount = 15000,
  cloudCount = 25,
  rainSpeed = 0.1,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const animationFrameRef = useRef<number>();

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    // 创建场景
    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.fog = new THREE.FogExp2(0x11111f, 0.002);

    // 创建渲染器
    const renderer = new THREE.WebGLRenderer({ alpha: true });
    rendererRef.current = renderer;
    renderer.setClearColor(scene.fog.color, 0);
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    // 创建相机
    const camera = new THREE.PerspectiveCamera(60, width / height, 1, 1000);
    camera.position.z = 1;
    camera.rotation.x = 1.16;
    camera.rotation.y = -0.12;
    camera.rotation.z = 0.27;

    // 环境光源
    const ambient = new THREE.AmbientLight(0x555555);
    scene.add(ambient);

    // 平行光源
    const directional = new THREE.DirectionalLight(0xffeedd);
    directional.position.set(0, 0, 1);
    scene.add(directional);

    // 点光源
    const point = new THREE.PointLight(0x062d89, 30, 500, 1.7);
    point.position.set(200, 300, 100);
    scene.add(point);

    const cloudParticles: THREE.Mesh[] = [];

    // 加载云朵纹理
    const loader = new THREE.TextureLoader();
    loader.load('https://i.postimg.cc/TYvjnH2F/smoke-1.png', (texture) => {
      const cloudGeometry = new THREE.PlaneGeometry(500, 500);
      const cloudMaterial = new THREE.MeshLambertMaterial({
        map: texture,
        transparent: true,
      });

      for (let i = 0; i < cloudCount; i++) {
        const cloud = new THREE.Mesh(cloudGeometry, cloudMaterial);
        cloud.position.set(
          Math.random() * 800 - 400,
          500,
          Math.random() * 500 - 450
        );
        cloud.rotation.x = 1.16;
        cloud.rotation.y = -0.12;
        cloud.rotation.z = Math.random() * Math.PI * 2;
        cloud.material.opacity = opacity * 2; // 云朵稍微明显一些
        cloudParticles.push(cloud);
        scene.add(cloud);
      }
    });

    // 创建雨滴
    const rainGeometry = new THREE.BufferGeometry();
    const positions: number[] = [];
    const velocities: number[] = [];

    for (let i = 0; i < rainCount; i++) {
      positions.push(
        Math.random() * 400 - 200,
        Math.random() * 500 - 250,
        Math.random() * 400 - 200
      );
      velocities.push(0);
    }

    rainGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

    const rainMaterial = new THREE.PointsMaterial({
      color: 0xaaaaaa,
      size: 0.1,
      transparent: true,
      opacity: opacity,
    });

    const rain = new THREE.Points(rainGeometry, rainMaterial);
    scene.add(rain);

    // 动画循环
    function animate() {
      // 云朵旋转
      cloudParticles.forEach((cloud) => {
        cloud.rotation.z -= 0.002;
      });

      // 雨滴下落
      const positionAttribute = rainGeometry.getAttribute('position');
      for (let i = 0; i < rainCount; i++) {
        velocities[i] -= rainSpeed + Math.random() * 0.1;
        const y = positionAttribute.getY(i);
        const newY = y + velocities[i];

        if (newY < -200) {
          positionAttribute.setY(i, 200);
          velocities[i] = 0;
        } else {
          positionAttribute.setY(i, newY);
        }
      }
      positionAttribute.needsUpdate = true;
      rain.rotation.y += 0.002;

      renderer.render(scene, camera);
      animationFrameRef.current = requestAnimationFrame(animate);
    }

    animate();

    // 响应式调整
    const handleResize = () => {
      const newWidth = container.clientWidth;
      const newHeight = container.clientHeight;
      renderer.setSize(newWidth, newHeight);
      renderer.setPixelRatio(window.devicePixelRatio);
      camera.aspect = newWidth / newHeight;
      camera.updateProjectionMatrix();
    };

    window.addEventListener('resize', handleResize);

    // 清理
    return () => {
      window.removeEventListener('resize', handleResize);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (rendererRef.current && container.contains(rendererRef.current.domElement)) {
        container.removeChild(rendererRef.current.domElement);
      }
      rendererRef.current?.dispose();
      rainGeometry.dispose();
      rainMaterial.dispose();
      cloudParticles.forEach((cloud) => {
        cloud.geometry.dispose();
        if (Array.isArray(cloud.material)) {
          cloud.material.forEach((m) => m.dispose());
        } else {
          cloud.material.dispose();
        }
      });
    };
  }, [opacity, rainCount, cloudCount, rainSpeed]);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 0,
      }}
    />
  );
};
