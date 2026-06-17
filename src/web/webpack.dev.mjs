import { merge } from "webpack-merge";
import config from "./webpack.config.mjs";

const [clientConfig, serverConfig, mountConfig] = config();

const dev = { mode: "development", devtool: "inline-source-map", watchOptions: { poll: 1000, ignored: /node_modules/ } };

export default [
  merge(clientConfig, dev),
  merge(serverConfig, dev),
  merge(mountConfig, dev),
];
