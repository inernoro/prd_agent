import scenes from './loading-scenes.json';

/** 路由登记同时驱动实际等待轮廓、外壳几何和维护清单。 */
export function loadingSceneForPath(pathname: string): typeof scenes[number] | undefined {
  const segments = pathname.replace(/\/+$/, '').split('/');
  return scenes.find(scene => {
    const pattern = scene.route.split('/');
    return pattern.length === segments.length && pattern.every((part, i) => part.startsWith(':') ? Boolean(segments[i]) : part === segments[i]);
  });
}
