import { merge } from "webpack-merge";
import config from "./webpack.config.mjs";

const [clientConfig, serverConfig, mountConfig] = config();

// content-hashed client filenames for long-lived immutable caching; the manifest maps logical
// names to these so the loader always resolves the current build
const clientHash = { output: { filename: "[name].[fullhash].js", chunkFilename: "[name].[chunkhash].js" } };

export default [
  merge(clientConfig, { mode: "production" }, clientHash),
  merge(serverConfig, { mode: "production" }),
  merge(mountConfig, { mode: "production" }),
];
