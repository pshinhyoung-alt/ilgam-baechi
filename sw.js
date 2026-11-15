/* 일잡코리아 인력배치 - 앱 설치용 서비스 워커
   화면·데이터는 저장하지 않고 항상 그대로 인터넷에서 받아 옵니다. (옛 화면이 남아 헷갈리는 일을 막기 위해)
   앱으로 설치할 수 있게 하는 역할만 합니다. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* 아무것도 가로채지 않음 */ });
