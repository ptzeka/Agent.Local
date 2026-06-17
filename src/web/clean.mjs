import { rmSync } from "node:fs";

// remove both bundle outputs so a build/clean starts from a known-empty tree
for (const dir of ["dist", "publish"]) {
  rmSync(new URL(`./${dir}`, import.meta.url), { recursive: true, force: true });
}
