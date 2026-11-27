import { useCallback, useEffect, useState } from "react";

/**
 * The router: eight screens, so the History API and a few regular
 * expressions rather than a dependency. Lifted from Fellowship's router.ts.
 *
 * A call number is part of the path as it is written, slashes and all:
 * /memory/LIF/GTH/2026-12-24/001. The host serves index.html for every path
 * it does not own, so a deep link opens the right screen.
 */

export type Route =
  | { name: "library"; section: string | null; shelf: string | null }
  | { name: "memory"; call: string }
  | { name: "timeline" }
  | { name: "tags" }
  | { name: "review" }
  | { name: "recall" }
  | { name: "desk" }
  | { name: "settings" }
  | { name: "unknown"; path: string };

const CODE = "[A-Z]{3}";

export function parseRoute(path: string): Route {
  const clean = decodeURI(path).replace(/\/+$/, "") || "/";

  if (clean === "/" || clean === "/library") return { name: "library", section: null, shelf: null };
  if (clean === "/timeline") return { name: "timeline" };
  if (clean === "/tags") return { name: "tags" };
  if (clean === "/review") return { name: "review" };
  if (clean === "/recall") return { name: "recall" };
  if (clean === "/desk") return { name: "desk" };
  if (clean === "/settings") return { name: "settings" };

  const section = new RegExp(`^/library/(${CODE})$`).exec(clean);
  if (section) return { name: "library", section: section[1] as string, shelf: null };

  const shelf = new RegExp(`^/library/(${CODE})/(${CODE})$`).exec(clean);
  if (shelf) return { name: "library", section: shelf[1] as string, shelf: `${shelf[1]}/${shelf[2]}` };

  const memory = new RegExp(`^/memory/(${CODE}/${CODE}/\\d{4}-\\d{2}-\\d{2}/\\d{3})$`).exec(clean);
  if (memory) return { name: "memory", call: memory[1] as string };

  return { name: "unknown", path: clean };
}

export function hrefOf(route: Route): string {
  switch (route.name) {
    case "library":
      if (route.shelf) return `/library/${route.shelf}`;
      if (route.section) return `/library/${route.section}`;
      return "/";
    case "memory":
      return `/memory/${route.call}`;
    case "timeline":
      return "/timeline";
    case "tags":
      return "/tags";
    case "review":
      return "/review";
    case "recall":
      return "/recall";
    case "desk":
      return "/desk";
    case "settings":
      return "/settings";
    default:
      return route.path;
  }
}

export const memoryHref = (call: string): string => `/memory/${call}`;
export const shelfHref = (path: string): string => `/library/${path}`;

export function navigate(path: string): void {
  if (path === `${window.location.pathname}${window.location.search}`) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return parseRoute(path);
}

/** For an anchor that should navigate without a page load. */
export function useLinkHandler(): (event: React.MouseEvent<HTMLAnchorElement>) => void {
  return useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    const href = event.currentTarget.getAttribute("href");
    if (!href || !href.startsWith("/")) return;
    event.preventDefault();
    navigate(href);
  }, []);
}
