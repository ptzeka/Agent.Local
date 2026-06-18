import { merge } from "webpack-merge";
import config from "./webpack.config.mjs";

const [clientConfig, serverConfig, mountConfig] = config();

const dev = { mode: "development", devtool: "inline-source-map", watchOptions: { poll: 1000, ignored: /node_modules/ } };

// hash client bundle filenames even in dev so the manifest-driven loader exercises the same
// cache-busting path as prod (the manifest keys stay stable; only the emitted file names change)
const clientHash = { output: { filename: "[name].[fullhash].js", chunkFilename: "[name].[chunkhash].js" } };

export default [
  merge(clientConfig, dev, clientHash),
  merge(serverConfig, dev),
  merge(mountConfig, dev),
];
