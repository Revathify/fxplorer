'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const scan = require('./scan-core.cjs');
scan(workerData.path, { maxEntries: workerData.maxEntries, retainDepth: workerData.retainDepth, cacheDirectory: workerData.cacheDirectory, onProgress: data => parentPort.postMessage({ type: 'progress', data }) })
  .then(data => parentPort.postMessage({ type: 'result', data }))
  .catch(error => parentPort.postMessage({ type: 'error', error: { message: error.message, code: error.code } }));
