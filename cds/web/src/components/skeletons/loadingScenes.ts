import scenes from './loading-scenes.json';

/** 路由登记同时驱动实际等待轮廓、外壳几何和维护清单。 */
export function loadingSceneForPath(pathname: string): typeof scenes[number] | undefined {
  const segments = pathname.replace(/\/+$/, '').split('/');
  return scenes.find(scene => {
    const pattern = scene.route.split('/');
    const last = pattern[pattern.length - 1];
    const optionalLast = last.startsWith(':') && last.endsWith('?');
    const matchesLength = pattern.length === segments.length || optionalLast && pattern.length === segments.length + 1;
    return matchesLength && pattern.every((part, i) => part.startsWith(':')
      ? Boolean(segments[i]) || (optionalLast && i === pattern.length - 1)
      : part === segments[i]);
  });
}
