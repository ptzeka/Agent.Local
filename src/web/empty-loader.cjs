// returns an empty module for non-JS asset imports (css/images/svg) in the node SSR bundles, so an
// isomorphic component that imports styles or assets does not break the server/mount builds.
module.exports = function () {
  return "module.exports = {};";
};
