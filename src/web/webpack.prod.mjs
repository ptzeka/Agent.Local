import { merge } from "webpack-merge";
import config from "./webpack.config.mjs";

const [clientConfig, serverConfig, mountConfig] = config();

export default [
  merge(clientConfig, { mode: "production" }),
  merge(serverConfig, { mode: "production" }),
  merge(mountConfig, { mode: "production" }),
];
