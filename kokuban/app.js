"use strict";
const $ = (id) => document.getElementById(id);

// ---------- 状態の保存（現場・黒板配置・設定は端末内の localStorage） ----------
const DEF_SETTINGS = { bg: "#000000", alpha: 0.6, font: 1, dateFmt: "ja" };
const uid = () => Math.random().toString(36).slice(2, 10);

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem("kb_state"));
    if (s && s.sites && s.sites.length) return s;
  } catch {}
  const id = uid();
  return { sites: [{ id, name: "現場1", text: "", boards: {} }], cur: id, voiceMode: "replace", settings: { ...DEF_SETTINGS } };
}
const st = loadState();
const saveState = () => { try { localStorage.setItem("kb_state", JSON.stringify(st)); } catch {} };
const site = () => st.sites.find((s) => s.id === st.cur) || st.sites[0];

function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.style.display = "block";
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.style.display = "none"), 2600);
}

// ---------- 電子黒板の描画 ----------
// プレビューと保存の両方でこの関数を使うので、位置・サイズは必ず一致する。
// 座標はすべて「画像ピクセル」基準。位置は幅・高さに対する割合で保存する。
const pad2 = (n) => String(n).padStart(2, "0");
function fmtDate(ts) {
  const d = new Date(ts);
  const ymd = [d.getFullYear(), pad2(d.getMonth() + 1), pad2(d.getDate())];
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return st.settings.dateFmt === "iso"
    ? `${ymd.join("/")} ${hm}`
    : `${ymd[0]}年${ymd[1]}月${ymd[2]}日 ${hm}`;
}

function getBoard(W, H) {
  const key = W >= H ? "l" : "p";
  const s = site();
  let b = s.boards[key];
  if (!b) {
    b = s.boards[key] = { w: key === "p" ? 0.6 : 0.36, x: null, y: null };
  }
  return b;
}

function wrap(ctx, text, maxW) {
  const out = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const ch of para) {
      if (ctx.measureText(line + ch).width > maxW && line) { out.push(line); line = ch; }
      else line += ch;
    }
    out.push(line);
  }
  return out;
}

function layout(ctx, W, board, ts) {
  const bw = board.w * W;
  const fs = bw * 0.065 * st.settings.font;
  const pad = fs * 0.7, gap = fs * 0.35;
  const rows = [];
  let y = pad;
  const add = (lines, font, lh) => {
    for (const t of lines) { rows.push({ t, font, y: y + lh * 0.8 }); y += lh; }
  };
  ctx.font = `bold ${fs * 1.1}px sans-serif`;
  add(wrap(ctx, site().name, bw - pad * 2), ctx.font, fs * 1.4);
  y += gap;
  ctx.font = `${fs}px sans-serif`;
  const memo = site().text.trim();
  if (memo) { add(wrap(ctx, memo, bw - pad * 2), ctx.font, fs * 1.35); y += gap; }
  ctx.font = `${fs * 0.9}px sans-serif`;
  add([fmtDate(ts)], ctx.font, fs * 1.3);
  return { bw, bh: y + pad - gap * 0.5, pad, rows, fs };
}

function clampBoard(b, W, H, L) {
  b.x = Math.min(Math.max(b.x, 0), Math.max(0, 1 - L.bw / W));
  b.y = Math.min(Math.max(b.y, 0), Math.max(0, 1 - L.bh / H));
}

function drawBoard(ctx, W, H, ts) {
  const b = getBoard(W, H);
  const L = layout(ctx, W, b, ts);
  if (b.x === null) { b.x = 1 - b.w - 0.02; b.y = 1 - L.bh / H - 0.02; }
  clampBoard(b, W, H, L);
  const x = b.x * W, y = b.y * H;
  const hex = st.settings.bg;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), bl = parseInt(hex.slice(5, 7), 16);
  ctx.fillStyle = `rgba(${r},${g},${bl},${st.settings.alpha})`;
  ctx.beginPath();
  ctx.roundRect(x, y, L.bw, L.bh, L.fs * 0.4);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "alphabetic";
  for (const row of L.rows) { ctx.font = row.font; ctx.fillText(row.t, x + L.pad, y + row.y); }
  return L;
}

// ---------- 画面（ライブ / 撮影後プレビュー） ----------
const cv = $("cv"), ctx = cv.getContext("2d"), vid = $("vid");
let mode = "live";
let still = null; // { bmp, W, H, orig: Blob|File, ts }
let view = { s: 1, ox: 0, oy: 0, W: 0, H: 0 };
let dirty = true;

function frame() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; dirty = true; }
  let src = null, W = 0, H = 0, ts = Date.now();
  if (mode === "live" && vid.videoWidth) { src = vid; W = vid.videoWidth; H = vid.videoHeight; }
  else if (mode === "still") { src = still.bmp; W = still.W; H = still.H; ts = still.ts; }
  if (src && (dirty || mode === "live")) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
    const s = Math.min(w / W, h / H);
    view = { s, ox: (w - W * s) / 2, oy: (h - H * s) / 2, W, H };
    ctx.setTransform(s, 0, 0, s, view.ox, view.oy);
    ctx.drawImage(src, 0, 0, W, H);
    drawBoard(ctx, W, H, ts);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    dirty = false;
  }
  requestAnimationFrame(frame);
}

// 1本指ドラッグで移動、2本指ピンチで拡大縮小
const ptrs = new Map();
let pinch0 = null;
cv.addEventListener("pointerdown", (e) => {
  cv.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), w: getBoard(view.W, view.H).w };
  }
});
cv.addEventListener("pointermove", (e) => {
  const p = ptrs.get(e.pointerId);
  if (!p || !view.W) return;
  const b = getBoard(view.W, view.H);
  const k = (cv.width / cv.clientWidth) / view.s;
  if (ptrs.size === 1) {
    if (b.x !== null) { b.x += ((e.clientX - p.x) * k) / view.W; b.y += ((e.clientY - p.y) * k) / view.H; }
  } else if (ptrs.size === 2 && pinch0) {
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [a, c] = [...ptrs.values()];
    const old = b.w;
    const L0 = layout(ctx, view.W, b, Date.now());
    b.w = Math.min(0.95, Math.max(0.1, pinch0.w * (Math.hypot(a.x - c.x, a.y - c.y) / pinch0.d)));
    const L1 = layout(ctx, view.W, b, Date.now());
    b.x -= (L1.bw - L0.bw) / 2 / view.W; b.y -= (L1.bh - L0.bh) / 2 / view.H; // 中心を保って拡縮
    if (old === b.w) return;
  }
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  dirty = true;
});
const endPtr = (e) => {
  ptrs.delete(e.pointerId); pinch0 = null;
  if (!ptrs.size) saveState();
};
cv.addEventListener("pointerup", endPtr);
cv.addEventListener("pointercancel", endPtr);

// ---------- カメラ ----------
let track = null;
async function startCam() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: false,
    });
    vid.srcObject = stream;
    await vid.play();
    track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    $("torchBtn").classList.toggle("hide", !caps.torch);
  } catch (e) {
    toast("ライブカメラを起動できません（HTTPS接続が必要）。「標準カメラ」で撮影できます");
  }
}
let torch = false;
$("torchBtn").onclick = async () => {
  torch = !torch;
  try { await track.applyConstraints({ advanced: [{ torch }] }); } catch {}
  $("torchBtn").className = torch ? "on" : "";
};

const toBlob = (c, q) => new Promise((r) => c.toBlob(r, "image/jpeg", q));

function setMode(m) {
  mode = m; dirty = true;
  $("liveBar").classList.toggle("hide", m !== "live");
  $("stillBar").classList.toggle("hide", m !== "still");
}

$("shutter").onclick = async () => {
  if (!vid.videoWidth) { toast("カメラが起動していません。「標準カメラ」を使ってください"); return; }
  const c = document.createElement("canvas");
  c.width = vid.videoWidth; c.height = vid.videoHeight;
  c.getContext("2d").drawImage(vid, 0, 0);
  still = { bmp: await createImageBitmap(c), W: c.width, H: c.height, orig: await toBlob(c, 0.95), ts: Date.now() };
  setMode("still");
};

$("nativeBtn").onclick = () => $("fileIn").click();
$("fileIn").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  const bmp = await createImageBitmap(f, { imageOrientation: "from-image" });
  // 元ファイル(f)は加工せずそのまま「文字なし写真」として保存する
  still = { bmp, W: bmp.width, H: bmp.height, orig: f, ts: Date.now() };
  setMode("still");
};
$("retake").onclick = () => { still = null; setMode("live"); };

// ---------- 保存（文字あり + 文字なし の2枚） ----------
async function renderFinal() {
  // iOS の canvas 上限（約1670万画素）を超える場合だけ縮小する
  const f = Math.min(1, Math.sqrt(16e6 / (still.W * still.H)));
  const c = document.createElement("canvas");
  c.width = Math.round(still.W * f); c.height = Math.round(still.H * f);
  const g = c.getContext("2d");
  g.scale(f, f);
  g.drawImage(still.bmp, 0, 0, still.W, still.H);
  drawBoard(g, still.W, still.H, still.ts);
  return toBlob(c, 0.95);
}

$("saveBtn").onclick = async () => {
  const d = new Date(still.ts);
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const base = `${site().name.replace(/[\\/:*?"<>|\s]/g, "_")}_${stamp}`;
  const files = [
    new File([await renderFinal()], `${base}_黒板あり.jpg`, { type: "image/jpeg" }),
    new File([still.orig], `${base}_元写真.jpg`, { type: "image/jpeg" }),
  ];
  try {
    if (navigator.canShare && navigator.canShare({ files })) {
      await navigator.share({ files });
    } else {
      for (const f of files) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(f); a.download = f.name; a.click();
      }
    }
  } catch (e) {
    if (e.name === "AbortError") return; // 共有シートを閉じただけなら撮影画面に戻らない
    toast("保存に失敗しました");
    return;
  }
  toast("共有シートの「2項目を保存」で写真に保存してください");
  still = null; setMode("live");
};

// ---------- 撮影内容（音声入力は iPhone キーボードのマイク＝端末内認識を使う） ----------
const memo = $("memo");
memo.value = site().text;
memo.oninput = () => { site().text = memo.value; saveState(); dirty = true; };
function renderMode() { $("modeBtn").textContent = st.voiceMode === "replace" ? "置換" : "追加"; }
$("modeBtn").onclick = () => {
  st.voiceMode = st.voiceMode === "replace" ? "append" : "replace";
  saveState(); renderMode();
  toast(st.voiceMode === "replace" ? "音声入力：全文置き換え" : "音声入力：文章を追加");
};
$("micBtn").onclick = () => {
  memo.focus();
  if (st.voiceMode === "replace") memo.select();
  else {
    if (memo.value && !memo.value.endsWith("\n")) memo.value += "\n";
    memo.setSelectionRange(memo.value.length, memo.value.length);
    memo.oninput();
  }
  toast("キーボードのマイク🎤を押して話してください");
};
renderMode();

// ---------- 現場管理・設定 ----------
const modal = $("modal"), sheet = $("sheet");
modal.onclick = (e) => { if (e.target === modal) closeModal(); };
const closeModal = () => modal.classList.remove("on");
function refreshSite() {
  $("siteBtn").textContent = "📍 " + site().name + " ▾";
  memo.value = site().text;
  dirty = true;
}

function openSites() {
  sheet.innerHTML = "<h3>現場</h3><div id=\"sl\"></div><div class=\"row\" style=\"margin-top:12px\"><button class=\"pri\" id=\"add\" style=\"flex:1\">＋ 現場を追加</button><button id=\"cl\">閉じる</button></div>";
  const sl = sheet.querySelector("#sl");
  for (const s of st.sites) {
    const el = document.createElement("div");
    el.className = "site" + (s.id === st.cur ? " cur" : "");
    el.innerHTML = "<b></b><button class=\"rn\">名前</button><button class=\"ng dl\">削除</button>";
    el.querySelector("b").textContent = s.name;
    el.querySelector("b").onclick = () => { st.cur = s.id; saveState(); refreshSite(); closeModal(); };
    el.querySelector(".rn").onclick = () => {
      const n = prompt("現場名", s.name);
      if (n && n.trim()) { s.name = n.trim(); saveState(); refreshSite(); openSites(); }
    };
    el.querySelector(".dl").onclick = () => {
      if (st.sites.length === 1) { toast("最後の現場は削除できません"); return; }
      if (!confirm(`「${s.name}」を削除しますか？`)) return;
      st.sites = st.sites.filter((x) => x.id !== s.id);
      if (st.cur === s.id) st.cur = st.sites[0].id;
      saveState(); refreshSite(); openSites();
    };
    sl.appendChild(el);
  }
  sheet.querySelector("#add").onclick = () => {
    const n = prompt("新しい現場名");
    if (!n || !n.trim()) return;
    const s = { id: uid(), name: n.trim(), text: "", boards: {} };
    st.sites.push(s); st.cur = s.id; saveState(); refreshSite(); closeModal();
  };
  sheet.querySelector("#cl").onclick = closeModal;
  modal.classList.add("on");
}
$("siteBtn").onclick = openSites;

$("setBtn").onclick = () => {
  const s = st.settings;
  sheet.innerHTML = `<h3>設定</h3>
  <div class="row"><label>背景色</label><select id="sBg"><option value="#000000">黒</option><option value="#333333">濃いグレー</option></select></div>
  <div class="row"><label>透明度</label><input id="sAl" type="range" min="0.2" max="1" step="0.05"></div>
  <div class="row"><label>文字サイズ</label><input id="sFs" type="range" min="0.6" max="1.6" step="0.05"></div>
  <div class="row"><label>日時の形式</label><select id="sDf"><option value="ja">2026年10月15日 14:30</option><option value="iso">2026/10/15 14:30</option></select></div>
  <div class="row"><button id="sRs" style="flex:1">この現場の黒板位置を初期化</button><button class="pri" id="sCl">閉じる</button></div>`;
  sheet.querySelector("#sBg").value = s.bg;
  sheet.querySelector("#sAl").value = s.alpha;
  sheet.querySelector("#sFs").value = s.font;
  sheet.querySelector("#sDf").value = s.dateFmt;
  const upd = () => {
    s.bg = sheet.querySelector("#sBg").value; s.alpha = +sheet.querySelector("#sAl").value;
    s.font = +sheet.querySelector("#sFs").value; s.dateFmt = sheet.querySelector("#sDf").value;
    saveState(); dirty = true;
  };
  sheet.querySelectorAll("select,input").forEach((el) => (el.oninput = upd));
  sheet.querySelector("#sRs").onclick = () => { site().boards = {}; saveState(); dirty = true; toast("初期化しました"); };
  sheet.querySelector("#sCl").onclick = closeModal;
  modal.classList.add("on");
};

// ---------- 起動 ----------
refreshSite();
startCam();
requestAnimationFrame(frame);
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
