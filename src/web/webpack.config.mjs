import path from "path";
import { fileURLToPath } from "url";
import nodeExternals from "webpack-node-externals";
import CopyPlugin from "copy-webpack-plugin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// dual-bundle base, adapted from the Rxo.Platform.Web.Sandbox frontend:
// one browser bundle (dist/static) + one node SSR bundle (publish/index.js)
export default function () {
  const babelRule = {
    test: /\.(js|jsx|ts|tsx)$/,
    exclude: /node_modules/,
    use: "babel-loader",
  };

  const clientConfig = {
    name: "client",
    context: __dirname,
    entry: { app: ["./src/client/entry.tsx"] },
    output: {
      path: path.join(__dirname, "dist/static"),
      publicPath: "/static/",
      filename: "[name].js",
      chunkFilename: "[name].js",
      clean: true,
    },
    resolve: { extensions: [".js", ".jsx", ".json", ".tsx", ".ts"] },
    stats: "minimal",
    module: { rules: [babelRule] },
  };

  const serverConfig = {
    name: "server",
    // server reads dist/static at runtime, so the client bundle must build first
    dependencies: ["client"],
    context: __dirname,
    target: "node",
    externals: [nodeExternals()],
    entry: "./src/server/index.tsx",
    output: {
      // .cjs so Node loads this CommonJS bundle as CommonJS despite the package's "type":"module"
      // (it keeps node_modules external via nodeExternals and require()s them at runtime)
      path: path.join(__dirname, "publish"),
      filename: "index.cjs",
      module: false,
      clean: true,
    },
    resolve: { extensions: [".js", ".jsx", ".json", ".tsx", ".ts"] },
    module: { rules: [babelRule] },
    plugins: [
      // self-contained publish/: the SSR server serves browser bundles from publish/static (mount.tsx)
      new CopyPlugin({
        patterns: [
          { from: path.join(__dirname, "dist/static"), to: path.join(__dirname, "publish/static") },
        ],
      }),
    ],
  };

  // library bundle the host imports: exports `mount` as ESM (keeps import.meta.url for asset
  // resolution), node_modules stay external and load at runtime; client assets sit beside it
  const mountConfig = {
    name: "mount",
    dependencies: ["client"],
    context: __dirname,
    target: "node",
    externals: [nodeExternals({ importType: "module" })],
    experiments: { outputModule: true },
    entry: "./src/server/mount.tsx",
    output: {
      path: path.join(__dirname, "dist/server"),
      filename: "mount.js",
      library: { type: "module" },
      module: true,
      clean: true,
    },
    resolve: { extensions: [".js", ".jsx", ".json", ".tsx", ".ts"] },
    stats: "minimal",
    module: { rules: [babelRule] },
    plugins: [
      new CopyPlugin({
        patterns: [
          { from: path.join(__dirname, "dist/static"), to: path.join(__dirname, "dist/server/static") },
        ],
      }),
    ],
  };

  return [clientConfig, serverConfig, mountConfig];
}
