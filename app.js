/* =========================================================================
   คุยกับ AI — ออนไลน์ก็ได้ ออฟไลน์ก็ได้
   ทุกอย่างเก็บไว้ในเครื่องก่อนเสมอ (IndexedDB) แล้วซิงก์ขึ้น Google Sheets
   เมื่อมีอินเทอร์เน็ต
   ========================================================================= */

// ---------------------------------------------------------------------
// 1) ค่าคงที่ที่แก้ไขได้ — ใส่ URL ของ Apps Script ที่ deploy แล้วตรงนี้
//    เพื่อไม่ต้องกรอกใหม่ทุกเครื่อง/ทุกเบราว์เซอร์
// ---------------------------------------------------------------------
const DEFAULT_SCRIPT_URL = ""; // เช่น "https://script.google.com/macros/s/XXXXXXXX/exec"
const SYNC_TOKEN = "change-this-token"; // ต้องตรงกับ SYNC_TOKEN ใน Code.gs

// โมเดลออฟไลน์ (WebLLM) — เล็ก โหลดไว สนทนาไทยได้ในระดับพื้นฐาน
const LOCAL_MODEL_ID = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";

// ผู้ดูแลระบบคนเดียว: เก็บเป็น SHA-256("username:password") ไม่เก็บ plaintext
// ค่าเริ่มต้นนี้คือแฮชของ meen:5340 — เปลี่ยนได้ด้วยฟังก์ชัน hashCredential() ด้านล่าง (ดู README)
const ADMIN_CRED_HASH = "a4d4cf2ab9ee20df6d658b52ca8d04ebe97709ce233640ab50a56f8ef9a6f96";

// ---------------------------------------------------------------------
// 2) Utilities
// ---------------------------------------------------------------------
async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

function nowThai() {
  return new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "short", timeStyle: "short" });
}

function $(id) { return document.getElementById(id); }

// ---------------------------------------------------------------------
// 3) IndexedDB — เก็บข้อความทั้งหมดไว้ในเครื่องเสมอ ไม่ว่าจะออนไลน์หรือไม่
// ---------------------------------------------------------------------
const DB_NAME = "offline-ai-chat";
const STORE = "messages";
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("synced", "synced");
        store.createIndex("ts", "ts");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function dbAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.ts - b.ts));
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(msg) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(msg);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbUnsynced() {
  const all = await dbAll();
  return all.filter(m => !m.synced);
}

// ---------------------------------------------------------------------
// 4) สถานะแอป
// ---------------------------------------------------------------------
const state = {
  loggedIn: false,
  online: navigator.onLine,
  engineMode: localStorage.getItem("engineMode") || "auto", // auto | cloud | local
  apiKey: localStorage.getItem("geminiApiKey") || "",
  scriptUrl: localStorage.getItem("scriptUrl") || DEFAULT_SCRIPT_URL,
  localReady: false,
  localLoading: false,
  localEngine: null,
};

// ---------------------------------------------------------------------
// 5) เข้าสู่ระบบ (ผู้ดูแลระบบคนเดียว เข้าครั้งเดียวแล้วจำไว้ในเครื่อง)
// ---------------------------------------------------------------------
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const user = $("loginUser").value.trim();
  const pass = $("loginPass").value;
  const hash = await sha256(`${user}:${pass}`);
  if (hash === ADMIN_CRED_HASH) {
    localStorage.setItem("session", "1");
    enterApp();
  } else {
    $("loginError").hidden = false;
  }
});

$("logoutBtn").addEventListener("click", () => {
  localStorage.removeItem("session");
  location.reload();
});

function enterApp() {
  $("loginScreen").hidden = true;
  $("appShell").hidden = false;
  state.loggedIn = true;
  $("apiKeyInput").value = state.apiKey;
  $("scriptUrlInput").value = state.scriptUrl;
  $("engineSelect").value = state.engineMode;
  initChat();
}

if (localStorage.getItem("session") === "1") enterApp();

// ---------------------------------------------------------------------
// 6) แผงตั้งค่า
// ---------------------------------------------------------------------
$("menuBtn").addEventListener("click", () => {
  $("panel").hidden = !$("panel").hidden;
});

$("saveSettingsBtn").addEventListener("click", () => {
  state.apiKey = $("apiKeyInput").value.trim();
  state.scriptUrl = $("scriptUrlInput").value.trim() || DEFAULT_SCRIPT_URL;
  state.engineMode = $("engineSelect").value;
  localStorage.setItem("geminiApiKey", state.apiKey);
  localStorage.setItem("scriptUrl", state.scriptUrl);
  localStorage.setItem("engineMode", state.engineMode);
  $("panel").hidden = true;
  updateStatusPill();
});

$("loadLocalBtn").addEventListener("click", loadLocalModel);

// ---------------------------------------------------------------------
// 7) สถานะออนไลน์/ออฟไลน์
// ---------------------------------------------------------------------
function updateStatusPill() {
  const pill = $("statusPill");
  const label = $("statusLabel");
  pill.classList.remove("is-online", "is-offline");
  if (state.online) {
    pill.classList.add("is-online");
    label.textContent = state.apiKey ? "ออนไลน์ · โมเดลคลาวด์" : "ออนไลน์ · ยังไม่ตั้ง API key";
  } else {
    pill.classList.add("is-offline");
    label.textContent = state.localReady ? "ออฟไลน์ · โมเดลในเครื่อง" : "ออฟไลน์ · ยังไม่โหลดโมเดล";
  }
}

window.addEventListener("online", () => { state.online = true; updateStatusPill(); syncNow(); });
window.addEventListener("offline", () => { state.online = false; updateStatusPill(); });

// ---------------------------------------------------------------------
// 8) โมเดลออฟไลน์ (WebLLM) — โหลดครั้งแรกตอนมีเน็ต ใช้ซ้ำได้ตอนไม่มีเน็ต
//    (ไฟล์โมเดลถูกแคชไว้โดยเบราว์เซอร์ผ่าน Cache Storage API ของ WebLLM เอง)
// ---------------------------------------------------------------------
async function loadLocalModel() {
  if (state.localLoading || state.localReady) return;
  if (!("gpu" in navigator)) {
    $("localModelHint").textContent = "เบราว์เซอร์นี้ไม่รองรับ WebGPU จึงใช้โหมดออฟไลน์ไม่ได้";
    return;
  }
  state.localLoading = true;
  $("loadLocalBtn").disabled = true;
  $("localProgressWrap").hidden = false;

  try {
    const webllm = await import("https://esm.run/@mlc-ai/web-llm");
    const engine = new webllm.MLCEngine();
    engine.setInitProgressCallback((report) => {
      const pct = Math.round((report.progress || 0) * 100);
      $("localProgressBar").style.width = pct + "%";
      $("localModelHint").textContent = report.text || `กำลังโหลด… ${pct}%`;
    });
    await engine.reload(LOCAL_MODEL_ID);
    state.localEngine = engine;
    state.localReady = true;
    $("localModelHint").textContent = "พร้อมใช้งานแบบออฟไลน์แล้ว";
    $("loadLocalBtn").textContent = "โหลดแล้ว";
  } catch (err) {
    console.error(err);
    $("localModelHint").textContent = "โหลดโมเดลไม่สำเร็จ: " + err.message;
    $("loadLocalBtn").disabled = false;
  } finally {
    state.localLoading = false;
    updateStatusPill();
  }
}

async function askLocalModel(history) {
  if (!state.localReady) throw new Error("ยังไม่ได้โหลดโมเดลในเครื่อง");
  const reply = await state.localEngine.chat.completions.create({
    messages: [
      { role: "system", content: "คุณคือผู้ช่วย AI ที่ตอบเป็นภาษาไทยอย่างกระชับและสุภาพ" },
      ...history,
    ],
  });
  return reply.choices[0].message.content;
}

// ---------------------------------------------------------------------
// 9) โมเดลคลาวด์ (Gemini — มี free tier ผ่าน Google AI Studio)
// ---------------------------------------------------------------------
async function askCloudModel(history) {
  if (!state.apiKey) throw new Error("ยังไม่ได้ตั้งค่า Gemini API key");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${state.apiKey}`;
  const contents = history.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents }),
  });
  if (!res.ok) throw new Error("เรียก Gemini ไม่สำเร็จ (" + res.status + ")");
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "(ไม่มีคำตอบ)";
}

// ---------------------------------------------------------------------
// 10) แชท: ส่งข้อความ, เลือกเอนจิน, เรนเดอร์, บันทึกลง IndexedDB เสมอ
// ---------------------------------------------------------------------
let renderedMessages = [];

async function initChat() {
  updateStatusPill();
  renderedMessages = await dbAll();
  renderAll();
  if (state.online) syncNow();
  document.body.addEventListener("input", autoGrow, true);
}

function autoGrow(e) {
  if (e.target.id !== "messageInput") return;
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight, 140) + "px";
}

function renderAll() {
  const log = $("chatLog");
  log.innerHTML = "";
  $("emptyState").classList.toggle("show", renderedMessages.length === 0);
  for (const m of renderedMessages) renderMessage(m);
  log.scrollTop = log.scrollHeight;
}

function renderMessage(m) {
  const log = $("chatLog");
  const div = document.createElement("div");
  div.className = "msg " + (m.role === "user" ? "msg-user" : "msg-assistant") + (m.pending ? " msg-pending" : "");
  div.dataset.id = m.id;
  const sourceBadge = m.role === "assistant"
    ? `<span class="msg-source ${m.source === "local" ? "local" : "cloud"}">${m.source === "local" ? "ในเครื่อง" : "คลาวด์"}</span>`
    : "";
  div.innerHTML = `${escapeHtml(m.content)}<span class="msg-meta">${m.timeLabel || nowThai()}${sourceBadge}</span>`;
  log.appendChild(div);
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("messageInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.style.height = "auto";

  const userMsg = { id: uuid(), role: "user", content: text, ts: Date.now(), timeLabel: nowThai(), synced: false };
  renderedMessages.push(userMsg);
  renderAll();
  await dbPut(userMsg);

  const useLocal =
    state.engineMode === "local" ||
    (state.engineMode === "auto" && !state.online);

  const pending = { id: uuid(), role: "assistant", content: "กำลังพิมพ์…", ts: Date.now(), timeLabel: nowThai(), synced: false, pending: true, source: useLocal ? "local" : "cloud" };
  renderedMessages.push(pending);
  renderAll();

  const history = renderedMessages
    .filter(m => !m.pending)
    .slice(-12)
    .map(m => ({ role: m.role, content: m.content }));

  try {
    const replyText = useLocal ? await askLocalModel(history) : await askCloudModel(history);
    pending.content = replyText;
    pending.pending = false;
  } catch (err) {
    pending.content = "ตอบไม่สำเร็จ: " + err.message + (useLocal ? "" : " (ลองสลับเป็นโหมดในเครื่องถ้าไม่มีเน็ต)");
    pending.pending = false;
  }
  renderAll();
  await dbPut(pending);

  if (state.online) syncNow();
});

// ---------------------------------------------------------------------
// 11) ซิงก์กับ Google Sheets ผ่าน Apps Script — เกิดขึ้นเฉพาะตอนออนไลน์
// ---------------------------------------------------------------------
let syncing = false;

async function syncNow() {
  if (syncing || !state.scriptUrl) return;
  syncing = true;
  try {
    // 1) ดึงข้อความที่มีบนคลาวด์มารวม (bootstrap เดียวจบ)
    const bootRes = await fetch(state.scriptUrl + "?action=bootstrap&token=" + encodeURIComponent(SYNC_TOKEN));
    if (bootRes.ok) {
      const remote = await bootRes.json();
      const localIds = new Set(renderedMessages.map(m => m.id));
      for (const r of remote.messages || []) {
        if (!localIds.has(r.id)) {
          const merged = { ...r, synced: true };
          await dbPut(merged);
          renderedMessages.push(merged);
        }
      }
      renderedMessages.sort((a, b) => a.ts - b.ts);
      renderAll();
    }

    // 2) ส่งข้อความที่ยังไม่ได้ซิงก์ขึ้นไป
    const unsynced = await dbUnsynced();
    for (const m of unsynced) {
      if (m.pending) continue; // อย่าซิงก์ข้อความที่ยังตอบไม่เสร็จ
      await fetch(state.scriptUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain" }, // เลี่ยง CORS preflight ของ Apps Script
        body: JSON.stringify({ action: "addMessage", token: SYNC_TOKEN, message: m }),
      });
      m.synced = true;
      await dbPut(m);
    }
  } catch (err) {
    console.warn("ซิงก์ไม่สำเร็จ ลองใหม่รอบหน้า:", err.message);
  } finally {
    syncing = false;
  }
}

// ---------------------------------------------------------------------
// 12) ลงทะเบียน Service Worker เพื่อให้เปิดแอปได้แม้ไม่มีเน็ต
// ---------------------------------------------------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(err => console.warn("SW register failed", err));
  });
}
