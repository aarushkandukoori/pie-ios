// Browser recreation of Pie Voice: Qwen3-0.6B in-browser via WebLLM/WebGPU,
// voice in (Web Speech API), voice out (speechSynthesis), and a per-turn
// stats chip that shows prefill GROWING each turn — the baseline cost that
// the Pie engine's per-conversation KV snapshots remove in the native app.
//
// Typed input is fully client-side; the only network traffic is the one-time
// model download from the WebLLM CDN. Voice input goes through the browser's
// Web Speech API, which some browsers process server-side — the page says so.

const MODEL_CANDIDATES = [
  "Qwen3-0.6B-q4f16_1-MLC",
  "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", // fallback if the Qwen3 id is absent
];

const SYSTEM_PROMPT =
  "You are a voice assistant. Your replies are read aloud, so keep them to " +
  "one or two short spoken sentences. Never use markdown, lists, code " +
  "blocks, or emoji. Write numbers and symbols the way a person would say them.";

const els = {
  load: document.getElementById("demo-load"),
  mic: document.getElementById("demo-mic"),
  text: document.getElementById("demo-text"),
  send: document.getElementById("demo-send"),
  reset: document.getElementById("demo-reset"),
  transcript: document.getElementById("demo-transcript"),
  status: document.getElementById("demo-status"),
  progress: document.getElementById("demo-progress"),
  progressBar: document.querySelector("#demo-progress div"),
  engineLabel: document.getElementById("demo-engine"),
};

let engine = null;
let modelId = null;
let messages = [{ role: "system", content: SYSTEM_PROMPT }];
let busy = false;

function status(t) { els.status.textContent = t; }

function bubble(role, text) {
  const div = document.createElement("div");
  div.className = "bubble " + (role === "user" ? "user" : "bot");
  div.textContent = text;
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  return div;
}

function chip(text) {
  const div = document.createElement("div");
  div.className = "chip";
  div.textContent = text;
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

// Same contract as the app: reasoning blocks never reach the screen or
// the speaker. Belt-and-suspenders for engines that ignore
// enable_thinking and emit <think>…</think> anyway.
function stripThink(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*$/, "…")
    .replace(/^\s+/, "");
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.0;
  speechSynthesis.speak(u);
}

function setChatEnabled(on) {
  els.text.disabled = !on;
  els.send.disabled = !on;
  els.reset.disabled = !on;
  els.mic.disabled = !on || !SpeechRec;
}

// ── Model loading ─────────────────────────────────────────────────
async function loadModel() {
  if (!("gpu" in navigator)) {
    status("This browser has no WebGPU — try recent Chrome, Edge, or Safari. " +
           "The walkthrough and benchmarks above show the native app.");
    els.load.disabled = true;
    return;
  }
  els.load.disabled = true;
  els.progress.style.display = "block";
  status("Fetching WebLLM…");
  try {
    const webllm = await import("https://esm.run/@mlc-ai/web-llm");
    const available = new Set(
      webllm.prebuiltAppConfig.model_list.map((m) => m.model_id)
    );
    modelId = MODEL_CANDIDATES.find((m) => available.has(m));
    if (!modelId) throw new Error("no suitable prebuilt model id");
    els.engineLabel.textContent = modelId.replace(/-MLC$/, "") + " · WebLLM · WebGPU";

    engine = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (p) => {
        const pct = Math.round((p.progress || 0) * 100);
        els.progressBar.style.width = pct + "%";
        els.progress.setAttribute("aria-valuenow", pct);
        status(p.text || "Loading…");
      },
    });
    els.progress.style.display = "none";
    status("Model ready — it runs on your GPU, in this tab. Ask something.");
    setChatEnabled(true);
    els.text.focus();
  } catch (err) {
    els.progress.style.display = "none";
    els.load.disabled = false;
    status("Could not load the model (" + err.message + "). Reload to retry.");
  }
}

// ── One turn ──────────────────────────────────────────────────────
async function ask(utterance) {
  if (!engine || busy || !utterance.trim()) return;
  busy = true;
  setChatEnabled(false);
  bubble("user", utterance.trim());
  messages.push({ role: "user", content: utterance.trim() });

  const out = bubble("bot", "…");
  const t0 = performance.now();
  let firstToken = 0;
  let text = "";

  try {
    const chunks = await engine.chat.completions.create({
      messages,
      temperature: 0.7,
      top_p: 0.95,
      max_tokens: 120,
      stream: true,
      stream_options: { include_usage: true },
      // Qwen3: keep reasoning out of the spoken channel, same as the app.
      extra_body: { enable_thinking: false },
    });

    let usage = null;
    for await (const chunk of chunks) {
      const delta = chunk.choices?.[0]?.delta?.content || "";
      if (delta && !firstToken) firstToken = performance.now();
      text += delta;
      if (delta) out.textContent = stripThink(text) || "…";
      if (chunk.usage) usage = chunk.usage;
      els.transcript.scrollTop = els.transcript.scrollHeight;
    }

    const secs = (performance.now() - (firstToken || t0)) / 1000;
    text = stripThink(text).trim();
    out.textContent = text;
    messages.push({ role: "assistant", content: text });

    const prefill = usage?.prompt_tokens ?? 0;
    const generated = usage?.completion_tokens ?? 0;
    const rate = secs > 0 ? (generated / secs).toFixed(1) : "?";
    const turn = (messages.length - 1) / 2;
    chip(
      `turn ${turn} · prefill ${prefill} tok (entire history — no KV snapshot in the browser) · ` +
      `${generated} tok · ${rate} tok/s`
    );
    speak(text);
  } catch (err) {
    // Roll the failed turn out of history, or the next request would send
    // two consecutive user messages.
    messages.pop();
    out.textContent = "Error: " + err.message;
  }

  busy = false;
  setChatEnabled(true);
}

// ── Voice input ───────────────────────────────────────────────────
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let listening = false;

function startMic() {
  if (!SpeechRec || busy || listening) return;
  listening = true;
  rec = new SpeechRec();
  rec.lang = "en-US";
  rec.interimResults = true;
  let finalText = "";
  els.mic.textContent = "● Listening…";
  rec.onresult = (e) => {
    let interim = "";
    for (const r of e.results) {
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    els.text.value = (finalText + " " + interim).trim();
  };
  rec.onend = () => {
    listening = false;
    els.mic.textContent = "🎤 Speak";
    const said = (finalText || els.text.value).trim();
    els.text.value = "";
    if (said) ask(said);
  };
  rec.onerror = () => { listening = false; els.mic.textContent = "🎤 Speak"; };
  rec.start();
}

// ── Wiring ────────────────────────────────────────────────────────
els.load.addEventListener("click", loadModel);
els.send.addEventListener("click", () => {
  const t = els.text.value;
  els.text.value = "";
  ask(t);
});
els.text.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { const t = els.text.value; els.text.value = ""; ask(t); }
});
els.mic.addEventListener("click", startMic);
els.reset.addEventListener("click", () => {
  messages = [{ role: "system", content: SYSTEM_PROMPT }];
  els.transcript.innerHTML = "";
  window.speechSynthesis?.cancel();
  status("Fresh conversation — history cleared.");
});

if (!("gpu" in navigator)) {
  status("Heads-up: no WebGPU in this browser, so the live demo can't run here. " +
         "Recent Chrome, Edge, or Safari can. The walkthrough above is the native app.");
}
