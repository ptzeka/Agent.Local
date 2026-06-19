import { cpSync, rmSync } from "node:fs";

// mount() serves /static and /public from beside whichever bundle loads it (see mount.tsx), and there are
// two such bundles: dist/server/mount.js (host-imported) and publish/index.cjs (standalone). Copy the client
// output + loader assets next to BOTH here as an explicit post-build step rather than an in-compiler CopyPlugin
// glob — globbing dist/static while the client compiler's clean:true rewrites it raced, nesting manifest.json
// and 404'ing the bootstrap loader. Running after webpack fully settles makes the source stable, so it is
// deterministic. index.html is copied per-bundle by webpack (single source file, no race).
const here = new URL("./", import.meta.url);

const replace = (from, to) => {
  rmSync(new URL(to, here), { recursive: true, force: true });
  cpSync(new URL(from, here), new URL(to, here), { recursive: true });
};

for (const dest of ["dist/server", "publish"]) {
  replace("./dist/static", `./${dest}/static`);
  replace("./src/public", `./${dest}/public`);
}
