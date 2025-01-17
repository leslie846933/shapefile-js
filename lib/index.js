'use strict';
let proj4 = require('proj4');
if (proj4.default) {
  proj4 = proj4.default;
}
const unzip = require('./unzip');
const binaryAjax = require('./binaryajax');
const parseShp = require('./parseShp');
const epsg = require('./epsg');
const projection = require('./projection');
const parseDbf = require('parsedbf');
const Promise = require('lie');
const Cache = require('lru-cache');
const Buffer = require('buffer').Buffer;
const URL = global.URL;

const cache = new Cache({
  max: 20
});

function toBuffer (b) {
  if (!b) {
    throw new Error('forgot to pass buffer');
  }
  if (Buffer.isBuffer(b)) {
    return b;
  }
  if (b instanceof global.ArrayBuffer) {
    return Buffer.from(b);
  }
  if (b.buffer instanceof global.ArrayBuffer) {
    if (b.BYTES_PER_ELEMENT === 1) {
      return Buffer.from(b);
    }
    return Buffer.from(b.buffer);
  }
}

function getPrj (wkid) {
  if (!wkid) return null;
  proj4.defs(`EPSG:${wkid}`, epsg[wkid]);
  return proj4(`EPSG:${wkid}`);
}

function conversionPrj (prj) {
  if (!prj) return null;
  let fileWkid = null;
  for (let i = 0, len = projection.length; i < len; i++) {
    const { wkid, value } = projection[i];
    value.forEach((d) => {
      if (prj.toString().indexOf(d) > -1) {
        fileWkid = wkid;
      }
    });
    if (fileWkid) break;
  }
  return fileWkid ? getPrj(fileWkid) : null;
}

function shp (props) {
  const { base, whiteList, epsg } = props;
  if (typeof base === 'string' && cache.has(base)) {
    return Promise.resolve(cache.get(base));
  }
  return shp.getShapefile(base, whiteList, epsg).then(function (resp) {
    if (typeof base === 'string') {
      cache.set(base, resp);
    }
    return resp;
  });
}
shp.combine = function (arr) {
  const out = {};
  out.type = 'FeatureCollection';
  out.features = [];
  let i = 0;
  const len = arr[0].length;
  while (i < len) {
    out.features.push({
      type: 'Feature',
      geometry: arr[0][i],
      properties: arr[1][i]
    });
    i++;
  }
  return out;
};
shp.parseZip = async function (buffer, whiteList, epsg) {
  let key;
  buffer = toBuffer(buffer);
  const zip = await unzip(buffer);
  const names = [];
  whiteList = whiteList || [];
  for (key in zip) {
    if (key.indexOf('__MACOSX') !== -1) {
      continue;
    }
    if (key.slice(-3).toLowerCase() === 'shp') {
      names.push(key.slice(0, -4));
      zip[key.slice(0, -3) + key.slice(-3).toLowerCase()] = zip[key];
    } else if (key.slice(-3).toLowerCase() === 'prj') {
      zip[key.slice(0, -3) + key.slice(-3).toLowerCase()] = getPrj(epsg) || conversionPrj(zip[key]) || proj4(zip[key]);
    } else if (key.slice(-4).toLowerCase() === 'json' || whiteList.indexOf(key.split('.').pop()) > -1) {
      names.push(key.slice(0, -3) + key.slice(-3).toLowerCase());
    } else if (key.slice(-3).toLowerCase() === 'dbf' || key.slice(-3).toLowerCase() === 'cpg') {
      zip[key.slice(0, -3) + key.slice(-3).toLowerCase()] = zip[key];
    }
  }
  if (!names.length) {
    throw new Error('no layers founds');
  }
  const geojson = names.map(function (name) {
    let parsed, dbf;
    const lastDotIdx = name.lastIndexOf('.');
    if (lastDotIdx > -1 && name.slice(lastDotIdx).indexOf('json') > -1) {
      parsed = JSON.parse(zip[name]);
      parsed.fileName = name.slice(0, lastDotIdx);
    } else if (whiteList.indexOf(name.slice(lastDotIdx + 1)) > -1) {
      parsed = zip[name];
      parsed.fileName = name;
    } else {
      if (zip[name + '.dbf']) {
        dbf = parseDbf(zip[name + '.dbf'], zip[name + '.cpg']);
      }
      parsed = shp.combine([parseShp(zip[name + '.shp'], zip[name + '.prj']), dbf]);
      parsed.fileName = name;
    }
    return parsed;
  });
  if (geojson.length === 1) {
    return geojson[0];
  } else {
    return geojson;
  }
};

async function getZip (base, whiteList, epsg) {
  const a = await binaryAjax(base);
  return shp.parseZip(a, whiteList, epsg);
}
const handleShp = async (base) => {
  const args = await Promise.all([
    binaryAjax(base, 'shp'),
    binaryAjax(base, 'prj')
  ]);
  let prj = false;
  try {
    if (args[1]) {
      prj = proj4(args[1]);
    }
  } catch (e) {
    prj = false;
  }
  return parseShp(args[0], prj);
};
const handleDbf = async (base) => {
  const [dbf, cpg] = await Promise.all([
    binaryAjax(base, 'dbf'),
    binaryAjax(base, 'cpg')
  ]);
  return parseDbf(dbf, cpg);
};
const checkSuffix = (base, suffix) => {
  const url = new URL(base);
  return url.pathname.slice(-4).toLowerCase() === suffix;
};
shp.getShapefile = async function (base, whiteList, epsg) {
  if (typeof base !== 'string') {
    return shp.parseZip(base, whiteList, epsg);
  }
  if (checkSuffix(base, '.zip')) {
    return getZip(base, whiteList, epsg);
  }
  const results = await Promise.all([
    handleShp(base),
    handleDbf(base)
  ]);
  return shp.combine(results);
};
shp.parseShp = function (shp, prj) {
  shp = toBuffer(shp);
  if (Buffer.isBuffer(prj)) {
    prj = prj.toString();
  }
  if (typeof prj === 'string') {
    try {
      prj = proj4(prj);
    } catch (e) {
      prj = false;
    }
  }
  return parseShp(shp, prj);
};
shp.parseDbf = function (dbf, cpg) {
  dbf = toBuffer(dbf);
  return parseDbf(dbf, cpg);
};
module.exports = shp;
