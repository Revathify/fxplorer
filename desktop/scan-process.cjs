'use strict';
const scan = require('./scan-core.cjs');
const data = JSON.parse(process.argv[2]);
scan(data.path, { maxEntries: data.maxEntries, retainDepth: data.retainDepth, cacheDirectory: data.cacheDirectory, onProgress: progress => process.parentPort.postMessage({ type: 'progress', data: progress }) })
  .then(result => process.parentPort.postMessage({ type: 'result', data: result }))
  .catch(error => process.parentPort.postMessage({ type: 'error', error: { message: error.message, code: error.code } }));
