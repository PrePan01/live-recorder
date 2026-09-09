/** Route module loaders are shared by React.lazy and sidebar intent prefetch. */
const loaders = {
  '/rooms': () => import('../pages/Rooms'),
  '/history': () => import('../pages/History'),
  '/settings': () => import('../pages/Settings'),
  '/recovery': () => import('../pages/Recovery'),
  '/stats': () => import('../pages/Stats'),
  '/wall': () => import('../pages/Wall'),
} as const;

export type LazyRoutePath = keyof typeof loaders;
export const LAZY_ROUTE_PATHS = Object.keys(loaders) as LazyRoutePath[];

export function loadRoute(path: LazyRoutePath) {
  return loaders[path]();
}

/** Start loading code as soon as navigation intent is visible, never on click. */
export function preloadRoute(path: string): void {
  const loader = loaders[path as LazyRoutePath];
  if (loader) void loader();
}
