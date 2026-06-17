import express, { type RequestHandler } from "express";

// serves the client bundles (dist/static, copied beside the server bundle as static/) with long-lived
// immutable caching. The caller passes the resolved directory because it knows the bundle's own location.
export function staticAssetsMiddleware(staticDir: string): RequestHandler {
  return express.static(staticDir, { maxAge: "1y", immutable: true });
}
