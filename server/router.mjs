export function createRouter() {
  const routes = [];

  const register = (method, pattern, handler) => {
    routes.push({ method, pattern, handler });
    return router;
  };

  const router = {
    get: (pattern, handler) => register("GET", pattern, handler),
    post: (pattern, handler) => register("POST", pattern, handler),
    put: (pattern, handler) => register("PUT", pattern, handler),
    patch: (pattern, handler) => register("PATCH", pattern, handler),
    delete: (pattern, handler) => register("DELETE", pattern, handler),
    async dispatch(req, res, url, context) {
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const match = matchRoute(route.pattern, url.pathname);
        if (!match) continue;
        await route.handler(req, res, url, match, context);
        return true;
      }
      return false;
    },
  };

  return router;
}

function matchRoute(pattern, pathname) {
  if (typeof pattern === "string") return pattern === pathname ? [pathname] : null;
  pattern.lastIndex = 0;
  return pattern.exec(pathname);
}
