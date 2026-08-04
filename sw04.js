var CACHE_NAME = 'fenix-ativos-v1';

self.addEventListener('install', function(e){
  self.skipWaiting();
});

self.addEventListener('activate', function(e){
  self.clients.claim();
});

self.addEventListener('fetch', function(e){
  if(e.request.method !== 'GET') return;
  e.respondWith(
    caches.open(CACHE_NAME).then(function(cache){
      return fetch(e.request).then(function(resp){
        if(resp && resp.status === 200){ cache.put(e.request, resp.clone()); }
        return resp;
      }).catch(function(){ return cache.match(e.request); });
    })
  );
});
