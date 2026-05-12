// I-Perceive online demo — public GitHub Pages frontend.
// Talks to the FastAPI backend exposed at window.IPERCEIVE_CONFIG.apiBase.
// The image preprocessing here mirrors the server-side
// IPerceiveProcessor._preprocess_vlm_images: center crop to a square
// then resize to 1024x1024.

const API = (window.IPERCEIVE_CONFIG?.apiBase || "").replace(/\/+$/, "");
const CROP_SIZE = 1024;
const POINT_NORM = 1000;
const POLL_INTERVAL_MS = 1500;

const $ = (id) => document.getElementById(id);

const state = {
  cropped: [],     // {name, blob, bitmap}[]
  startIdx: 0,
  point: null,
  pointEnabled: false,
  uploadId: null,
  maxInput: 6,     // refreshed from /info
};

// ---------- Init ----------
async function init() {
  bindHeader();
  bindUI();
  $("point-section").hidden = true;

  if (!API) {
    setStatus("API base URL is not configured (static/js/config.js).", "error");
    return;
  }

  try {
    const info = await (await fetch(`${API}/info`)).json();
    state.maxInput = (info.max_context_frames ?? 5) + 1;
    $("files-hint").textContent =
      `Choose up to ${state.maxInput} photos.`;
    $("backend-version").textContent = `backend ${info.model_version}`;
  } catch (e) {
    setStatus(
      "Could not reach the inference backend. The demo may be offline; please try again later.",
      "error",
    );
    console.warn("Failed to load /info:", e);
  }

  try {
    const examples = await (await fetch(`${API}/examples`)).json();
    const sel = $("examples");
    for (const ex of examples) {
      const opt = document.createElement("option");
      opt.value = ex.name;
      const short = (ex.instruction || "").slice(0, 60);
      opt.textContent = `${ex.name}${short ? " — " + short : ""}`;
      opt.dataset.meta = JSON.stringify(ex);
      sel.appendChild(opt);
    }
  } catch (e) {
    console.warn("Failed to load examples:", e);
  }
}

function bindHeader() {
  const wireLink = (id, url) => {
    const a = $(id);
    if (!a) return;
    if (typeof url === "string" && url.trim() !== "") {
      a.setAttribute("href", url);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener");
    } else {
      a.setAttribute("href", "#");
      a.removeAttribute("target");
      a.addEventListener("click", (e) => {
        e.preventDefault();
        toast("Will be released after review.");
      });
    }
  };
  wireLink("link-paper", window.IPERCEIVE_CONFIG?.paperUrl);
  wireLink("link-code", window.IPERCEIVE_CONFIG?.codeUrl);
}

// ---------- Image cropping ----------
async function cropResizeFile(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height);
  const sx = Math.floor((bmp.width - s) / 2);
  const sy = Math.floor((bmp.height - s) / 2);
  const off = "OffscreenCanvas" in window
    ? new OffscreenCanvas(CROP_SIZE, CROP_SIZE)
    : (() => {
        const c = document.createElement("canvas");
        c.width = CROP_SIZE; c.height = CROP_SIZE;
        return c;
      })();
  const ctx = off.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, sx, sy, s, s, 0, 0, CROP_SIZE, CROP_SIZE);
  bmp.close?.();
  const blob = off.convertToBlob
    ? await off.convertToBlob({ type: "image/png" })
    : await new Promise((res) => off.toBlob(res, "image/png"));
  const cropBitmap = await createImageBitmap(blob);
  return { name: file.name, blob, bitmap: cropBitmap };
}

async function loadFiles(files) {
  if (files.length > state.maxInput) files = files.slice(0, state.maxInput);
  setStatus("Cropping and resizing images…");
  const out = [];
  for (const f of files) out.push(await cropResizeFile(f));
  for (const c of state.cropped) c.bitmap?.close?.();
  state.cropped = out;
  state.startIdx = 0;
  state.point = null;
  renderThumbs();
  renderStartImage();
  hideStatus();
}

// ---------- UI wiring ----------
function bindUI() {
  $("files").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    try {
      await loadFiles(files);
    } catch (err) {
      setStatus(String(err), "error");
    }
  });

  $("examples").addEventListener("change", async () => {
    const sel = $("examples");
    if (!sel.value) return;
    const meta = JSON.parse(sel.selectedOptions[0].dataset.meta);
    setStatus("Loading example…");
    sel.disabled = true;
    try {
      const fetched = [];
      for (const fname of meta.raw_files) {
        const r = await fetch(
          `${API}/examples/${encodeURIComponent(meta.name)}/files/${encodeURIComponent(fname)}`
        );
        const blob = await r.blob();
        fetched.push(new File([blob], fname, { type: blob.type || "image/png" }));
      }
      await loadFiles(fetched);
      state.startIdx = meta.start_idx || 0;
      $("instruction").value = meta.instruction || "";
      const tc = meta.target_2d_coord;
      if (tc && Array.isArray(tc) && tc.length === 2) {
        const px = Math.round(Math.max(0, Math.min(1, +tc[0])) * POINT_NORM);
        const py = Math.round(Math.max(0, Math.min(1, +tc[1])) * POINT_NORM);
        state.point = [px, py];
        state.pointEnabled = true;
        $("point-section").hidden = false;
        $("btn-toggle-point").textContent = "Remove point";
      } else {
        state.point = null;
        state.pointEnabled = false;
        $("point-section").hidden = true;
        $("btn-toggle-point").textContent = "Add point hint";
      }
      renderThumbs();
      renderStartImage();
      refreshPointText();
      hideStatus();
    } catch (err) {
      setStatus(String(err), "error");
    } finally {
      sel.disabled = false;
    }
  });

  $("btn-toggle-point").addEventListener("click", () => {
    state.pointEnabled = !state.pointEnabled;
    $("point-section").hidden = !state.pointEnabled;
    $("btn-toggle-point").textContent = state.pointEnabled
      ? "Remove point"
      : "Add point hint";
    if (!state.pointEnabled) state.point = null;
    refreshPointText();
    renderStartImage();
  });

  $("btn-clear-point").addEventListener("click", () => {
    state.point = null;
    refreshPointText();
    renderStartImage();
  });

  $("start-canvas").addEventListener("click", (e) => {
    if (!state.cropped[state.startIdx]) return;
    const canvas = $("start-canvas");
    const rect = canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const cy = (e.clientY - rect.top) * (canvas.height / rect.height);
    const nx = Math.round((cx / canvas.width) * POINT_NORM);
    const ny = Math.round((cy / canvas.height) * POINT_NORM);
    state.point = [
      Math.max(0, Math.min(POINT_NORM, nx)),
      Math.max(0, Math.min(POINT_NORM, ny)),
    ];
    refreshPointText();
    renderStartImage();
  });

  $("btn-submit").addEventListener("click", submit);
}

function refreshPointText() {
  $("point-text").textContent = state.point
    ? `Point set at (${state.point[0]}, ${state.point[1]}) on the 1000×1000 grid.`
    : "Click on the start frame to drop an anchor point.";
}

// ---------- Rendering ----------
function renderThumbs() {
  const div = $("thumbs");
  div.innerHTML = "";
  if (!state.cropped.length) {
    const empty = document.createElement("div");
    empty.className = "thumbs-empty";
    empty.textContent = "No images yet. Choose images or load an example to begin.";
    div.appendChild(empty);
    return;
  }
  state.cropped.forEach((c, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "thumb" + (i === state.startIdx ? " start" : "");
    btn.title = `${i}: ${c.name}`;
    const img = document.createElement("img");
    img.src = URL.createObjectURL(c.blob);
    img.alt = `frame ${i}`;
    btn.appendChild(img);
    if (i === state.startIdx) {
      const badge = document.createElement("span");
      badge.className = "thumb-badge";
      badge.textContent = "★";
      btn.appendChild(badge);
    }
    btn.addEventListener("click", () => {
      state.startIdx = i;
      state.point = null;
      renderThumbs();
      renderStartImage();
      refreshPointText();
    });
    div.appendChild(btn);
  });
}

function renderStartImage() {
  const c = state.cropped[state.startIdx];
  const canvas = $("start-canvas");
  // Set internal size to the crop size so coordinates map cleanly.
  if (canvas.width !== CROP_SIZE) canvas.width = CROP_SIZE;
  if (canvas.height !== CROP_SIZE) canvas.height = CROP_SIZE;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!c) return;
  ctx.drawImage(c.bitmap, 0, 0, canvas.width, canvas.height);
  if (state.point) {
    const cx = (state.point[0] / POINT_NORM) * canvas.width;
    const cy = (state.point[1] / POINT_NORM) * canvas.height;
    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, 2 * Math.PI);
    ctx.fillStyle = "rgba(239, 68, 68, 0.85)";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 4;
    ctx.stroke();
  }
}

// ---------- Submit ----------
async function submit() {
  if (!state.cropped.length) {
    return setStatus("Please choose at least one image.", "error");
  }
  const instr = $("instruction").value.trim();
  if (!instr) return setStatus("Please enter an instruction.", "error");

  const fd = new FormData();
  for (let i = 0; i < state.cropped.length; i++) {
    const c = state.cropped[i];
    fd.append("files", c.blob, `${String(i).padStart(2, "0")}.png`);
  }
  fd.append("instruction", instr);
  fd.append("start_idx", String(state.startIdx));
  if (state.pointEnabled && state.point) {
    fd.append("point", `${state.point[0]},${state.point[1]}`);
  }

  setSubmitBusy(true);
  setStatus("Uploading…");
  try {
    const r = await fetch(`${API}/requests`, { method: "POST", body: fd });
    if (!r.ok) throw new Error(await r.text());
    const req = await r.json();
    state.uploadId = req.upload_id;
    setStatus(`Queued — request ${req.upload_id}`);
    const final = await pollUntilDone(req.upload_id);
    if (final.status === "done") {
      const sec = (final.forward_seconds ?? 0).toFixed
        ? final.forward_seconds.toFixed(2)
        : "?";
      setStatus(`Inference complete in ${sec}s. Loading 3D viewer…`, "success");
      await openViserFor(req.upload_id);
    } else {
      setStatus(`Inference failed: ${final.error || "unknown error"}`, "error");
    }
  } catch (e) {
    setStatus(`Submission failed: ${e.message || e}`, "error");
  } finally {
    setSubmitBusy(false);
  }
}

function setSubmitBusy(busy) {
  const btn = $("btn-submit");
  btn.disabled = busy;
  btn.textContent = busy ? "Working…" : "Run inference";
}

async function pollUntilDone(uploadId) {
  while (true) {
    const r = await fetch(`${API}/requests/${uploadId}`);
    const req = await r.json();
    if (req.status === "done" || req.status === "error") return req;
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
}

async function openViserFor(uploadId) {
  const r = await fetch(`${API}/viser/reserve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ upload_id: uploadId }),
  });
  const data = await r.json();
  let viserUrl = data.viser_url || "";
  if (!/^https?:\/\//i.test(viserUrl)) {
    viserUrl = `${API}/${viserUrl.replace(/^\/+/, "")}`;
  }
  $("open-viser").href = viserUrl;
  $("viewer-panel").hidden = false;
  $("viser-frame").src = viserUrl;
  $("viewer-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- Status / toast ----------
function setStatus(msg, kind) {
  const div = $("status");
  div.textContent = msg;
  div.className = "demo-status" + (kind ? " " + kind : "");
  div.hidden = false;
}
function hideStatus() {
  const div = $("status");
  div.hidden = true;
  div.textContent = "";
}

let toastTimer = null;
function toast(msg) {
  let t = $("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    Object.assign(t.style, {
      position: "fixed",
      bottom: "24px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "rgba(17,24,39,0.92)",
      color: "white",
      padding: "0.6rem 1rem",
      borderRadius: "999px",
      fontSize: "0.9rem",
      zIndex: 9999,
      transition: "opacity 0.2s",
    });
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = "1";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.opacity = "0"; }, 2200);
}

document.addEventListener("DOMContentLoaded", init);
