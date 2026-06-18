// runtime asset loader, ported from the sandbox frontend. Served as a static /public file and loaded
// before the SSR bundle so window.__loadManifest__ exists; it fetches the hashed manifest.json and
// injects the vendors + entry bundles by their content-hashed names (cache-busting without a fixed src).
window.__loadedAssets__ = window.__loadedAssets__ || [];
window.__loadAssets__ = window.__loadAssets__ || function (asset, callback) {
  if (window.__loadedAssets__.indexOf(asset) >= 0) {
    if (typeof callback === "function") { callback(); return; }
  }
  window.__loadedAssets__.push(asset);
  if (asset.match(/\.js$/)) {
    var script = document.createElement("script");
    script.type = "text/javascript";
    script.async = true;
    script.defer = true;
    if (typeof callback === "function") script.onload = callback;
    script.src = asset;
    script.crossOrigin = "anonymous";
    document.head.appendChild(script);
  } else if (asset.match(/\.css$/)) {
    var style = document.createElement("link");
    style.rel = "stylesheet";
    style.type = "text/css";
    style.href = asset;
    document.head.appendChild(style);
  }
};
window.__loadManifest__ = window.__loadManifest__ || function (manifestUrl, entry, callback) {
  if (manifestUrl.indexOf(".json") !== manifestUrl.length - 5) return;
  var host = "";
  var isRelative = manifestUrl[0] === "/";
  if (!isRelative) {
    var url = new URL(manifestUrl);
    host = url.protocol + "//" + url.host;
  }
  var xhr = new XMLHttpRequest();
  // cache-bust the manifest itself so a fresh deploy's hashed bundles are picked up immediately
  xhr.open("GET", manifestUrl + "?cb=" + Math.floor(Date.now() / 1000));
  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4) return;
    if (xhr.status !== 200) throw new Error("Received non-OK status when loading entrypoints");
    var manifest = JSON.parse(xhr.responseText);
    if (!window["__manifest__"]) window["__manifest__"] = {};
    Object.keys(manifest).forEach(function (key) {
      var src = host + manifest[key];
      window["__manifest__"][key] = src;
      // vendors must be injected alongside the entry; the entry chunk carries the webpack runtime
      if (key.indexOf("vendors") === 0) window.__loadAssets__(src);
      if (key.indexOf(entry) === 0) window.__loadAssets__(src, callback);
    });
  };
  xhr.send(null);
};
