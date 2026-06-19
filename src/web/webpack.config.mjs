import path from "path";
import { fileURLToPath } from "url";
import webpack from "webpack";
import nodeExternals from "webpack-node-externals";
import CopyPlugin from "copy-webpack-plugin";
import MiniCssExtractPlugin from "mini-css-extract-plugin";
import { WebpackManifestPlugin } from "webpack-manifest-plugin";

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

  // non-JS assets become empty modules in the node bundles so an isomorphic component that imports
  // css/images doesn't break the server/mount build (the client config handles them for real)
  const assetIgnoreRule = {
    test: /\.(css|svg|jpg|jpeg|png|gif|mp3)$/,
    use: path.join(__dirname, "empty-loader.cjs"),
    exclude: [/node_modules/],
  };

  // extensionAlias lets webpack resolve the TS-ESM ".js" import specifiers (e.g. "./mount.js") to their
  // .ts/.tsx sources; without it the node bundles fail since the on-disk files are .ts/.tsx
  const resolve = {
    extensions: [".js", ".jsx", ".json", ".tsx", ".ts"],
    extensionAlias: { ".js": [".ts", ".tsx", ".js"], ".jsx": [".tsx", ".jsx"] },
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
    resolve,
    stats: "minimal",
    module: {
      rules: [
        babelRule,
        { test: /\.css$/, use: [MiniCssExtractPlugin.loader, "css-loader"], exclude: [/node_modules/] },
      ],
    },
    plugins: [
      new MiniCssExtractPlugin({ filename: "[name].css", chunkFilename: "[id].css" }),
      // emits manifest.json (logical name -> hashed file) keyed by /static so the runtime loader can
      // resolve the content-hashed vendors/app bundles named by webpack.dev/prod
      new WebpackManifestPlugin({ publicPath: "/static" }),
    ],
    // the vendors chunk exceeds webpack's 244 KiB hint by design; size is managed via splitChunks, not hints
    performance: { hints: false },
    // split node_modules into a cacheable vendors chunk; the runtime loader injects it before the entry
    optimization: {
      splitChunks: {
        chunks: "all",
        cacheGroups: {
          defaultVendors: {
            test: /[\\/]node_modules[\\/]/,
            name: "vendors",
            priority: -10,
            reuseExistingChunk: true,
          },
          default: { minChunks: 4, priority: -20, reuseExistingChunk: true },
        },
      },
    },
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
    resolve,
    // webpack bakes import.meta.url to the source path in a CJS bundle, so resolve assets from the real
    // runtime __filename instead (node:false keeps webpack from mocking it)
    node: { __dirname: false, __filename: false },
    module: { rules: [babelRule, assetIgnoreRule] },
    plugins: [
      new webpack.DefinePlugin({ __MODULE_URL__: "require('url').pathToFileURL(__filename).href" }),
      // ssr_render reads index.html next to the bundle; copy just that single source file here. The /static
      // and /public asset trees are copied into publish/ by the copy-publish.mjs post-build step, NOT an
      // in-compiler glob — globbing the concurrently-cleaned dist/static raced and nested manifest.json.
      new CopyPlugin({
        patterns: [
          { from: path.join(__dirname, "src/server/index.html"), to: path.join(__dirname, "publish/index.html") },
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
    resolve,
    stats: "minimal",
    module: { rules: [babelRule, assetIgnoreRule] },
    plugins: [
      // ESM output resolves import.meta.url genuinely at runtime, so the shared token maps straight to it
      new webpack.DefinePlugin({ __MODULE_URL__: "import.meta.url" }),
      new CopyPlugin({
        patterns: [
          // /static and /public are copied beside this bundle by the copy-assets.mjs post-build step, NOT an
          // in-compiler glob — globbing the concurrently-cleaned dist/static raced and nested manifest.json.
          // only index.html is copied here: a single source file (no race), read by ssr_render from __dirname.
          { from: path.join(__dirname, "src/server/index.html"), to: path.join(__dirname, "dist/server/index.html") },
        ],
      }),
    ],
  };

  return [clientConfig, serverConfig, mountConfig];
}
