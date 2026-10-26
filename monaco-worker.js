// Same-origin bootstrap for Monaco's editor worker (works under cross-origin isolation).
self.MonacoEnvironment = { baseUrl: new URL('vendor/monaco/', self.location.href).href };
importScripts('vendor/monaco/vs/base/worker/workerMain.js');
