'use strict';
const { parentPort, workerData } = require('node:worker_threads');

try {
  const ends = [];
  for (const match of workerData.text.matchAll(new RegExp(workerData.pattern, 'gu'))) {
    if (!match[0].length || ends.length >= 10000) throw new Error();
    ends.push(match.index + match[0].length);
  }
  parentPort.postMessage({ ends });
} catch {
  parentPort.postMessage({ error: 'Invalid delimiter or too many delimiters' });
}
