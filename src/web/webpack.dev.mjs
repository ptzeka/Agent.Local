import path from "path";
import { fileURLToPath } from "url";
import { merge } from "webpack-merge";
import CopyPlugin from "copy-webpack-plugin";
import config from "./webpack.config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [clientConfig, serverConfig, mountConfig] = config();

const dev = { mode: "development", devtool: "inline-source-map", watchOptions: { poll: 1000, ignored: /node_modules/ } };

// watch mode has no post-build step, so keep /static and /public fresh beside BOTH bundles (dist/server for
// the host-imported mount, publish for the standalone) via an in-compiler copy here. prod does this
// deterministically in copy-assets.mjs instead; in watch the client rebuilds first so the glob is populated.
const bundleAssets = {
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: path.join(__dirname, "dist/static"), to: path.join(__dirname, "dist/server/static") },
        { from: path.join(__dirname, "src/public"), to: path.join(__dirname, "dist/server/public") },
        { from: path.join(__dirname, "dist/static"), to: path.join(__dirname, "publish/static") },
        { from: path.join(__dirname, "src/public"), to: path.join(__dirname, "publish/public") },
      ],
    }),
  ],
};

// hash client bundle filenames even in dev so the manifest-driven loader exercises the same
// cache-busting path as prod (the manifest keys stay stable; only the emitted file names change)
const clientHash = { output: { filename: "[name].[fullhash].js", chunkFilename: "[name].[chunkhash].js" } };

export default [
  merge(clientConfig, dev, clientHash),
  merge(serverConfig, dev, bundleAssets),
  merge(mountConfig, dev),
];
