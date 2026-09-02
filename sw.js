// เวอร์ชันแคช — เปลี่ยนเลขนี้ทุกครั้งที่แก้ไฟล์ static เพื่อบังคับให้เบราว์เซอร์ดึงของใหม่
const CACHE_NAME = "offline-ai-chat-v2";

const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// กลยุทธ์: cache-first สำหรับไฟล์ของแอปเอง, ปล่อยผ่านเน็ตตามปกติสำหรับ
// การเรียก API (Gemini / Apps Script / โมเดล WebLLM) เพื่อไม่ให้ข้อมูลค้าง
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isOwnAsset = url.origin === location.origin;

  if (!isOwnAsset) return; // ปล่อยให้ fetch ปกติจัดการ (เน็ตหรือ error ตามจริง)

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match("./index.html"));
    })
  );
});
