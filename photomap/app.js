"use strict";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const $ = (id) => document.getElementById(id);

// ---------- IndexedDB ----------
let db;
function openDB() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open("photomap", 1);
    rq.onupgradeneeded = () => {
      const d = rq.result;
      d.createObjectStore("drawings", { keyPath: "id", autoIncrement: true });
      d.createObjectStore("photos", { keyPath: "id", autoIncrement: true })
        .createIndex("drawingId", "drawingId");
    };
    rq.onsuccess = () => { db = rq.result; res(); };
    rq.onerror = () => rej(rq.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => res(r && r.result);
    t.onerror = () => rej(t.error);
  });
}
const dbAll = (s) => tx(s, "readonly", (o) => o.getAll());
const dbPut = (s, v) => tx(s, "readwrite", (o) => o.put(v));
const dbDel = (s, k) => tx(s, "readwrite", (o) => o.delete(k));
const photosOf = (did) => tx("photos", "readonly", (o) => o.index("drawingId").getAll(did));

// ---------- state ----------
const S = {
  d: null, pdf: null, page: 1, mode: "shoot", zoom: 1,
  sel: new Set(), hl: new Set(), photos: [],
};

function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.style.display = "block";
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.style.display = "none"), 2200);
}
function show(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("on", s.id === id));
}
function colName(c) {
  let s = ""; c++;
  while (c > 0) { s = String.fromCharCode(65 + ((c - 1) % 26)) + s; c = Math.floor((c - 1) / 26); }
  return s;
}
const cellName = (key) => { const [r, c] = key.split(",").map(Number); return colName(c) + (r + 1); };
const fmt = (ts) => new Date(ts).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

// ---------- home ----------
async function renderHome() {
  const ds = await dbAll("drawings");
  const ps = await dbAll("photos");
  const list = $("list");
  if (!ds.length) {
    list.innerHTML = '<div class="empty">図面がまだありません。<br>下のボタンからPDFを追加してください。</div>';
    return;
  }
  list.innerHTML = "";
  for (const d of ds) {
    const n = ps.filter((p) => p.drawingId === d.id).length;
    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = `<div class="t"><b></b><small>${d.cols}×${d.rows}マス ／ 写真${n}枚</small></div><button class="ghost del">削除</button>`;
    el.querySelector("b").textContent = d.name;
    el.querySelector(".t").onclick = () => openDrawing(d.id);
    el.querySelector(".del").onclick = async () => {
      if (!confirm(`「${d.name}」と写真${n}枚を削除します。よろしいですか？`)) return;
      for (const p of ps.filter((p) => p.drawingId === d.id)) await dbDel("photos", p.id);
      await dbDel("drawings", d.id);
      renderHome();
    };
    list.appendChild(el);
  }
}

$("pdfIn").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const pdf = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise;
    await dbPut("drawings", {
      name: f.name.replace(/\.pdf$/i, ""), blob: f, pages: pdf.numPages,
      cols: 8, rows: 6, created: Date.now(),
    });
    toast("追加しました");
    renderHome();
  } catch (err) {
    toast("PDFを読み込めませんでした");
    console.error(err);
  }
};

// ---------- drawing view ----------
async function openDrawing(id) {
  const ds = await dbAll("drawings");
  S.d = ds.find((d) => d.id === id);
  S.pdf = await pdfjsLib.getDocument({ data: await S.d.blob.arrayBuffer() }).promise;
  S.page = 1; S.zoom = 1; S.sel.clear(); S.hl.clear();
  S.photos = await photosOf(id);
  $("dTitle").textContent = S.d.name;
  $("gc").value = S.d.cols; $("gr").value = S.d.rows;
  setMode("shoot");
  show("draw");
  await renderPage();
}

async function renderPage() {
  const pg = await S.pdf.getPage(S.page);
  const base = pg.getViewport({ scale: 1 });
  const scale = Math.min(3000 / Math.max(base.width, base.height), 4);
  const vp = pg.getViewport({ scale });
  const cv = $("pg");
  cv.width = vp.width; cv.height = vp.height;
  await pg.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
  $("ov").width = vp.width; $("ov").height = vp.height;
  $("pInfo").textContent = `${S.page}/${S.d.pages}`;
  applyZoom();
  drawOverlay();
}

function applyZoom() {
  $("wrap").style.width = S.zoom * 100 + "%";
  $("ov").style.width = "100%"; $("ov").style.height = "100%";
}

function pagePhotos() { return S.photos.filter((p) => p.page === S.page); }
function cellCounts() {
  const m = new Map();
  for (const p of pagePhotos()) for (const k of p.cells) m.set(k, (m.get(k) || 0) + 1);
  return m;
}

function drawOverlay() {
  const cv = $("ov"), g = cv.getContext("2d");
  const { cols, rows } = S.d;
  const W = cv.width, H = cv.height, cw = W / cols, ch = H / rows;
  const fs = Math.max(12, Math.min(cw, ch) * 0.22);
  g.clearRect(0, 0, W, H);
  const counts = cellCounts();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const k = r + "," + c, x = c * cw, y = r * ch;
    if (counts.has(k)) { g.fillStyle = "rgba(22,163,74,.28)"; g.fillRect(x, y, cw, ch); }
    if (S.sel.has(k)) { g.fillStyle = "rgba(245,158,11,.5)"; g.fillRect(x, y, cw, ch); }
    if (S.hl.has(k)) { g.fillStyle = "rgba(220,38,38,.45)"; g.fillRect(x, y, cw, ch); }
    g.fillStyle = "rgba(0,0,0,.55)";
    g.font = `${fs}px sans-serif`; g.textBaseline = "top";
    g.fillText(colName(c) + (r + 1), x + fs * 0.3, y + fs * 0.2);
    if (counts.has(k)) {
      g.fillStyle = "#15803d"; g.font = `bold ${fs * 1.6}px sans-serif`;
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText("📷" + counts.get(k), x + cw / 2, y + ch / 2);
      g.textAlign = "left";
    }
  }
  g.strokeStyle = "rgba(37,99,235,.8)"; g.lineWidth = Math.max(2, W / 700);
  g.beginPath();
  for (let c = 0; c <= cols; c++) { g.moveTo(c * cw, 0); g.lineTo(c * cw, H); }
  for (let r = 0; r <= rows; r++) { g.moveTo(0, r * ch); g.lineTo(W, r * ch); }
  g.stroke();
  updateInfo();
}

function updateInfo() {
  const total = S.d.cols * S.d.rows, done = cellCounts().size;
  const selTxt = S.sel.size ? "選択: " + [...S.sel].map(cellName).join(",") : "マスをタップして選択";
  $("info").innerHTML = S.mode === "shoot"
    ? `${selTxt}<br>撮影済み ${done}/${total}マス`
    : `撮影済みマスをタップで写真表示<br>撮影済み ${done}/${total}マス`;
  $("shoot").disabled = S.mode !== "shoot" || !S.sel.size;
  $("clr").style.display = S.mode === "shoot" ? "" : "none";
  $("shoot").style.display = S.mode === "shoot" ? "" : "none";
}

function setMode(m) {
  S.mode = m; S.hl.clear();
  $("mShoot").className = m === "shoot" ? "on" : "ghost";
  $("mView").className = m === "view" ? "on" : "ghost";
  if (S.d) drawOverlay();
}
$("mShoot").onclick = () => setMode("shoot");
$("mView").onclick = () => setMode("view");

$("ov").addEventListener("click", (e) => {
  const rc = $("ov").getBoundingClientRect();
  const c = Math.floor(((e.clientX - rc.left) / rc.width) * S.d.cols);
  const r = Math.floor(((e.clientY - rc.top) / rc.height) * S.d.rows);
  const k = r + "," + c;
  S.hl.clear();
  if (S.mode === "shoot") {
    S.sel.has(k) ? S.sel.delete(k) : S.sel.add(k);
    drawOverlay();
  } else {
    const ps = pagePhotos().filter((p) => p.cells.includes(k));
    if (!ps.length) { toast(cellName(k) + " は未撮影です"); return; }
    openGallery(ps, "マス " + cellName(k));
  }
});

$("clr").onclick = () => { S.sel.clear(); drawOverlay(); };
$("zIn").onclick = () => { S.zoom = Math.min(S.zoom + 0.5, 5); applyZoom(); };
$("zOut").onclick = () => { S.zoom = Math.max(S.zoom - 0.5, 1); applyZoom(); };
async function turn(d) {
  const n = S.page + d;
  if (n < 1 || n > S.d.pages) return;
  S.page = n; S.sel.clear(); S.hl.clear();
  await renderPage();
}
$("pPrev").onclick = () => turn(-1);
$("pNext").onclick = () => turn(1);
$("back").onclick = () => { show("home"); renderHome(); };

$("gSet").onclick = async () => {
  if (S.photos.length) { toast("写真がある図面は分割数を変更できません"); return; }
  const c = Math.max(1, Math.min(60, +$("gc").value | 0));
  const r = Math.max(1, Math.min(60, +$("gr").value | 0));
  S.d.cols = c; S.d.rows = r;
  await dbPut("drawings", S.d);
  S.sel.clear(); drawOverlay();
};

// ---------- shooting ----------
async function shrink(file, max, q) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const cv = document.createElement("canvas");
  cv.width = Math.round(bmp.width * s); cv.height = Math.round(bmp.height * s);
  cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
  return new Promise((r) => cv.toBlob(r, "image/jpeg", q));
}

$("shoot").onclick = () => $("camIn").click();
$("camIn").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f || !S.sel.size) return;
  try {
    const rec = {
      drawingId: S.d.id, page: S.page, cells: [...S.sel], ts: Date.now(),
      blob: await shrink(f, 1920, 0.8), thumb: await shrink(f, 320, 0.7),
    };
    rec.id = await dbPut("photos", rec);
    S.photos.push(rec);
    drawOverlay();
    toast("保存しました（選択マスはそのまま）");
  } catch (err) {
    toast("保存に失敗しました");
    console.error(err);
  }
};

// ---------- gallery ----------
const modal = $("modal"), sheet = $("sheet");
modal.onclick = (e) => { if (e.target === modal) closeModal(); };
function closeModal() { modal.classList.remove("on"); sheet.innerHTML = ""; }

function openGallery(ps, title) {
  sheet.innerHTML = `<div class="hd"><b></b><button class="ghost">閉じる</button></div><div id="grid"></div>`;
  sheet.querySelector("b").textContent = `${title}（${ps.length}枚）`;
  sheet.querySelector("button").onclick = closeModal;
  const grid = $("grid");
  for (const p of ps) {
    const fig = document.createElement("figure");
    const img = document.createElement("img");
    img.src = URL.createObjectURL(p.thumb);
    const cap = document.createElement("figcaption");
    cap.textContent = fmt(p.ts) + " " + p.cells.map(cellName).join(",");
    fig.append(img, cap);
    fig.onclick = () => openFull(p, ps, title);
    grid.appendChild(fig);
  }
  modal.classList.add("on");
}

function openFull(p, ps, title) {
  sheet.innerHTML = `<div class="hd"><b>写真</b><button class="ghost">戻る</button></div><div id="full"></div>`;
  sheet.querySelector("button").onclick = () => openGallery(ps, title);
  const f = $("full");
  const img = document.createElement("img");
  img.src = URL.createObjectURL(p.blob);
  const cap = document.createElement("div");
  cap.className = "cap";
  cap.textContent = `p.${p.page} ／ マス: ${p.cells.map(cellName).join(", ")} ／ ${fmt(p.ts)}`;
  const row = document.createElement("div");
  row.className = "row";
  const loc = document.createElement("button");
  loc.textContent = "図面で場所を見る";
  loc.onclick = async () => {
    closeModal();
    if (S.page !== p.page) { S.page = p.page; await renderPage(); }
    S.sel.clear(); S.hl = new Set(p.cells);
    drawOverlay();
  };
  const del = document.createElement("button");
  del.className = "danger"; del.textContent = "削除";
  del.onclick = async () => {
    if (!confirm("この写真を削除しますか？")) return;
    await dbDel("photos", p.id);
    S.photos = S.photos.filter((x) => x.id !== p.id);
    closeModal(); drawOverlay();
  };
  row.append(loc, del);
  f.append(img, cap, row);
}

// ---------- export ----------
$("exp").onclick = async () => {
  if (!S.photos.length) { toast("写真がありません"); return; }
  toast("ZIPを作成中…");
  const zip = new JSZip();
  const rows = ["ファイル名,ページ,マス,撮影日時"];
  const safe = S.d.name.replace(/[\\/:*?"<>|]/g, "_");
  for (const p of S.photos) {
    const cells = p.cells.map(cellName).join("+");
    const name = `photos/p${p.page}_${cells}_${p.id}.jpg`;
    zip.file(name, p.blob);
    rows.push(`${name},${p.page},${cells},${new Date(p.ts).toLocaleString("ja-JP")}`);
  }
  zip.file("list.csv", "﻿" + rows.join("\r\n"));
  const blob = await zip.generateAsync({ type: "blob" });
  const file = new File([blob], safe + "_photos.zip", { type: "application/zip" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
};

// ---------- boot ----------
(async () => {
  await openDB();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  renderHome();
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
