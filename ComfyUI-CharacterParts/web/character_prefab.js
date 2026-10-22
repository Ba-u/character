// ComfyUI-CharacterParts v3 : 프리팹 매니저 창 + 감정별 실행(그룹 뮤터)
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const TARGETS = ["CharacterPrefabComposer", "CharacterLoad", "CharacterSave", "CharacterCodes"];
// 노드 위젯 이름 → 프리팹 종류
const COMBO_COLL = {
  appearance: "appearance",
  outfit: "outfit",
  background: "background",
  pregnancy: "pregnancy",
  character: "character",
  outfit_override: "outfit",
  background_override: "background",
};
const BASE_SECTIONS = ["appearance", "outfit", "background"];
const TABS = ["appearance", "emotion", "emotion_group", "outfit", "background", "pregnancy", "character"];
const TAB_LABEL = {
  appearance: "👤 캐릭터", emotion: "😊 감정", emotion_group: "📦 감정 묶음", outfit: "👗 의상",
  background: "🏙 배경", pregnancy: "🤰 임신", character: "⭐ 저장된 캐릭터",
};
const GENERAL = [
  ["quality", "품질 태그"],
  ["expression_pose", "추가 표정/포즈"],
  ["extra", "추가 태그"],
  ["negative", "공통 네거티브"],
];
const GROUP_ACTIONS = [["", "유지"], ["on", "켜기"], ["mute", "끄기 (뮤트)"], ["bypass", "끄기 (바이패스)"]];
const MODE = { on: 0, mute: 2, bypass: 4 };
const DEFAULT_FORMAT = "{character}_{outfit}_{emotion}_{pregnancy}";

let STATE = null; // 서버 payload
const VIEW = { compact: {}, collapsed: new Set() }; // 매니저 목록 보기 설정 (창을 닫아도 유지)

// ================================================================ API
async function fetchData() {
  const r = await api.fetchApi("/charprefab/data");
  STATE = await r.json();
  return STATE;
}
async function post(path, body) {
  const r = await api.fetchApi(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || r.statusText);
  STATE.collections = j.collections;
  announceChange();
  return j;
}

// ================================================================ 프롬프트 규칙 (nodes.py와 동일)
function cleanTags(t) {
  if (!t) return "";
  const seen = new Set();
  const out = [];
  for (let s of String(t).split(/[,\n]/)) {
    s = s.trim();
    if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
  }
  return out.join(", ");
}
function applyWeight(t, w) {
  t = cleanTags(t);
  w = Number(w);
  if (!t || !(w > 0)) return "";
  if (Math.abs(w - 1) < 1e-6) return t;
  return `(${t}:${w.toFixed(2)})`;
}
const fieldKeys = (sec) => STATE.schema[sec].fields.map((f) => f.key);
function sectionText(sec, d, include = null, skip = []) {
  if (!d) return "";
  const keys = fieldKeys(sec).filter((k) => !skip.includes(k) && (!include || include[k] !== false));
  return applyWeight(keys.map((k) => d.fields?.[k] || "").join(", "), d.weight ?? 1);
}
const PART_SECTIONS = ["appearance", "outfit"];
function defaultParts() {
  const out = {};
  for (const sec of PART_SECTIONS) {
    const off = STATE.schema[sec].default_off || [];
    out[sec] = Object.fromEntries(fieldKeys(sec).map((k) => [k, !off.includes(k)]));
  }
  return out;
}
function formatCode(fmt, values) {
  let s = (fmt || DEFAULT_FORMAT).replace(/\{(\w+)\}/g, (_, k) => values[k] ?? "");
  s = s.replace(/([_\-. ])[_\-. ]+/g, "$1");
  return s.replace(/^[_\-. ]+|[_\-. ]+$/g, "");
}
const emoItems = () => STATE.collections.emotion || {};
function resolveEmotions(tokens) {
  const items = emoItems();
  const list = Array.isArray(tokens) ? tokens : String(tokens || "").split(/[,\n]/);
  const byCode = {};
  for (const [n, v] of Object.entries(items)) if (v?.code) byCode[v.code.toLowerCase()] = n;
  const out = [];
  for (let t of list) {
    t = String(t).trim();
    if (!t) continue;
    const n = items[t] ? t : byCode[t.toLowerCase()];
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}
const hasPregnancy = (p) => !!p?.name || ["before", "after"].some((k) => p?.[k]?.code || p?.[k]?.prompt);

function backgroundText(bg, variant) {
  if (variant === "none") return "";
  const f = bg.fields || {};
  let main = variant === "indoor" || variant === "outdoor" ? f[variant] || "" : f.main || "";
  if (!main.trim() && (variant === "indoor" || variant === "outdoor")) main = f.main || "";
  return applyWeight([main, f.common || ""].join(", "), bg.weight ?? 1);
}
const charSlots = () => STATE.char_outfit_slots || { default: "기본 의상", idol: "아이돌 의상" };
function outfitGet(n) {
  const src = n && STATE.collections.outfit?.[n];
  return src ? { name: n, ...normPrefab("outfit", src) } : null;
}
function resolveOutfit(base, emo) {
  const slot = emo?.outfit?.slot || "node";
  const co = base.appearance?.outfits || {};
  let r = null;
  if (slot === "prefab") r = outfitGet(emo.outfit.prefab);
  else if (slot in charSlots()) r = outfitGet(co[slot]);
  if (r) return r;
  const o = base.outfit || {};
  const empty = !o.name && !Object.values(o.fields || {}).some((v) => String(v).trim());
  return (empty && outfitGet(co.default)) || base.outfit; // 노드 의상이 비면 캐릭터 기본 의상
}
// 감정 의상 선택지 값: "slot:node" | "slot:default" | "slot:idol" | "prefab:이름"
const outfitChoiceValue = (o) => (o.slot === "prefab" ? `prefab:${o.prefab}` : `slot:${o.slot || "node"}`);
function outfitChoiceOptions() {
  return [
    ["slot:node", "(노드에서 고른 의상 — 비어 있으면 캐릭터 기본 의상)"],
    ...Object.entries(charSlots()).map(([k, l]) => [`slot:${k}`, `👤 캐릭터 ${l}`]),
    ...sortedNames("outfit").map((n) => [`prefab:${n}`, `${STATE.collections.outfit[n]?.code ? `[${STATE.collections.outfit[n].code}] ` : ""}${n}`]),
  ];
}
function applyOutfitChoice(o, v) {
  if (v.startsWith("prefab:")) { o.slot = "prefab"; o.prefab = v.slice(7); }
  else { o.slot = v.slice(5); o.prefab = ""; }
}
function outfitChoiceLabel(o) {
  if (o.slot === "prefab") return o.prefab || "노드 의상";
  if (o.slot in charSlots()) return `캐릭터 ${charSlots()[o.slot]}`;
  return "노드 의상";
}
function resolveBackground(base, emo) {
  const pref = emo?.background?.prefab;
  const src = pref && STATE.collections.background?.[pref];
  return src ? { name: pref, ...normPrefab("background", src) } : base.background;
}
function renderItem(base, emoName, state) {
  const emo = emoName ? normPrefab("emotion", emoItems()[emoName] || {}) : normPrefab("emotion");
  const bg = resolveBackground(base, emoName ? emo : null);
  const variant = emoName ? emo.background.variant : "main";
  const preg = base.pregnancy;
  const ps = state ? preg[state] : { code: "", prompt: "", negative: "" };
  const parts = emoName ? emo.parts : defaultParts();
  const outfit = resolveOutfit(base, emoName ? emo : null);
  const combat = parts.appearance.combat ? applyWeight(base.appearance.fields?.combat || "", base.appearance.weight) : "";
  const onEx = emoName ? emo.extras || {} : {};
  const extras = (base.appearance.extras || []).filter((x) => onEx[x.name]);
  const pos = [
    cleanTags(base.quality),
    sectionText("appearance", base.appearance, parts.appearance, ["combat"]),
    ...extras.map((x) => applyWeight(x.positive, base.appearance.weight)),
    state ? applyWeight(ps.prompt, preg.weight) : "",
    sectionText("emotion", emo),
    cleanTags(base.expression_pose),
    combat,
    sectionText("outfit", outfit, parts.outfit),
    backgroundText(bg, variant),
    cleanTags(base.extra),
  ].filter(Boolean).join(", ");
  const negs = [base.negative, ...[base.appearance, outfit].filter((x) => x.weight > 0).map((x) => x.negative)];
  if (base.appearance.weight > 0) negs.push(...extras.map((x) => x.negative));
  if (bg.weight > 0 && variant !== "none") negs.push(bg.negative);
  if (emo.weight > 0) negs.push(emo.negative);
  if (state && preg.weight > 0) negs.push(ps.negative);
  const code = formatCode(DEFAULT_FORMAT, {
    character: base.appearance.code, outfit: (emoName ? emo.outfit.code : "") || outfit.code, emotion: emoName || "", pregnancy: ps.code,
  });
  return { pos, neg: cleanTags(negs.filter(Boolean).join(", ")), code, emotion: emoName || "", state: state || "" };
}
function expandBase(base) {
  const emos = natSort(resolveEmotions(base.emotions));
  const states = hasPregnancy(base.pregnancy)
    ? base.pregnancy_state === "both" ? ["before", "after"] : [base.pregnancy_state]
    : [null];
  const out = [];
  for (const e of emos.length ? emos : [null]) for (const s of states) out.push(renderItem(base, e, s));
  return out;
}

// ================================================================ 정규화
const clone = (o) => JSON.parse(JSON.stringify(o ?? {}));
const normPath = (v) => String(v ?? "").replace(/\\/g, "/").split("/").map((x) => x.trim()).filter((x) => x && x !== "." && x !== "..").join("/");
const FIELD_RENAMES = { appearance: { body: "body_front", nude: "nude_front" } }; // 이전 버전 칸 이름
function normExtras(v) {
  const out = [], seen = new Set();
  for (const e of Array.isArray(v) ? v : []) {
    const name = String(e?.name ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, positive: e.positive ?? "", negative: e.negative ?? "" });
  }
  return out;
}
function normPrefab(sec, d = {}) {
  const fields = {};
  const src = { ...(d.fields || {}) };
  for (const [o, n] of Object.entries(FIELD_RENAMES[sec] || {})) if (o in src && !(n in src)) src[n] = src[o];
  for (const k of fieldKeys(sec)) fields[k] = src[k] ?? "";
  const out = { code: d.code ?? "", fields, weight: d.weight ?? 1, negative: d.negative ?? "", note: d.note ?? "" };
  if (sec === "emotion") {
    out.groups = { ...(d.groups || {}) };
    const v = d.background?.variant;
    out.background = { prefab: d.background?.prefab ?? "", variant: ["main", "indoor", "outdoor", "none"].includes(v) ? v : "main" };
    const r = d.resolution || {};
    out.resolution = { mode: r.mode === "custom" ? "custom" : "node", width: r.width || 1024, height: r.height || 1024 };
    const dp = defaultParts();
    out.parts = {};
    for (const s2 of PART_SECTIONS) {
      const raw = { ...(d.parts?.[s2] || {}) };
      for (const [o, n] of Object.entries(FIELD_RENAMES[s2] || {})) if (o in raw && !(n in raw)) raw[n] = raw[o];
      out.parts[s2] = {};
      for (const k of Object.keys(dp[s2])) out.parts[s2][k] = raw[k] ?? dp[s2][k];
    }
    out.extras = Object.fromEntries(Object.entries(d.extras || {}).filter(([k, v]) => v && k.trim()).map(([k]) => [k, true]));
    const pf = String(d.outfit?.prefab ?? "").trim();
    const sl = ["node", "prefab", ...Object.keys(charSlots())].includes(d.outfit?.slot) ? d.outfit.slot : pf ? "prefab" : "node";
    out.outfit = { slot: sl, prefab: pf, code: String(d.outfit?.code ?? "").trim() };
    out.path = d.path == null ? (STATE.default_path ?? "점검중") : normPath(d.path); // 감정별 추가 경로 (기본 '점검중')
    out.folder = normPath(d.folder || "");
  }
  if (sec === "appearance") {
    out.extras = normExtras(d.extras);
    out.outfits = Object.fromEntries(Object.keys(charSlots()).map((k) => [k, String(d.outfits?.[k] ?? "").trim()]));
  }
  if (sec === "background" && !("main" in (d.fields || {})) && d.fields?.scene != null) { // 옛 필드
    fields.main = d.fields.scene || "";
    fields.common = [d.fields.lighting, d.fields.composition].filter((x) => x && x.trim()).join(", ");
  }
  return out;
}
const normState = (d = {}) => ({ code: d.code ?? "", prompt: d.prompt ?? "", negative: d.negative ?? "" });
const normPregnancy = (d = {}) => ({
  before: normState(d.before), after: normState(d.after), weight: d.weight ?? 1, note: d.note ?? "",
});
function normBase(d = {}) {
  const b = {};
  for (const s of BASE_SECTIONS) b[s] = { name: d[s]?.name ?? "", ...normPrefab(s, d[s] || {}) };
  b.pregnancy = { name: d.pregnancy?.name ?? "", ...normPregnancy(d.pregnancy || {}) };
  b.emotions = Array.isArray(d.emotions) ? [...d.emotions] : d.emotion?.name ? [d.emotion.name] : [];
  b.pregnancy_state = ["before", "after", "both"].includes(d.pregnancy_state) ? d.pregnancy_state : "before";
  for (const [k] of GENERAL) b[k] = d[k] ?? "";
  b.note = d.note ?? "";
  return b;
}
function normalize(tab, d) {
  if (tab === "emotion_group") return { emotions: [...new Set((d?.emotions || []).map((x) => String(x).trim()).filter(Boolean))], note: d?.note ?? "" };
  if (tab === "character") return normBase(d);
  if (tab === "pregnancy") return normPregnancy(d);
  return normPrefab(tab, d);
}
function newDraft(tab) {
  const d = normalize(tab, {});
  if (tab === "character") d.quality = "masterpiece, best quality";
  return d;
}
// 자연 정렬: 이름 속 숫자는 숫자 크기로 비교 (1, 2, 3 … 10, 11)
const natCmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
const natSort = (arr) => [...arr].sort(natCmp);
const sortedNames = (tab) => natSort(Object.keys(STATE.collections[tab] || {}));
function nextCode(prefix, used) {
  let n = 1;
  while (used.has(`${prefix}${String(n).padStart(2, "0")}`)) n++;
  return `${prefix}${String(n).padStart(2, "0")}`;
}
function usedCodes(tab, exclude) {
  const s = new Set();
  for (const [n, v] of Object.entries(STATE.collections[tab] || {})) {
    if (n === exclude) continue;
    if (tab === "pregnancy") ["before", "after"].forEach((k) => v?.[k]?.code && s.add(v[k].code));
    else if (v?.code) s.add(v.code);
  }
  return s;
}

// ================================================================ 그래프 / 노드
const graphNodesAll = () => app.graph?._nodes || app.graph?.nodes || [];
const graphNodes = () => graphNodesAll().filter((n) => TARGETS.includes(n.comfyClass || n.type));
const widgetNamed = (node, name) => (node?.widgets || []).find((w) => w.name === name);
const widgetFor = (node, tab) => (node?.widgets || []).find((w) => COMBO_COLL[w.name] === tab && w.type === "combo");
const splitList = (v) => String(v || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
const tidyName = (v) => String(v).replace(/([_\-. ])[_\-. ]+/g, "$1").replace(/^[_\-. ]+|[_\-. ]+$/g, "").trim();
/** 이름에서 숫자만 지우기("digits") 또는 문자만 지우기("letters"). 구분자는 정리됨 */
const stripName = (name, mode) =>
  tidyName(mode === "digits" ? String(name).replace(/[0-9]/g, "") : String(name).replace(/[^0-9_\-. ]/g, ""));
/** 바꾼 이름들의 충돌을 피해 [원래이름, 새이름] 목록을 만든다 (빈 이름·그대로인 것은 제외) */
function renamePlan(names, fn, existing) {
  const taken = new Set(Object.keys(existing).filter((n) => !names.includes(n)));
  const out = [];
  for (const n of names) {
    let base = fn(n);
    if (!base || base === n) continue;
    let name = base, i = 2;
    while (taken.has(name)) name = `${base}_${i++}`;
    taken.add(name);
    out.push([n, name]);
  }
  return out;
}
function comboValues(widgetName) {
  const names = sortedNames(COMBO_COLL[widgetName]);
  return [widgetName.endsWith("_override") ? STATE.keep : STATE.none, ...names];
}
function refreshAllCombos(rename) {
  for (const node of graphNodes()) {
    for (const w of node.widgets || []) {
      const coll = COMBO_COLL[w.name];
      if (!coll || w.type !== "combo") continue;
      const values = comboValues(w.name);
      w.options.values = values;
      if (rename && rename.collection === coll && w.value === rename.from) w.value = rename.to;
      if (!values.includes(w.value)) w.value = values[0];
    }
    const ew = widgetNamed(node, "emotions"); // 감정 이름 변경 반영
    if (ew && rename?.collection === "emotion") {
      ew.value = splitList(ew.value).map((x) => (x === rename.from ? rename.to : x)).join(", ");
    }
    updatePanel(node);
  }
  app.graph?.setDirtyCanvas(true, true);
}
// ---------------------------------------------------------------- 표 편집 창 (별도 창)
const SHEET_URL = new URL("sheet.html", import.meta.url).href;
let sheetWin = null;
function openSheet() {
  if (sheetWin && !sheetWin.closed) { sheetWin.focus(); return; }
  sheetWin = window.open(SHEET_URL, "charprefab_sheet", "width=1280,height=820");
  if (!sheetWin) toast("팝업이 차단됐습니다. 이 사이트의 팝업을 허용해 주세요.", "warn");
}
// 표 편집 창 ↔ ComfyUI 양방향 반영
const bus = "BroadcastChannel" in window ? new BroadcastChannel("charprefab") : null;
let fromSelf = false;
function announceChange() {
  if (!bus) return;
  fromSelf = true;
  bus.postMessage({ type: "changed", from: "comfy" });
  setTimeout(() => (fromSelf = false), 300);
}
bus?.addEventListener("message", async (e) => {
  if (fromSelf || e.data?.from === "comfy") return;
  // 표 편집 창이 현재 워크플로의 그룹 목록을 물어봄
  if (e.data?.type === "groupsRequest") {
    bus.postMessage({
      type: "groupsReply", from: "comfy",
      groups: graphGroups().map((g) => ({ title: g.title, state: groupState(g) })),
    });
    return;
  }
  // 표 편집 창에서 "노드에서 켜기/끄기"
  if (e.data?.type === "emotionSelect") {
    const names = e.data.names || [];
    for (const n of graphNodes()) {
      const cur = selectedEmotions(n);
      if (!widgetNamed(n, "emotions")) continue;
      setEmotionWidget(n, e.data.action === "add"
        ? [...cur, ...names.filter((x) => !cur.includes(x))]
        : cur.filter((x) => !names.includes(x)));
    }
    toast(`표에서 감정 ${names.length}개 ${e.data.action === "add" ? "켬" : "끔"}`);
    return;
  }
  try {
    await fetchData();
    refreshAllCombos();
    updateAllPanels();
    document.dispatchEvent(new CustomEvent("charprefab:external"));  // 매니저가 열려 있으면 다시 그림
  } catch (err) { console.warn("[CharacterPrefab]", err); }
});

/** 버튼이 여러 개인 확인 창. 고른 버튼의 번호를 돌려주고, 취소하면 -1 */
function askChoice(title, body, labels) {
  injectStyle();
  return new Promise((resolve) => {
    let done = false;
    const finish = (i) => { if (done) return; done = true; document.removeEventListener("keydown", onKey, true); ov.remove(); resolve(i); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); finish(-1); } };
    const ov = el("div", { className: "cpm-overlay cpm", style: { zIndex: 10002 } },
      el("div", { className: "cpm-ask" },
        el("h3", {}, title),
        body ? el("div", { className: "cpm-askbody" }, body) : null,
        el("div", { className: "cpm-actions", style: { justifyContent: "flex-end" } },
          labels.map((l, i) => el("button", {
            className: i === 0 ? "primary" : l.danger ? "danger" : "",
            onclick: () => finish(i),
          }, typeof l === "string" ? l : l.text)),
          el("button", { onclick: () => finish(-1) }, "취소"))));
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) finish(-1); });
    document.addEventListener("keydown", onKey, true);
    document.body.append(ov);
  });
}

/** 지워진 감정들을 모든 노드의 선택 목록에서 뺀다 */
function dropEmotionsFromNodes(names) {
  const gone = new Set(names);
  for (const n of graphNodes()) {
    const ew = widgetNamed(n, "emotions");
    if (ew) ew.value = splitList(ew.value).filter((x) => !gone.has(x)).join(", ");
  }
  app.graph?.setDirtyCanvas(true, true);
  updateAllPanels();
}

/** 여러 감정 이름이 한꺼번에 바뀌었을 때 노드의 선택 목록을 새 이름으로 */
function applyRenamesToNodes(map) {
  for (const n of graphNodes()) {
    const ew = widgetNamed(n, "emotions");
    if (ew) ew.value = splitList(ew.value).map((x) => map[x] ?? x).join(", ");
  }
  app.graph?.setDirtyCanvas(true, true);
  updateAllPanels();
}

function toast(msg, severity = "success") {
  const t = app.extensionManager?.toast;
  if (t?.add) t.add({ severity, summary: msg, life: 2500 });
  else console.log("[CharacterPrefab]", msg);
}

// ---------------------------------------------------------------- 그룹 (Fast Groups Muter 방식)
const graphGroups = () => [...(app.graph?._groups || app.graph?.groups || [])];
function nodesInGroup(group) {
  try {
    group.recomputeInsideNodes?.();
    let arr = group._nodes || group.nodes;
    if (arr && typeof arr[Symbol.iterator] === "function") {
      arr = [...arr].filter((n) => n && typeof n.mode === "number" && n.id !== undefined && "inputs" in n);
      if (arr.length) return arr;
    }
  } catch (e) { /* 아래 폴백 */ }
  const [gx, gy] = group.pos || [0, 0];
  const [gw, gh] = group.size || [0, 0];
  return graphNodesAll().filter((n) => {
    const cx = n.pos[0] + (n.size?.[0] || 0) / 2;
    const cy = n.pos[1] + (n.size?.[1] || 0) / 2;
    return cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh;
  });
}
function groupState(group) {
  const modes = new Set(nodesInGroup(group).map((n) => n.mode));
  if (!modes.size) return "empty";
  if (modes.size > 1) return "mixed";
  const m = [...modes][0];
  return m === 0 ? "on" : m === 2 ? "mute" : m === 4 ? "bypass" : "mixed";
}
function applyGroupConfig(cfg) {
  for (const g of graphGroups()) {
    const act = cfg?.[g.title];
    if (!act || !(act in MODE)) continue;
    for (const n of nodesInGroup(g)) n.mode = MODE[act];
  }
  app.graph?.setDirtyCanvas(true, true);
}
const snapshotModes = () => new Map(graphNodesAll().map((n) => [n.id, n.mode]));
function restoreModes(snap) {
  for (const n of graphNodesAll()) if (snap.has(n.id)) n.mode = snap.get(n.id);
  app.graph?.setDirtyCanvas(true, true);
}

function allExtraNames() {
  const set = new Set();
  for (const v of Object.values(STATE.collections.appearance || {})) normExtras(v?.extras).forEach((x) => set.add(x.name));
  for (const v of Object.values(STATE.collections.character || {})) normExtras(v?.appearance?.extras).forEach((x) => set.add(x.name));
  return natSort(set);
}

// ---------------------------------------------------------------- 감정 폴더 (정리용)
const emoFolder = (n) => normPath(emoItems()[n]?.folder || "");
function folderGroups(names) {           // [[폴더, [감정…]], …]  폴더 없음이 맨 앞, 나머지는 숫자 순
  const m = new Map();
  for (const n of names) { const f = emoFolder(n); if (!m.has(f)) m.set(f, []); m.get(f).push(n); }
  return [...m.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : natCmp(a, b))).map((f) => [f, natSort(m.get(f))]);
}
const allFolders = () => natSort([...new Set(Object.keys(emoItems()).map(emoFolder).filter(Boolean))]);
function setState(sel, members) {
  const k = members.filter((e) => sel.includes(e)).length;
  return !members.length ? "empty" : k === members.length ? "all" : k ? "some" : "none";
}
function toggleMembers(node, members) {
  const sel = selectedEmotions(node);
  setEmotionWidget(node, setState(sel, members) === "all" ? sel.filter((e) => !members.includes(e)) : [...sel, ...members.filter((e) => !sel.includes(e))]);
}

// ---------------------------------------------------------------- 감정 묶음
const bundleItems = () => STATE.collections.emotion_group || {};
const bundleNames = () => Object.keys(bundleItems()); // 만든 순서
const bundleMembers = (b) => natSort((bundleItems()[b]?.emotions || []).filter((e) => emoItems()[e]));
function bundleState(sel, b) {
  const m = bundleMembers(b);
  const k = m.filter((e) => sel.includes(e)).length;
  return !m.length ? "empty" : k === m.length ? "all" : k ? "some" : "none";
}
// 묶음 전부 켜져 있으면 끄고, 아니면 전부 켬
function toggleBundle(node, b) {
  const sel = selectedEmotions(node);
  const m = bundleMembers(b);
  setEmotionWidget(node, bundleState(sel, b) === "all" ? sel.filter((e) => !m.includes(e)) : [...sel, ...m.filter((e) => !sel.includes(e))]);
}
const setAllEmotions = (node, on) => setEmotionWidget(node, on ? Object.keys(emoItems()) : []);

// ---------------------------------------------------------------- 감정 선택 / 감정별 실행
function selectedEmotions(node) {
  return natSort(resolveEmotions(widgetNamed(node, "emotions")?.value || "")); // 생성 순서 = 숫자 순
}
function setEmotionWidget(node, names) {
  const w = widgetNamed(node, "emotions");
  if (!w) return;
  w.value = natSort(names).join(", ");
  w.callback?.(w.value);
  updatePanel(node);
  app.graph?.setDirtyCanvas(true, true);
}

// ---------------------------------------------------------------- Run 가로채기: 감정(×임신 상태)마다 별도 작업
const SPLIT_NODES = ["CharacterPrefabComposer", "CharacterLoad"];
let ORIG_QUEUE = null;
let SPLITTING = false;
const isSplitMode = (node) => String(widgetNamed(node, "run_mode")?.value || "").startsWith("감정마다");
const stateLabel = (key) => Object.entries(STATE.state_choices).find(([, v]) => v === key)?.[0];

function itemStates(node) {
  if (!STATE.collections.pregnancy?.[widgetNamed(node, "pregnancy")?.value]) return [null];
  const k = STATE.state_choices[widgetNamed(node, "pregnancy_state")?.value] || "before";
  return k === "both" ? ["before", "after"] : [k];
}

function buildSplitPlan() {
  const nodes = graphNodesAll().filter((n) => SPLIT_NODES.includes(n.comfyClass || n.type) && n.mode === 0 && isSplitMode(n));
  if (!nodes.length) return null;
  if (nodes.length > 1) toast("'감정마다 따로 실행' 노드가 여러 개입니다. 첫 번째 노드 기준으로 나눕니다.", "warn");
  const node = nodes[0];
  const emotions = selectedEmotions(node);
  const states = itemStates(node);
  const items = [];
  for (const e of emotions.length ? emotions : [null]) for (const st of states) items.push({ emotion: e, state: st });
  const hasGroups = items.some((it) => it.emotion && Object.keys(emoItems()[it.emotion]?.groups || {}).length);
  if (items.length <= 1 && !hasGroups) return null; // 나눌 필요 없음
  return { node, items };
}

async function runSplit(plan, args) {
  const { node, items } = plan;
  const ew = widgetNamed(node, "emotions");
  const sw = widgetNamed(node, "pregnancy_state");
  const orig = { e: ew?.value, s: sw?.value };
  const snap = snapshotModes();
  let queued = 0, result;
  SPLITTING = true;
  try {
    for (const it of items) {
      restoreModes(snap);
      if (it.emotion) applyGroupConfig(emoItems()[it.emotion]?.groups || {});
      if (node.mode !== 0) { toast(`'${it.emotion}' 그룹 설정이 이 노드를 꺼서 건너뜁니다`, "warn"); continue; }
      if (ew && it.emotion) ew.value = it.emotion;
      if (sw && it.state) sw.value = stateLabel(it.state) ?? sw.value;
      result = await ORIG_QUEUE(...args);
      queued++;
    }
  } finally {
    SPLITTING = false;
    if (ew) ew.value = orig.e;
    if (sw) sw.value = orig.s;
    restoreModes(snap);
  }
  if (queued) toast(`${queued}개 작업으로 나눠 큐에 추가했습니다 (감정별 그룹 설정 적용)`);
  return result;
}

function installQueueHook() {
  if (ORIG_QUEUE || typeof app.queuePrompt !== "function") return;
  ORIG_QUEUE = app.queuePrompt.bind(app);
  app.queuePrompt = async function (...args) {
    if (SPLITTING || !STATE) return ORIG_QUEUE(...args);
    let plan = null;
    try {
      if (graphNodesAll().some((n) => SPLIT_NODES.includes(n.comfyClass || n.type))) await fetchData(); // 최신 감정/그룹 설정
      plan = buildSplitPlan();
    } catch (e) { console.warn("[CharacterPrefab] split plan", e); }
    return plan ? runSplit(plan, args) : ORIG_QUEUE(...args);
  };
}

// ================================================================ 스타일
function injectStyle() {
  if (document.getElementById("cpm-style")) return;
  const s = document.createElement("style");
  s.id = "cpm-style";
  s.textContent = `
.cpm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;align-items:center;justify-content:center}
.cpm-panel{width:min(1100px,96vw);height:min(780px,92vh);background:var(--comfy-menu-bg,#1e1e1e);color:var(--fg-color,#ddd);border:1px solid var(--border-color,#444);border-radius:10px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,.5);font-family:system-ui,sans-serif;font-size:13px}
.cpm-head{display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid var(--border-color,#444);flex-wrap:wrap}
.cpm-title{font-weight:600;font-size:15px;margin-right:10px}
.cpm-tab{background:transparent!important;border:1px solid transparent!important;opacity:.7}
.cpm-tab.on{background:var(--comfy-input-bg,#333)!important;border-color:var(--border-color,#555)!important;opacity:1;font-weight:600}
.cpm-body{flex:1;display:flex;min-height:0}
.cpm-side{width:250px;border-right:1px solid var(--border-color,#444);display:flex;flex-direction:column;padding:8px;gap:6px}
.cpm-list{flex:1;overflow:auto;display:flex;flex-direction:column;gap:2px}
.cpm-item{padding:6px 8px;border-radius:5px;cursor:pointer;overflow:hidden;display:flex;gap:8px;align-items:flex-start;flex-shrink:0}
.cpm-list.compact .cpm-item{padding:3px 8px;align-items:center}
.cpm-list.compact .cpm-item small{display:none}
.cpm-listtools{display:flex;gap:4px}
.cpm .cpm-listtools button{flex:1 1 0;min-width:0;padding:2px 4px;font-size:11px;overflow:hidden;text-overflow:ellipsis}
.cpm .cpm-listtools button.on{background:#3b5bdb;border-color:#3b5bdb;color:#fff}
.cpm-item>div{min-width:0;flex:1}
.cpm-item:hover{background:rgba(127,127,127,.12)}
.cpm-item.on{background:var(--comfy-input-bg,#333);box-shadow:inset 3px 0 0 #5c7cfa}
.cpm-item b{font-weight:500;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cpm-item small{opacity:.55;display:block;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cpm .cpm-item input[type=checkbox]{width:16px;height:16px;margin-top:2px;flex:none;accent-color:#5c7cfa;cursor:pointer}
.cpm-selbar{display:flex;gap:4px;align-items:center;font-size:12px;flex-wrap:wrap}
.cpm-bundle{border-style:dashed}
.cpm-folder{flex-shrink:0;display:flex;align-items:center;gap:6px;padding:5px 6px;margin-top:4px;font-size:12px;font-weight:600;cursor:pointer;border-bottom:1px solid var(--border-color,#444);opacity:.9;user-select:none}
.cpm-folder small{opacity:.55;font-weight:400}
.cpm .cpm-folder input[type=checkbox]{width:16px;height:16px;flex:none;margin:0}
.cpm-folder span{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cpm .cpm-bchk{accent-color:#f59f00!important}
.cpm-item.bsel{box-shadow:inset 3px 0 0 #f59f00!important}
.cpm button.cpm-batchbtn.on{background:#e67700;border-color:#e67700;color:#fff}
.cpm-batchhead{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.cpm-ask{background:var(--comfy-menu-bg,#1e1e1e);border:1px solid var(--border-color,#444);border-radius:10px;padding:16px 18px;max-width:560px;box-shadow:0 12px 48px rgba(0,0,0,.5)}
.cpm-ask h3{margin:0 0 8px;font-size:15px}
.cpm-askbody{font-size:13px;line-height:1.5;word-break:break-word}
.cpm-bon{display:flex;gap:5px;align-items:center;font-size:12px;cursor:pointer;padding-top:4px}
.cpm .cpm-bon input{width:auto}
.cpm-row.off>:last-child{opacity:.45}
.cpm-chip.off{background:rgba(250,82,82,.25);border-color:#fa5252}
.cpm button:disabled{opacity:.4;cursor:default;filter:none}
.cpm-selbar .cnt{flex-basis:100%}
.cpm-selbar button{flex:1}
.cpm-selbar .cpm-chip{white-space:nowrap;font-size:11px;padding:2px 7px}
.cpm-chip.cpm-bundle.some{background:rgba(59,91,219,.35);border-color:#5c7cfa}
.cpm-selbar span{flex:1;opacity:.85}
.cpm .cpm-selbar button{padding:2px 7px;font-size:12px}
.cpm-badge{display:inline-block;font-family:ui-monospace,monospace;font-size:11px;padding:0 5px;border-radius:4px;background:rgba(92,124,250,.18);color:#91a7ff;margin-right:5px;font-weight:500}
.cpm-edit{flex:1;overflow:auto;padding:12px 16px}
.cpm-row{display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:start;margin-bottom:6px}
.cpm-row>label{padding-top:5px;font-size:12px;opacity:.85}
.cpm-grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
.cpm input,.cpm textarea,.cpm select{width:100%;box-sizing:border-box;background:var(--comfy-input-bg,#2a2a2a);color:var(--input-text,#ddd);border:1px solid var(--border-color,#444);border-radius:4px;padding:5px 7px;font:inherit}
.cpm input[readonly]{opacity:.75}
.cpm textarea{resize:vertical;min-height:32px;line-height:1.35}
.cpm button{background:var(--comfy-input-bg,#2a2a2a);color:var(--input-text,#ddd);border:1px solid var(--border-color,#555);border-radius:5px;padding:5px 11px;cursor:pointer;font:inherit;white-space:nowrap}
.cpm button:hover{filter:brightness(1.25)}
.cpm button.primary{background:#3b5bdb;border-color:#3b5bdb;color:#fff}
.cpm button.danger{color:#ff8787}
.cpm button.small{padding:2px 8px;font-size:12px}
.cpm fieldset{border:1px solid var(--border-color,#444);border-radius:6px;margin:12px 0;padding:6px 10px 8px}
.cpm legend{padding:0 6px;font-weight:600;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.cpm legend select{width:auto;font-weight:400;padding:2px 4px}
.cpm legend button{padding:2px 8px;font-weight:400;font-size:12px}
.cpm-preview{font-family:ui-monospace,monospace;font-size:12px;background:rgba(0,0,0,.25);padding:8px 10px;border-radius:5px;white-space:pre-wrap;word-break:break-word;margin-top:10px;max-height:220px;overflow:auto}
.cpm-preview .k{opacity:.55}
.cpm-preview .c{color:#91a7ff}
.cpm-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px;align-items:center}
.cpm-foot{border-top:1px solid var(--border-color,#444);padding:8px 12px;display:flex;gap:10px;align-items:center;font-size:12px}
.cpm-foot .combo{opacity:.85;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cpm-dirty{color:#ffd43b;font-size:12px}
.cpm-hint{opacity:.55;font-size:11px;font-weight:400}
.cpm-chips{display:flex;flex-wrap:wrap;gap:4px}
.cpm-chip{display:flex;align-items:center;gap:2px;padding:3px 8px;border:1px solid var(--border-color,#555);border-radius:12px;cursor:pointer;font-size:12px;user-select:none}
.cpm-chip.on{background:#3b5bdb;border-color:#3b5bdb;color:#fff}
.cpm-gtable{display:grid;grid-template-columns:14px 1fr 100px 150px;gap:4px 8px;align-items:center;margin-top:8px}
.cpm-gtable .sw{width:12px;height:12px;border-radius:3px;border:1px solid rgba(255,255,255,.2)}
.cpm-gtable .st{font-size:11px;opacity:.75}
.cpm-gtable .missing{opacity:.45}
.cpm .cpm-gtable select{padding:2px 4px}
.cpm-gtools{display:flex;gap:6px;flex-wrap:wrap}
.cpm-extra{border:1px dashed var(--border-color,#555);border-radius:6px;padding:6px 8px;margin:6px 0}
.cpm-extra-head{display:flex;gap:8px;align-items:center;margin-bottom:4px}
`;
  document.head.append(s);
}

// 배열/빈 값이 섞여도 안전하게 자식 교체
function fill(node, ...kids) {
  node.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false && k !== ""));
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "style") Object.assign(e.style, v);
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k in e && k !== "list") { try { e[k] = v; } catch { e.setAttribute(k, v); } }
    else e.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) e.append(c);
  return e;
}

// ================================================================ 매니저 창
async function openManager(node, startTab) {
  injectStyle();
  try { await fetchData(); } catch (e) { toast("프리팹 데이터를 불러오지 못했습니다: " + e.message, "error"); return; }

  const ui = { tab: startTab, selected: null, name: "", draft: null, dirty: false, filter: "",
    batch: false, batchSel: new Set(), collapsed: VIEW.collapsed, bulk: null };
  const nodeClass = node?.comfyClass || node?.type;
  const emoWidget = widgetNamed(node, "emotions");
  let updateFooter = null;

  const overlay = el("div", { className: "cpm-overlay cpm" });
  const tabsBox = el("div", { style: { display: "flex", gap: "4px", flexWrap: "wrap" } });
  const selBar = el("div", { className: "cpm-selbar" });
  const batchBtn = el("button", { className: "cpm-batchbtn", onclick: () => setBatch(!ui.batch) });
  const folderList = el("datalist", { id: "cpm-folder-list" });
  const listTools = el("div", { className: "cpm-listtools" });
  const listBox = el("div", { className: "cpm-list" });
  const editBox = el("div", { className: "cpm-edit" });
  const search = el("input", { placeholder: "🔍 이름/코드 검색", oninput: (e) => { ui.filter = e.target.value.toLowerCase(); renderList(); } });
  const panel = el("div", { className: "cpm-panel" },
    el("div", { className: "cpm-head" },
      el("span", { className: "cpm-title" }, "🗂 캐릭터 프리팹 매니저"),
      tabsBox,
      el("span", { style: { flex: 1 } }),
      el("button", { onclick: openSheet, title: "모든 값을 표(스프레드시트)로 한 번에 편집" }, "📊 표로 편집"),
      el("button", { onclick: close, title: "닫기 (Esc)" }, "✕"),
    ),
    el("div", { className: "cpm-body" },
      el("div", { className: "cpm-side" }, search, el("button", { onclick: () => select(null) }, "＋ 새로 만들기"), batchBtn, selBar, listTools, listBox, folderList),
      editBox,
    ),
    SPLIT_NODES.includes(nodeClass) ? buildFooter() : null,
  );
  overlay.append(panel);
  document.body.append(overlay);

  for (const ev of ["keydown", "keyup", "keypress"]) panel.addEventListener(ev, (e) => e.stopPropagation());
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

  // 표 편집 창에서 바뀌면 매니저도 따라 갱신 (편집 중이면 목록만)
  const onExternal = () => {
    if (!document.body.contains(overlay)) return;
    renderTabs(); renderList(); updateFooter?.();
    if (!ui.dirty) {
      if (ui.selected != null && !items()[ui.selected]) select(sortedNames(ui.tab)[0] ?? null, true);
      else if (ui.selected != null) select(ui.selected, true);
    }
  };
  document.addEventListener("charprefab:external", onExternal);

  function close() {
    if (ui.dirty && !confirm("저장하지 않은 변경사항이 있습니다. 닫을까요?")) return;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("charprefab:external", onExternal);
    overlay.remove();
    updateAllPanels();
  }
  const items = () => STATE.collections[ui.tab] || {};
  const confirmDiscard = () => !ui.dirty || confirm("저장하지 않은 변경사항을 버릴까요?");

  function select(name, force = false) {
    if (!force && !confirmDiscard()) return;
    ui.selected = name;
    ui.name = name ?? "";
    ui.draft = name != null ? normalize(ui.tab, clone(items()[name])) : newDraft(ui.tab);
    ui.dirty = false;
    renderList();
    renderEditor();
  }
  function setBatch(on) {
    if (on && !confirmDiscard()) return;
    ui.batch = on;
    ui.dirty = false;
    if (!on && ui.selected == null) { select(sortedNames(ui.tab)[0] ?? null, true); return; }
    renderList();
    renderEditor();
  }
  function setTab(tab, force = false) {
    if (!force && !confirmDiscard()) return;
    ui.tab = tab;
    ui.batch = false;
    ui.dirty = false;
    renderTabs();
    const cur = widgetFor(node, tab)?.value;
    const first = tab === "emotion" ? selectedEmotions(node)[0] : null;
    const pick = [cur, first].find((n) => n && items()[n]);
    select(pick ?? sortedNames(tab)[0] ?? null, true);
  }
  function renderTabs() {
    fill(tabsBox, ...TABS.map((t) =>
      el("button", { className: "cpm-tab" + (t === ui.tab ? " on" : ""), onclick: () => t !== ui.tab && setTab(t) },
        `${TAB_LABEL[t]} (${sortedNames(t).length})`)));
  }

  // ---- 목록
  const codeOf = (tab, d) =>
    tab === "pregnancy" ? [d?.before?.code, d?.after?.code].filter(Boolean).join("/") : ["character", "emotion", "background", "emotion_group"].includes(tab) ? "" : d?.code || "";
  function summary(tab, d) {
    if (tab === "character") {
      const b = normBase(d);
      return [b.appearance.name, b.outfit.name, b.background.name].filter(Boolean).join(" · ") || cleanTags(b.extra);
    }
    if (tab === "pregnancy") return `전: ${cleanTags(d?.before?.prompt)} | 후: ${cleanTags(d?.after?.prompt)}`;
    if (tab === "emotion_group") return `${(d?.emotions || []).length}개 · ${(d?.emotions || []).join(", ")}`;
    if (tab === "emotion") {
      const e = normPrefab("emotion", d);
      const rs = (e.resolution.mode === "custom" ? ` ${e.resolution.width}×${e.resolution.height}` : "") + ` 💾${e.path || "-"}`;
      return `[${STATE.bg_variants[e.background.variant]}${e.background.prefab ? "·" + e.background.prefab : ""}${rs}] ${sectionText("emotion", e)}`;
    }
    if (tab === "background") {
      const f = normPrefab("background", d).fields;
      return ["대표", "실내", "실외"].map((l, i) => `${l}:${[f.main, f.indoor, f.outdoor][i] ? "✔" : "–"}`).join(" ") + ` · ${cleanTags(f.main)}`;
    }
    return sectionText(tab, normPrefab(tab, d));
  }
  const emoSelectable = () => ui.tab === "emotion" && !!emoWidget;
  function toggleEmotion(n, on) {
    const cur = resolveEmotions(emoWidget.value);
    const next = on ? (cur.includes(n) ? cur : [...cur, n]) : cur.filter((x) => x !== n);
    setEmotionWidget(node, next);
    renderList();
    updateFooter?.();
    if (ui.selected === n) renderEditor(true);
  }
  function renderSelBar() {
    if (!emoSelectable()) { fill(selBar); selBar.style.display = "none"; return; }
    selBar.style.display = "flex";
    const n = resolveEmotions(emoWidget.value).length;
    const sel = resolveEmotions(emoWidget.value);
    fill(selBar,
      el("span", { className: "cnt" }, `✔ 이 노드에서 ${n}개 선택`),
      el("button", { onclick: () => { setAllEmotions(node, true); renderList(); updateFooter?.(); } }, "전체 켜기"),
      el("button", { onclick: () => { setAllEmotions(node, false); renderList(); updateFooter?.(); } }, "전체 끄기"),
      bundleNames().length ? el("div", { className: "cpm-chips", style: { width: "100%", marginTop: "2px" } },
        bundleNames().map((b) => {
          const st = bundleState(sel, b);
          return el("span", {
            className: "cpm-chip cpm-bundle" + (st === "all" ? " on" : st === "some" ? " some" : ""),
            title: `📦 ${bundleMembers(b).join(", ")}\n클릭: ${st === "all" ? "묶음 끄기" : "묶음 켜기"}`,
            onclick: () => { toggleBundle(node, b); renderList(); updateFooter?.(); },
          }, `📦 ${b}`);
        })) : null,
    );
  }
  function renderList() {
    renderSelBar();
    const isEmo = ui.tab === "emotion";
    batchBtn.style.display = isEmo ? "" : "none";
    batchBtn.textContent = ui.batch ? `☑ 일괄 작업 중 (${ui.batchSel.size}개 선택) — 끝내기` : "☑ 여러 개 선택해서 일괄 작업";
    batchBtn.classList.toggle("on", ui.batch);
    fill(folderList, allFolders().map((f) => el("option", { value: f })));
    // 목록 도구: 간단히 보기 / 모두 접기 / 모두 펼치기
    const compact = !!VIEW.compact[ui.tab];
    listBox.classList.toggle("compact", compact);
    const folderKeys = isEmo ? folderGroups(Object.keys(emoItems())).map(([fd]) => fd || "\u0000") : [];
    fill(listTools,
      el("button", { className: compact ? "on" : "", title: "이름만 한 줄로 보기", onclick: () => { VIEW.compact[ui.tab] = !compact; renderList(); } }, compact ? "☰ 자세히" : "☰ 간단히"),
      folderKeys.length > 1 ? el("button", { onclick: () => { folderKeys.forEach((k) => ui.collapsed.add(k)); renderList(); } }, "▸ 모두 접기") : null,
      folderKeys.length > 1 ? el("button", { onclick: () => { ui.collapsed.clear(); renderList(); } }, "▾ 모두 펼치기") : null);
    const f = ui.filter;
    const names = sortedNames(ui.tab).filter((n) => !f || n.toLowerCase().includes(f) || codeOf(ui.tab, items()[n]).toLowerCase().includes(f)
      || (isEmo && emoFolder(n).toLowerCase().includes(f)));
    const chosen = emoSelectable() ? resolveEmotions(emoWidget.value) : [];
    const itemRow = (n) => {
      const code = codeOf(ui.tab, items()[n]);
      const chk = isEmo && ui.batch
        ? el("input", {
          type: "checkbox", className: "cpm-bchk", checked: ui.batchSel.has(n), title: "일괄 작업 대상",
          onclick: (e) => { e.stopPropagation(); e.target.checked ? ui.batchSel.add(n) : ui.batchSel.delete(n); renderList(); renderEditor(); },
        })
        : emoSelectable()
          ? el("input", {
            type: "checkbox", checked: chosen.includes(n), title: "이 노드의 감정 목록에 포함",
            onclick: (e) => { e.stopPropagation(); toggleEmotion(n, e.target.checked); },
          })
          : null;
      const onclick = isEmo && ui.batch
        ? () => { ui.batchSel.has(n) ? ui.batchSel.delete(n) : ui.batchSel.add(n); renderList(); renderEditor(); }
        : () => n !== ui.selected && select(n);
      const on = isEmo && ui.batch ? ui.batchSel.has(n) : n === ui.selected;
      return el("div", { className: "cpm-item" + (on ? " on" : "") + (isEmo && ui.batch && on ? " bsel" : ""), onclick, title: n },
        chk,
        el("div", {}, el("b", {}, code ? el("span", { className: "cpm-badge" }, code) : null, n),
          el("small", {}, summary(ui.tab, items()[n]) || "(비어 있음)")));
    };
    let rows;
    const groups = isEmo ? folderGroups(names) : [];
    if (isEmo && (groups.length > 1 || (groups[0] && groups[0][0] !== ""))) {
      rows = [];
      for (const [folder, members] of groups) {
        const key = folder || "\u0000";
        const collapsed = ui.collapsed.has(key) && !f;
        const bst = setState([...ui.batchSel], members);
        rows.push(el("div", {
          className: "cpm-folder", title: "클릭: 접기/펼치기",
          onclick: () => { ui.collapsed.has(key) ? ui.collapsed.delete(key) : ui.collapsed.add(key); renderList(); },
        },
        ui.batch ? el("input", {
          type: "checkbox", className: "cpm-bchk", checked: bst === "all", title: "이 폴더 전체를 일괄 작업 대상으로",
          onclick: (e) => { e.stopPropagation(); members.forEach((m) => (e.target.checked ? ui.batchSel.add(m) : ui.batchSel.delete(m))); renderList(); renderEditor(); },
        }) : null,
        el("span", {}, `${collapsed ? "▸" : "▾"} 📁 ${folder || "(폴더 없음)"}`),
        el("small", {}, ` ${members.length}`)));
        if (!collapsed) rows.push(...members.map(itemRow));
      }
    } else rows = names.map(itemRow);
    if (ui.selected == null && !(isEmo && ui.batch)) rows.unshift(el("div", { className: "cpm-item on" }, el("div", {}, el("b", {}, "✚ 새 항목"), el("small", {}, "저장 전"))));
    if (!rows.length) rows.push(el("div", { className: "cpm-hint", style: { padding: "8px" } }, "항목이 없습니다."));
    fill(listBox, ...rows);
    if (!(isEmo && ui.batch)) listBox.querySelector(".cpm-item.on")?.scrollIntoView({ block: "nearest" }); // 선택 항목이 보이게
  }

  // ---- 편집기 공통
  const dirtyLabel = el("span", { className: "cpm-dirty" });
  const preview = el("div", { className: "cpm-preview" });
  function markDirty() {
    ui.dirty = true;
    dirtyLabel.textContent = "● 저장 안 됨";
    updatePreview();
  }
  const row = (label, input) => el("div", { className: "cpm-row" }, el("label", {}, label), input);
  // (label 자리에 요소를 넣으면 그대로 표시)
  const textArea = (obj, key, rows = 2, placeholder = "") =>
    el("textarea", { rows, value: obj[key] ?? "", placeholder, oninput: (e) => { obj[key] = e.target.value; markDirty(); } });
  const textInput = (obj, key, placeholder = "") =>
    el("input", { value: obj[key] ?? "", placeholder, oninput: (e) => { obj[key] = e.target.value; markDirty(); } });
  const weightInput = (obj) => el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
    el("input", {
      type: "number", min: 0, max: 2, step: 0.05, value: obj.weight, style: { width: "90px" },
      oninput: (e) => { obj.weight = Math.max(0, Math.min(2, parseFloat(e.target.value) || 0)); markDirty(); },
    }),
    el("span", { className: "cpm-hint" }, "1.0 = 그대로, 0 = 제외"));

  let emoCodeMirror = null; // 감정: 이름 입력 → 코드 칸에 그대로 표시
  function codeRow(sec, obj, exclude) {
    const sch = STATE.schema[sec];
    if (sch.has_code === false) return null;
    const next = nextCode(sch.prefix, usedCodes(sec, exclude));
    if (sch.code_is_name) {
      emoCodeMirror = el("input", {
        value: ui.name || "", placeholder: "이름을 입력하면 그대로 감정 코드가 됩니다", readOnly: true,
        title: "감정 코드 = 감정 이름 (이름을 바꾸면 코드도 같이 바뀝니다)",
      });
      return row(`${sch.code_label} (= 이름)`, emoCodeMirror);
    }
    return row(sch.code_label, textInput(obj, "code", `비우면 자동 지정 (${next})`));
  }
  // 캐릭터별 의상 칸 (기본 의상 / 아이돌 의상) — 감정에서 어느 칸을 입힐지 고름
  function charOutfitsEditor(obj) {
    obj.outfits = obj.outfits || {};
    return el("fieldset", {},
      el("legend", {}, "👗 이 캐릭터의 의상", el("span", { className: "cpm-hint" }, "감정 탭에서 '캐릭터 기본/아이돌 의상'을 고르면 이 의상을 입힘")),
      el("div", { className: "cpm-grid2" }, Object.entries(charSlots()).map(([k, l]) => row(l, el("select", {
        onchange: (e) => { obj.outfits[k] = e.target.value; markDirty(); },
      }, el("option", { value: "", selected: !obj.outfits[k] }, "(지정 안 함)"),
      sortedNames("outfit").map((n) => el("option", { value: n, selected: obj.outfits[k] === n },
        `${STATE.collections.outfit[n]?.code ? `[${STATE.collections.outfit[n].code}] ` : ""}${n}`)))))));
  }

  // 캐릭터의 추가 프롬 (이름은 직접 지정, 감정에서 기본 꺼짐 → 켜고 싶은 감정에서만 켬)
  function extrasEditor(obj) {
    obj.extras = obj.extras || [];
    const box = el("fieldset", {});
    const draw = () => {
      const rows = obj.extras.map((x, i) => el("div", { className: "cpm-extra" },
        el("div", { className: "cpm-extra-head" },
          el("input", {
            value: x.name, placeholder: "추가 프롬 이름", style: { width: "180px", fontWeight: "600" },
            onchange: (e) => {
              const v = e.target.value.trim();
              if (!v) { alert("이름을 입력하세요."); e.target.value = x.name; return; }
              if (obj.extras.some((y, j) => j !== i && y.name === v)) { alert(`'${v}' 이(가) 이미 있습니다.`); e.target.value = x.name; return; }
              x.name = v; markDirty();
            },
          }),
          el("span", { className: "cpm-hint" }, "감정 탭에서 켠 감정에만 들어갑니다"),
          el("span", { style: { flex: 1 } }),
          el("button", { className: "small danger", onclick: () => { if (confirm(`'${x.name}' 추가 프롬을 삭제할까요?`)) { obj.extras.splice(i, 1); markDirty(); draw(); } } }, "삭제")),
        el("div", { className: "cpm-grid2" },
          row("➕ 긍정", textArea(x, "positive", 1, "tag, tag, ...")),
          row("➖ 부정", textArea(x, "negative", 1, "tag, tag, ...")))));
      fill(box, 
        el("legend", {}, "✨ 추가 프롬", el("span", { className: "cpm-hint" }, `${obj.extras.length}개`),
          el("button", {
            onclick: () => {
              const name = prompt("추가 프롬 이름 (예: 땀, 상처, 젖은 머리)")?.trim();
              if (!name) return;
              if (obj.extras.some((y) => y.name === name)) { alert(`'${name}' 이(가) 이미 있습니다.`); return; }
              obj.extras.push({ name, positive: "", negative: "" });
              markDirty(); draw();
            },
          }, "＋ 추가 프롬")),
        ...(rows.length ? rows : [el("div", { className: "cpm-hint" }, "＋ 추가 프롬 버튼으로 이름을 붙인 긍정/부정 프롬을 추가하세요. 모든 감정에서 기본은 꺼짐입니다.")]));
    };
    draw();
    return box;
  }
  function prefabFields(sec, obj, { note = true, compact = false, exclude = null } = {}) {
    const rows = STATE.schema[sec].fields.map((f) => row(f.label, textArea(obj.fields, f.key, compact ? 1 : 2, "tag, tag, ...")));
    return [
      codeRow(sec, obj, exclude),
      compact ? el("div", { className: "cpm-grid2" }, rows) : rows,
      sec === "appearance" ? charOutfitsEditor(obj) : null,
      sec === "appearance" ? extrasEditor(obj) : null,
      row("가중치", weightInput(obj)),
      row("네거티브", textArea(obj, "negative", 1)),
      note ? row("메모", textInput(obj, "note")) : null,
    ];
  }
  function pregFields(obj, compact = false) {
    const P = STATE.pregnancy;
    const block = (k) => el("fieldset", {},
      el("legend", {}, P.label[k]),
      row(`${P.label[k]} 코드`, textInput(obj[k], "code", `비우면 자동 지정 (${P.prefix[k]}01…)`)),
      row("프롬프트", textArea(obj[k], "prompt", compact ? 1 : 2, "tag, tag, ...")),
      row("네거티브", textArea(obj[k], "negative", 1)));
    return [el("div", { className: "cpm-grid2" }, block("before"), block("after")), row("가중치", weightInput(obj))];
  }

  // ---- 감정 묶음 편집기
  function bundleEditor(d) {
    const box = el("div", {});
    const draw = () => {
      const all = natSort(Object.keys(emoItems()));
      const missing = d.emotions.filter((e) => !emoItems()[e]);
      fill(box,
        el("fieldset", {},
          el("legend", {}, "📦 묶을 감정", el("span", { className: "cpm-hint" }, `${d.emotions.length}개 선택`),
            el("button", { onclick: () => { d.emotions = [...all]; markDirty(); draw(); } }, "전부"),
            el("button", { onclick: () => { d.emotions = []; markDirty(); draw(); } }, "비우기")),
          el("div", { className: "cpm-chips" }, all.map((n) => {
            const on = d.emotions.includes(n);
            return el("span", {
              className: "cpm-chip" + (on ? " on" : ""),
              onclick: () => { d.emotions = on ? d.emotions.filter((x) => x !== n) : [...d.emotions, n]; markDirty(); draw(); },
            }, (on ? "✔ " : "") + n);
          })),
          missing.length ? el("div", { className: "cpm-hint", style: { marginTop: "6px" } }, `없는 감정(무시됨): ${missing.join(", ")}`) : null),
        row("메모", textInput(d, "note")));
    };
    draw();
    return box;
  }

  // ---- 감정별: 캐릭터/의상의 어느 칸을 넣을지 + 전투 프롬
  function emotionPartsEditor(d) {
    const box = el("fieldset", {});
    const draw = () => {
      const chips = (sec, skip = []) => el("div", { className: "cpm-chips" },
        STATE.schema[sec].fields.filter((f) => !skip.includes(f.key)).map((f) => {
          const on = d.parts[sec][f.key];
          return el("span", {
            className: "cpm-chip" + (on ? " on" : ""), title: on ? "넣음 — 클릭하면 뺌" : "뺌 — 클릭하면 넣음",
            onclick: () => { d.parts[sec][f.key] = !on; markDirty(); draw(); },
          }, (on ? "✔ " : "✕ ") + f.label.replace(/\s*\([^)]{4,}\)$/, ""));
        }));
      const setAll = (sec, v) => { for (const k of Object.keys(d.parts[sec])) if (k !== "combat") d.parts[sec][k] = v; markDirty(); draw(); };
      const tools = (sec) => el("div", { style: { display: "flex", gap: "4px", marginTop: "4px" } },
        el("button", { className: "small", onclick: () => setAll(sec, true) }, "전부 넣기"),
        el("button", { className: "small", onclick: () => setAll(sec, false) }, "전부 빼기"),
        el("button", { className: "small", onclick: () => { const c = d.parts.appearance.combat; d.parts[sec] = defaultParts()[sec]; if (sec === "appearance") d.parts.appearance.combat = c; markDirty(); draw(); } }, "기본값"));
      const combatOn = !!d.parts.appearance.combat;
      const extraChips = () => {
        const names = allExtraNames();
        d.extras = d.extras || {};
        if (!names.length) return el("span", { className: "cpm-hint" }, "캐릭터 탭에서 '＋ 추가 프롬'으로 만들면 여기에 나옵니다 (기본 꺼짐)");
        return el("div", { className: "cpm-chips" }, names.map((n) => {
          const on = !!d.extras[n];
          return el("span", {
            className: "cpm-chip" + (on ? " on" : ""), title: on ? "켜짐 — 클릭하면 끔" : "꺼짐(기본) — 클릭하면 켬",
            onclick: () => { if (on) delete d.extras[n]; else d.extras[n] = true; markDirty(); draw(); },
          }, (on ? "✔ " : "✕ ") + n);
        }));
      };
      fill(box, 
        el("legend", {}, "🧩 이 감정에 넣을 프롬", el("span", { className: "cpm-hint" }, "파랑 = 넣음, 회색 = 뺌")),
        row("⚔ 전투 프롬", el("div", { className: "cpm-chips" },
          el("span", { className: "cpm-chip" + (combatOn ? " on" : ""), onclick: () => { d.parts.appearance.combat = true; markDirty(); draw(); } }, "켜기"),
          el("span", { className: "cpm-chip" + (!combatOn ? " on" : ""), onclick: () => { d.parts.appearance.combat = false; markDirty(); draw(); } }, "끄기"),
          el("span", { className: "cpm-hint", style: { alignSelf: "center" } }, "캐릭터의 '전투' 칸을 이 감정에 넣을지"))),
        row("👤 캐릭터", el("div", {}, chips("appearance", ["combat"]), tools("appearance"))),
        row("✨ 추가 프롬", extraChips()),
        row("👗 의상", el("div", {}, chips("outfit"), tools("outfit"))),
      );
    };
    draw();
    return box;
  }

  // ---- 감정별 추가 경로 (저장 폴더)
  function emotionPathEditor(d) {
    const box = el("fieldset", {});
    const def = STATE.default_path ?? "점검중";
    const draw = () => {
      const code = "C01_O01_" + (ui.name || "감정");
      fill(box,
        el("legend", {}, "💾 이 감정의 추가 경로", el("span", { className: "cpm-hint" }, "extra_path / save_path 출력으로 나감")),
        row("추가 경로", el("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } },
          el("input", {
            value: d.path, placeholder: "비우면 경로 없음 (예: 점검중, 완료/전투)", style: { width: "260px" },
            oninput: (e) => { d.path = e.target.value; markDirty(); },
            onchange: (e) => { d.path = normPath(e.target.value); markDirty(); draw(); },
          }),
          el("button", { className: "small", onclick: () => { d.path = def; markDirty(); draw(); } }, `기본값 (${def})`),
          el("button", { className: "small", onclick: () => { d.path = ""; markDirty(); draw(); } }, "비우기"))),
        row("", el("div", { className: "cpm-hint" },
          `→ save_path 예: ${[normPath(d.path), code].filter(Boolean).join("/")}  (Save Image 의 filename_prefix 에 연결하면 이 폴더에 저장)`)),
      );
    };
    draw();
    return box;
  }

  // ---- 감정별 의상 / 의상 코드
  function emotionOutfitEditor(d) {
    const box = el("fieldset", {});
    const draw = () => {
      const o = d.outfit;
      const src = o.slot === "prefab" && o.prefab ? STATE.collections.outfit?.[o.prefab] : null;
      const effCode = o.code || (src ? src.code : "");
      // 노드의 현재 캐릭터로 미리보기
      const charName = widgetNamed(node, "appearance")?.value;
      const charData = STATE.collections.appearance?.[charName];
      const slotPreview = o.slot in charSlots()
        ? (charData ? `→ 지금 노드 캐릭터 '${charName}' 의 ${charSlots()[o.slot]}: ${normPrefab("appearance", charData).outfits[o.slot] || "(지정 안 됨 → 노드 의상 사용)"}` : "→ 캐릭터마다 지정한 의상을 입힙니다 (캐릭터 탭에서 지정)")
        : "";
      fill(box,
        el("legend", {}, "👗 이 감정의 의상", el("span", { className: "cpm-hint" }, "캐릭터 기본 의상 / 아이돌 의상 / 특정 의상 중 선택")),
        row("입힐 의상", el("select", {
          onchange: (e) => { applyOutfitChoice(o, e.target.value); markDirty(); draw(); },
        }, outfitChoiceOptions().map(([v, l], i) => [
          i === 1 + Object.keys(charSlots()).length ? el("option", { disabled: true }, "── 특정 의상 ──") : null,
          el("option", { value: v, selected: outfitChoiceValue(o) === v }, l),
        ]))),
        slotPreview ? row("", el("div", { className: "cpm-hint" }, slotPreview)) : "",
        row("의상 코드", el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
          el("input", {
            value: o.code, placeholder: src ? `비우면 ${src.code}` : "비우면 입힌 의상의 코드", style: { width: "200px" },
            oninput: (e) => { o.code = e.target.value.trim(); markDirty(); },
            onchange: () => draw(),
          }),
          el("span", { className: "cpm-hint" }, "직접 적으면 의상은 그대로 두고 code / outfit_code 출력만 이 값으로"))),
        effCode ? row("", el("div", { className: "cpm-hint" }, `→ 이 감정의 의상 코드: ${effCode}`)) : "",
      );
    };
    draw();
    return box;
  }

  // ---- 감정별 해상도
  function emotionResEditor(d) {
    const box = el("fieldset", {});
    const r = d.resolution;
    const snap = (v) => Math.max(64, Math.min(8192, Math.floor((parseInt(v) || 0) / 8) * 8));
    const draw = () => {
      const custom = r.mode === "custom";
      const presets = (STATE.res_presets || []).map(([l, w, h]) => el("span", {
        className: "cpm-chip" + (custom && r.width === w && r.height === h ? " on" : ""),
        onclick: () => { Object.assign(r, { mode: "custom", width: w, height: h }); markDirty(); draw(); },
      }, `${l} ${w}×${h}`));
      const num = (key) => el("input", {
        type: "number", min: 64, max: 8192, step: 8, value: r[key], disabled: !custom, style: { width: "100px" },
        onchange: (e) => { r[key] = snap(e.target.value); e.target.value = r[key]; markDirty(); draw(); },
      });
      fill(box, 
        el("legend", {}, "📐 이 감정의 해상도", el("span", { className: "cpm-hint" }, "width / height 출력으로 나감")),
        row("설정", el("div", { className: "cpm-chips" },
          el("span", { className: "cpm-chip" + (!custom ? " on" : ""), onclick: () => { r.mode = "node"; markDirty(); draw(); } }, "노드 설정 따름"),
          el("span", { className: "cpm-chip" + (custom ? " on" : ""), onclick: () => { r.mode = "custom"; markDirty(); draw(); } }, "직접 지정"))),
        row("빠른 선택", el("div", { className: "cpm-chips" }, presets)),
        row("가로 × 세로", el("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
          num("width"), "×", num("height"),
          el("button", { className: "small", disabled: !custom, onclick: () => { [r.width, r.height] = [r.height, r.width]; markDirty(); draw(); } }, "⇄ 가로/세로 바꾸기"),
          el("span", { className: "cpm-hint" }, "8의 배수로 맞춰집니다"))),
      );
    };
    draw();
    return box;
  }

  // ---- 감정별 배경 선택
  function emotionBgEditor(d) {
    const V = STATE.bg_variants;
    const box = el("fieldset", {});
    const draw = () => {
      const bgName = d.background.prefab;
      const radios = Object.entries(V).map(([k, l]) => el("label", {
        className: "cpm-chip" + (d.background.variant === k ? " on" : ""),
        onclick: () => { d.background.variant = k; markDirty(); draw(); },
      }, l));
      const src = bgName ? STATE.collections.background?.[bgName] : null;
      const peek = src ? backgroundText(normPrefab("background", src), d.background.variant) : "";
      fill(box, 
        el("legend", {}, "🏙 이 감정의 배경", el("span", { className: "cpm-hint" }, "이 감정으로 뽑을 때 쓸 배경")),
        row("배경 종류", el("div", { className: "cpm-chips" }, radios)),
        row("배경 프리팹", el("select", {
          onchange: (e) => { d.background.prefab = e.target.value; markDirty(); draw(); },
        }, el("option", { value: "", selected: !bgName }, "(노드에서 고른 배경 사용)"),
        sortedNames("background").map((n) => el("option", { value: n, selected: bgName === n }, n)))),
        peek ? row("", el("div", { className: "cpm-hint" }, `→ ${peek}`)) : "",
      );
    };
    draw();
    return box;
  }

  // ---- 감정별 그룹 설정 (Fast Groups Muter)
  function groupEditor(d) {
    const box = el("fieldset", {});
    const actionSelect = (title) => el("select", {
      onchange: (e) => {
        d.groups = d.groups || {};
        if (e.target.value) d.groups[title] = e.target.value;
        else delete d.groups[title];
        markDirty();
      },
    }, GROUP_ACTIONS.map(([v, l]) => el("option", { value: v, selected: (d.groups?.[title] || "") === v }, l)));
    const draw = () => {
      const groups = graphGroups();
      const titles = new Set(groups.map((g) => g.title));
      const rows = [];
      for (const g of groups) {
        const st = { on: "켜짐", mute: "뮤트", bypass: "바이패스", mixed: "섞임", empty: "비어 있음" }[groupState(g)];
        const mine = node && nodesInGroup(g).includes(node);
        rows.push(
          el("div", { className: "sw", style: { background: g.color || "#888" } }),
          el("div", {}, g.title, mine ? el("span", { className: "cpm-hint" }, "  ⚠ 이 노드가 들어있는 그룹") : null),
          el("div", { className: "st" }, `현재: ${st}`),
          actionSelect(g.title));
      }
      for (const t of Object.keys(d.groups || {}).filter((t) => !titles.has(t))) {
        rows.push(el("div", {}), el("div", { className: "missing" }, t), el("div", { className: "st missing" }, "워크플로에 없음"), actionSelect(t));
      }
      fill(box, 
        el("legend", {}, "🎛 그룹 설정 (Fast Groups Muter)", el("span", { className: "cpm-hint" }, "'감정마다 따로 실행' 모드에서 Run 할 때 이 감정에 적용")),
        el("div", { className: "cpm-gtools" },
          el("button", { className: "small", onclick: captureCurrent, title: "지금 워크플로의 그룹 켜짐/꺼짐 상태를 이 감정 설정으로" }, "📥 현재 상태 가져오기"),
          el("button", { className: "small", onclick: () => { applyGroupConfig(d.groups); draw(); toast("이 감정의 그룹 설정을 워크플로에 적용했습니다"); } }, "▶ 지금 적용해보기"),
          el("button", { className: "small", onclick: () => { d.groups = {}; markDirty(); draw(); } }, "모두 유지로")),
        rows.length
          ? el("div", { className: "cpm-gtable" }, rows)
          : el("div", { className: "cpm-hint", style: { marginTop: "6px" } }, "현재 워크플로에 그룹이 없습니다. 캔버스에서 그룹을 만들면 여기에 표시됩니다."));
    };
    function captureCurrent() {
      d.groups = {};
      for (const g of graphGroups()) {
        const st = groupState(g);
        if (st in MODE) d.groups[g.title] = st;
      }
      markDirty();
      draw();
    }
    draw();
    return box;
  }

  // ---- 저장된 캐릭터 편집기
  function characterEditor(d) {
    const out = [el("div", { className: "cpm-grid2" }, GENERAL.map(([k, l]) => row(l, textArea(d, k, 1))))];
    for (const sec of BASE_SECTIONS) {
      const pick = el("select", {
        onchange: (e) => {
          const n = e.target.value;
          if (!n) return;
          d[sec] = { name: n, ...normPrefab(sec, clone(STATE.collections[sec][n])) };
          renderEditor(true);
          markDirty();
        },
      }, el("option", { value: "" }, "프리팹에서 가져오기…"), sortedNames(sec).map((n) => el("option", { value: n }, n)));
      out.push(el("fieldset", {},
        el("legend", {}, STATE.schema[sec].label, d[sec].name ? el("span", { className: "cpm-hint" }, `(${d[sec].name})`) : null, pick,
          el("button", { onclick: () => sectionToPrefab(sec) }, "↗ 프리팹으로 저장")),
        prefabFields(sec, d[sec], { note: false, compact: true, exclude: d[sec].name })));
    }
    out.push(el("div", { className: "cpm-hint", style: { margin: "4px 0 8px" } },
      "※ 감정과 임신 설정은 캐릭터에 저장하지 않습니다. Character Load 노드에서 고르세요."));
    out.push(row("메모", textInput(d, "note")));
    return out;
  }

  function renderEditor(keepDirty = false) {
    if (ui.tab === "emotion" && ui.batch) { renderBatchPanel(); return; }
    if (!keepDirty) dirtyLabel.textContent = "";
    const d = ui.draft;
    emoCodeMirror = null;
    const content = [row("이름", el("input", {
      value: ui.name, placeholder: ui.tab === "emotion" ? "감정 이름 (= 감정 코드)" : "이름",
      oninput: (e) => { ui.name = e.target.value; if (emoCodeMirror) emoCodeMirror.value = ui.name; markDirty(); },
    }))];
    if (ui.tab === "emotion_group") content.push(bundleEditor(d));
    else if (ui.tab === "character") content.push(...characterEditor(d));
    else if (ui.tab === "pregnancy") content.push(...pregFields(d), row("메모", textInput(d, "note")));
    else {
      content.push(...prefabFields(ui.tab, d, { exclude: ui.selected }));
      if (ui.tab === "emotion") content.splice(1, 0, row("📁 폴더", el("input", {
        value: d.folder || "", placeholder: "비우면 폴더 없음 (예: 기본, 전투/분노)", list: "cpm-folder-list", style: { width: "260px" },
        oninput: (e) => { d.folder = e.target.value; markDirty(); },
        onchange: (e) => { d.folder = normPath(e.target.value); e.target.value = d.folder; markDirty(); },
      })));
      if (ui.tab === "emotion") content.push(emotionPathEditor(d), emotionPartsEditor(d), emotionOutfitEditor(d), emotionResEditor(d), emotionBgEditor(d), groupEditor(d));
    }
    content.push(preview);

    const w = widgetFor(node, ui.tab);
    const inNode = emoSelectable() && ui.selected != null && resolveEmotions(emoWidget.value).includes(ui.selected);
    content.push(el("div", { className: "cpm-actions" },
      el("button", { className: "primary", onclick: save }, "💾 저장"),
      w ? el("button", { onclick: applyToNode, title: "저장 후 이 노드의 선택값으로 지정" }, "✔ 저장하고 노드에 적용") : null,
      emoSelectable() && ui.selected != null
        ? el("button", { onclick: () => toggleEmotion(ui.selected, !inNode) }, inNode ? "➖ 이 노드 선택에서 빼기" : "✚ 이 노드 선택에 추가")
        : null,
      ui.tab === "emotion_group" && emoWidget && ui.selected != null
        ? (() => {
          const st = bundleState(selectedEmotions(node), ui.selected);
          return el("button", {
            onclick: async () => { if (ui.dirty && !(await save())) return; toggleBundle(node, ui.selected); renderEditor(); updateFooter?.(); },
          }, st === "all" ? "➖ 이 노드에서 묶음 끄기" : "✚ 이 노드에서 묶음 켜기");
        })()
        : null,
      el("button", { onclick: duplicate }, "⎘ 복제"),
      ui.selected != null ? el("button", { className: "danger", onclick: remove }, "🗑 삭제") : null,
      dirtyLabel,
    ));
    fill(editBox, ...content.flat(Infinity).filter(Boolean));
    updatePreview();
  }

  // ================= 일괄 작업 패널 (감정 여러 개: 폴더 이동 / 복제 / 설정 변경 / 삭제)
  const newBulk = () => ({
    dupPrefix: "", dupSuffix: "_복사", dupFolderOn: false, dupFolder: "",
    moveFolder: "",
    path: { on: false, v: STATE.default_path ?? "점검중" },
    res: { on: false, mode: "node", width: 1024, height: 1024 },
    bgVariant: { on: false, v: "main" }, bgPrefab: { on: false, v: "" },
    outfitPrefab: { on: false, v: "slot:node" }, outfitCode: { on: false, v: "" },
    combat: { on: false, v: true }, weight: { on: false, v: 1 },
    groups: { on: false, v: "capture" },
    parts: { appearance: {}, outfit: {} }, extras: {},
  });
  async function saveMany(list, msg) {
    try {
      const j = await post("/charprefab/save_many", { collection: "emotion", items: list });
      if (j.errors?.length) alert("일부 실패:\n" + j.errors.join("\n"));
    } catch (e) { alert("저장 실패: " + e.message); return false; }
    refreshAllCombos();
    renderTabs(); renderList(); renderEditor();
    toast(msg);
    return true;
  }

  function renderBatchPanel() {
    ui.bulk = ui.bulk || newBulk();
    const B = ui.bulk;
    const sel = natSort([...ui.batchSel].filter((n) => emoItems()[n]));
    ui.batchSel = new Set(sel);
    const none = !sel.length;
    const allNames = sortedNames("emotion");
    const cur = (n) => normPrefab("emotion", clone(emoItems()[n]));
    const enable = (o, label) => el("label", { className: "cpm-bon" },
      el("input", { type: "checkbox", checked: o.on, onchange: (e) => { o.on = e.target.checked; renderBatchPanel(); } }), label);
    const brow = (o, label, ctl) => el("div", { className: "cpm-row" + (o.on ? "" : " off") }, enable(o, label), ctl);
    const sel_ = (o, opts) => el("select", { disabled: !o.on, onchange: (e) => { o.v = e.target.value; } },
      opts.map(([v, l]) => el("option", { value: v, selected: String(o.v) === String(v) }, l)));
    // 3상태 칩: 변경 안 함(—) → 넣기(✔) → 빼기(✕)
    const tri = (store, key, label) => {
      const v = store[key];
      return el("span", {
        className: "cpm-chip" + (v === true ? " on" : v === false ? " off" : ""),
        title: "클릭: 변경 안 함 → 넣기 → 빼기",
        onclick: () => { store[key] = v == null ? true : v === true ? false : undefined; if (store[key] === undefined) delete store[key]; renderBatchPanel(); },
      }, `${v === true ? "✔" : v === false ? "✕" : "—"} ${label}`);
    };
    const shortLabel = (l) => l.replace(/\s*\([^)]{4,}\)$/, "");

    const dupNames = (() => {
      const exist = new Set(Object.keys(emoItems()));
      return sel.map((n) => {
        const base = `${B.dupPrefix}${n}${B.dupSuffix}`;
        let name = base, i = 2;
        while (exist.has(name)) name = `${base}_${i++}`;
        exist.add(name);
        return [n, name];
      });
    })();

    fill(editBox,
      el("div", { className: "cpm-batchhead" },
        el("b", {}, `☑ 일괄 작업 대상: ${sel.length}개`),
        el("button", { className: "small", onclick: () => { ui.batchSel = new Set(allNames); renderList(); renderBatchPanel(); } }, "전체 선택"),
        el("button", { className: "small", onclick: () => { ui.batchSel = new Set(); renderList(); renderBatchPanel(); } }, "선택 해제"),
        emoWidget ? el("button", { className: "small", disabled: none, onclick: () => { setEmotionWidget(node, [...new Set([...selectedEmotions(node), ...sel])]); renderList(); updateFooter?.(); toast(`노드에 ${sel.length}개 켬`); } }, "✚ 노드에서 켜기") : null,
        emoWidget ? el("button", { className: "small", disabled: none, onclick: () => { setEmotionWidget(node, selectedEmotions(node).filter((x) => !sel.includes(x))); renderList(); updateFooter?.(); toast(`노드에서 ${sel.length}개 끔`); } }, "➖ 노드에서 끄기") : null),
      el("div", { className: "cpm-hint", style: { margin: "4px 0 8px" } },
        none ? "왼쪽 목록에서 감정을 클릭하거나, 폴더 이름 옆 체크박스로 폴더 전체를 고르세요." : sel.join(", ")),

      // 1) 폴더 이동
      el("fieldset", {},
        el("legend", {}, "📁 폴더로 이동"),
        el("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } },
          el("input", { value: B.moveFolder, list: "cpm-folder-list", placeholder: "폴더 이름 (예: 기본, 전투/분노)", style: { width: "240px" }, oninput: (e) => { B.moveFolder = e.target.value; } }),
          el("button", {
            disabled: none,
            onclick: () => {
              const f = normPath(B.moveFolder);
              if (!f) { alert("폴더 이름을 입력하세요. (폴더에서 빼려면 '폴더에서 빼기')"); return; }
              saveMany(sel.map((n) => ({ name: n, old_name: n, data: { ...cur(n), folder: f } })), `${sel.length}개를 '${f}' 폴더로 이동`);
            },
          }, "이동"),
          el("button", { disabled: none, onclick: () => saveMany(sel.map((n) => ({ name: n, old_name: n, data: { ...cur(n), folder: "" } })), `${sel.length}개를 폴더에서 뺌`) }, "폴더에서 빼기"),
          allFolders().length ? el("span", { className: "cpm-hint" }, `기존 폴더: ${allFolders().join(", ")}`) : null)),

      // 2) 이름에서 숫자/문자 지우기
      (() => {
        const plan = (mode) => renamePlan(sel, (n) => stripName(n, mode), emoItems());
        const run = (mode, label) => {
          const list = plan(mode);
          if (!list.length) { alert("바뀌는 이름이 없습니다."); return; }
          if (!confirm(`${list.length}개 이름에서 ${label}:\n` + list.map(([a, b]) => `${a} ⇒ ${b}`).join("\n"))) return;
          saveMany(list.map(([old, name]) => ({ name, old_name: old, data: cur(old) })), `${list.length}개 이름 바꿈 (${label})`)
            .then((ok) => {
              if (!ok) return;
              applyRenamesToNodes(Object.fromEntries(list));
              ui.batchSel = new Set(list.map((x) => x[1]));
              renderList(); renderBatchPanel(); updateFooter?.();
            });
        };
        const preview = (mode) => {
          const list = plan(mode);
          return list.length ? list.slice(0, 4).map(([a, b]) => `${a} ⇒ ${b || "(빈 이름)"}`).join(", ") + (list.length > 4 ? " …" : "") : "바뀌는 이름 없음";
        };
        return el("fieldset", {},
          el("legend", {}, "✎ 이름에서 지우기", el("span", { className: "cpm-hint" }, "감정 이름 = 감정 코드이므로 코드도 같이 바뀝니다")),
          el("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } },
            el("button", { disabled: none, onclick: () => run("digits", "숫자 지우기") }, "🔢 숫자 지우기"),
            el("span", { className: "cpm-hint" }, none ? "" : preview("digits"))),
          el("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginTop: "6px" } },
            el("button", { disabled: none, onclick: () => run("letters", "문자 지우기") }, "🔤 문자 지우기"),
            el("span", { className: "cpm-hint" }, none ? "" : preview("letters"))));
      })(),

      // 3) 일괄 복제
      el("fieldset", {},
        el("legend", {}, "⎘ 일괄 복제", el("span", { className: "cpm-hint" }, "모든 설정을 그대로 복사한 새 감정을 만듭니다")),
        el("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } },
          "이름 앞", el("input", { value: B.dupPrefix, style: { width: "90px" }, oninput: (e) => { B.dupPrefix = e.target.value; }, onchange: () => renderBatchPanel() }),
          "이름 뒤", el("input", { value: B.dupSuffix, style: { width: "90px" }, oninput: (e) => { B.dupSuffix = e.target.value; }, onchange: () => renderBatchPanel() }),
          el("label", { className: "cpm-bon" }, el("input", { type: "checkbox", checked: B.dupFolderOn, onchange: (e) => { B.dupFolderOn = e.target.checked; renderBatchPanel(); } }), "복제본 폴더"),
          el("input", { value: B.dupFolder, disabled: !B.dupFolderOn, list: "cpm-folder-list", placeholder: "새 폴더", style: { width: "140px" }, oninput: (e) => { B.dupFolder = e.target.value; } }),
          el("button", {
            className: "primary", disabled: none,
            onclick: async () => {
              if (!B.dupPrefix && !B.dupSuffix && !confirm("이름 앞/뒤가 비어 있어 '_2' 같은 번호가 붙습니다. 계속할까요?")) return;
              const pairs = dupNames;
              const ok = await saveMany(pairs.map(([src, name]) => ({ name, data: { ...cur(src), ...(B.dupFolderOn ? { folder: normPath(B.dupFolder) } : {}) } })),
                `${pairs.length}개 복제 완료 (복제본이 선택됨)`);
              if (ok) { ui.batchSel = new Set(pairs.map((x) => x[1])); renderList(); renderBatchPanel(); }
            },
          }, `⎘ ${sel.length}개 복제`)),
        !none ? el("div", { className: "cpm-hint", style: { marginTop: "4px" } }, "→ " + dupNames.slice(0, 6).map(([a, b]) => `${a} ⇒ ${b}`).join(", ") + (dupNames.length > 6 ? " …" : "")) : null),

      // 4) 일괄 설정 변경
      el("fieldset", {},
        el("legend", {}, "✎ 일괄 설정 변경", el("span", { className: "cpm-hint" }, "체크한 항목만 바뀌고 나머지는 그대로")),
        brow(B.path, "💾 추가 경로", el("input", { value: B.path.v, disabled: !B.path.on, placeholder: "비우면 경로 없음", style: { width: "240px" }, oninput: (e) => { B.path.v = e.target.value; } })),
        brow(B.res, "📐 해상도", el("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } },
          sel_({ get on() { return B.res.on; }, get v() { return B.res.mode; }, set v(x) { B.res.mode = x; renderBatchPanel(); } }, [["node", "노드 설정 따름"], ["custom", "직접 지정"]]),
          el("input", { type: "number", step: 8, value: B.res.width, disabled: !B.res.on || B.res.mode !== "custom", style: { width: "90px" }, onchange: (e) => { B.res.width = Math.max(64, Math.floor((+e.target.value || 64) / 8) * 8); renderBatchPanel(); } }), "×",
          el("input", { type: "number", step: 8, value: B.res.height, disabled: !B.res.on || B.res.mode !== "custom", style: { width: "90px" }, onchange: (e) => { B.res.height = Math.max(64, Math.floor((+e.target.value || 64) / 8) * 8); renderBatchPanel(); } }),
          (STATE.res_presets || []).slice(0, 7).map(([l, w, h]) => el("span", {
            className: "cpm-chip" + (B.res.mode === "custom" && B.res.width === w && B.res.height === h ? " on" : ""),
            onclick: () => { if (!B.res.on) return; Object.assign(B.res, { mode: "custom", width: w, height: h }); renderBatchPanel(); },
          }, l)))),
        brow(B.bgVariant, "🏙 배경 종류", sel_(B.bgVariant, Object.entries(STATE.bg_variants))),
        brow(B.bgPrefab, "🏙 배경 프리팹", sel_(B.bgPrefab, [["", "(노드에서 고른 배경)"], ...sortedNames("background").map((n) => [n, n])])),
        brow(B.outfitPrefab, "👗 입힐 의상", sel_(B.outfitPrefab, outfitChoiceOptions())),
        brow(B.outfitCode, "👗 의상 코드", el("input", { value: B.outfitCode.v, disabled: !B.outfitCode.on, placeholder: "비우면 의상의 코드 사용", style: { width: "200px" }, oninput: (e) => { B.outfitCode.v = e.target.value.trim(); } })),
        brow(B.combat, "⚔ 전투 프롬", sel_({ get on() { return B.combat.on; }, get v() { return B.combat.v ? "1" : "0"; }, set v(x) { B.combat.v = x === "1"; } }, [["1", "켜기"], ["0", "끄기"]])),
        brow(B.weight, "가중치", el("input", { type: "number", min: 0, max: 2, step: 0.05, value: B.weight.v, disabled: !B.weight.on, style: { width: "90px" }, oninput: (e) => { B.weight.v = Math.max(0, Math.min(2, parseFloat(e.target.value) || 0)); } })),
        brow(B.groups, "🎛 그룹 설정", sel_(B.groups, [["capture", "지금 워크플로의 그룹 상태로"], ["clear", "모두 유지로 (설정 지우기)"]])),
        row("👤 캐릭터 칸", el("div", { className: "cpm-chips" }, STATE.schema.appearance.fields.filter((x) => x.key !== "combat").map((x) => tri(B.parts.appearance, x.key, shortLabel(x.label))))),
        row("👗 의상 칸", el("div", { className: "cpm-chips" }, STATE.schema.outfit.fields.map((x) => tri(B.parts.outfit, x.key, shortLabel(x.label))))),
        allExtraNames().length ? row("✨ 추가 프롬", el("div", { className: "cpm-chips" }, allExtraNames().map((x) => tri(B.extras, x, x)))) : null,
        el("div", { className: "cpm-actions" },
          el("button", {
            className: "primary", disabled: none,
            onclick: () => {
              const changes = [];
              if (B.path.on) changes.push("추가 경로"); if (B.res.on) changes.push("해상도"); if (B.bgVariant.on) changes.push("배경 종류");
              if (B.bgPrefab.on) changes.push("배경 프리팹"); if (B.outfitPrefab.on) changes.push("입힐 의상"); if (B.outfitCode.on) changes.push("의상 코드");
              if (B.combat.on) changes.push("전투"); if (B.weight.on) changes.push("가중치"); if (B.groups.on) changes.push("그룹 설정");
              const pc = Object.keys(B.parts.appearance).length + Object.keys(B.parts.outfit).length + Object.keys(B.extras).length;
              if (pc) changes.push(`칸/추가 프롬 ${pc}개`);
              if (!changes.length) { alert("바꿀 항목을 체크하세요."); return; }
              if (!confirm(`${sel.length}개 감정의 [${changes.join(", ")}] 을(를) 바꿀까요?`)) return;
              const gstate = {};
              if (B.groups.on && B.groups.v === "capture") for (const g of graphGroups()) { const st = groupState(g); if (st in MODE) gstate[g.title] = st; }
              saveMany(sel.map((n) => {
                const d = cur(n);
                if (B.path.on) d.path = normPath(B.path.v);
                if (B.res.on) d.resolution = { mode: B.res.mode, width: B.res.width, height: B.res.height };
                if (B.bgVariant.on) d.background.variant = B.bgVariant.v;
                if (B.bgPrefab.on) d.background.prefab = B.bgPrefab.v;
                if (B.outfitPrefab.on) applyOutfitChoice(d.outfit, B.outfitPrefab.v);
                if (B.outfitCode.on) d.outfit.code = B.outfitCode.v;
                if (B.combat.on) d.parts.appearance.combat = B.combat.v;
                if (B.weight.on) d.weight = B.weight.v;
                if (B.groups.on) d.groups = B.groups.v === "capture" ? { ...gstate } : {};
                for (const sec of ["appearance", "outfit"]) for (const [k, v] of Object.entries(B.parts[sec])) d.parts[sec][k] = v;
                for (const [k, v] of Object.entries(B.extras)) { if (v) d.extras[k] = true; else delete d.extras[k]; }
                return { name: n, old_name: n, data: d };
              }), `${sel.length}개 감정 설정을 바꿨습니다`);
            },
          }, `✎ 선택한 ${sel.length}개에 적용`),
          el("button", { onclick: () => { ui.bulk = newBulk(); renderBatchPanel(); } }, "변경 항목 초기화"))),

      // 5) 삭제
      el("div", { className: "cpm-actions" },
        el("button", {
          className: "danger", disabled: none,
          onclick: async () => {
            if (!confirm(`${sel.length}개 감정을 삭제할까요?\n${sel.join(", ")}`)) return;
            try { await post("/charprefab/delete_many", { collection: "emotion", names: sel }); } catch (e) { alert("삭제 실패: " + e.message); return; }
            for (const n of graphNodes()) { const ew = widgetNamed(n, "emotions"); if (ew) ew.value = splitList(ew.value).filter((x) => !sel.includes(x)).join(", "); }
            ui.batchSel = new Set();
            refreshAllCombos(); renderTabs(); renderList(); renderBatchPanel(); updateFooter?.();
            toast(`${sel.length}개 삭제`);
          },
        }, `🗑 선택한 ${sel.length}개 삭제`)),
    );
  }

  function updatePreview() {
    const d = ui.draft;
    const lines = [];
    const kv = (k, v) => [el("span", { className: "k" }, k), v || "—", "\n"];
    if (ui.tab === "character") {
      const its = expandBase({ ...d, emotions: [], pregnancy: normBase().pregnancy });
      lines.push(el("span", { className: "k" }, `총 ${its.length}장\n`));
      for (const it of its.slice(0, 12)) lines.push(el("span", { className: "c" }, `[${it.code || "코드 없음"}] `), it.pos, "\n");
      if (its.length > 12) lines.push(`… 외 ${its.length - 12}장\n`);
      lines.push(...kv("Negative: ", its[0]?.neg));
    } else if (ui.tab === "emotion_group") {
      lines.push(...kv(`감정 ${d.emotions.length}개: `, d.emotions.join(", ")));
    } else if (ui.tab === "pregnancy") {
      for (const k of ["before", "after"]) {
        lines.push(el("span", { className: "c" }, `[${d[k].code || STATE.pregnancy.prefix[k] + "…"}] `),
          ...kv(`${STATE.pregnancy.label[k]}: `, applyWeight(d[k].prompt, d.weight)));
      }
    } else if (ui.tab === "background") {
      for (const [k, l] of Object.entries(STATE.bg_variants)) if (k !== "none") lines.push(...kv(`${l}: `, backgroundText(d, k)));
      lines.push(...kv("Negative: ", d.weight > 0 ? cleanTags(d.negative) : ""));
    } else {
      lines.push(...kv("Positive: ", sectionText(ui.tab, d)), ...kv("Negative: ", d.weight > 0 ? cleanTags(d.negative) : ""));
      if (ui.tab === "emotion") {
        const off = (sec) => STATE.schema[sec].fields.filter((f) => f.key !== "combat" && !d.parts[sec][f.key]).map((f) => f.label.replace(/\s*\([^)]{4,}\)$/, ""));
        lines.push(...kv("추가 경로: ", normPath(d.path) || "(없음)"));
        lines.push(...kv("의상: ", `${outfitChoiceLabel(d.outfit)}${d.outfit.code ? ` · 코드 ${d.outfit.code}` : ""}`));
        lines.push(...kv("해상도: ", d.resolution.mode === "custom" ? `${d.resolution.width}×${d.resolution.height}` : "노드 설정 따름"));
        lines.push(...kv("전투: ", d.parts.appearance.combat ? "켜짐" : "꺼짐"));
        lines.push(...kv("추가 프롬: ", Object.keys(d.extras || {}).join(", ") || "없음"));
        lines.push(...kv("빼는 칸: ", [...off("appearance"), ...off("outfit")].join(", ") || "없음"));
        lines.push(...kv("배경: ", `${STATE.bg_variants[d.background.variant]}${d.background.prefab ? ` · ${d.background.prefab}` : " · 노드 배경"}`));
        const g = Object.entries(d.groups || {}).map(([t, a]) => `${t}=${GROUP_ACTIONS.find((x) => x[0] === a)?.[1]}`);
        lines.push(...kv("그룹: ", g.join(", ")));
      }
    }
    fill(preview, ...lines);
  }

  // ---- 동작
  async function save() {
    const name = ui.name.trim();
    if (!name || name === STATE.none || name === STATE.keep) { alert("이름을 입력하세요."); return false; }
    if (name !== ui.selected && items()[name] && !confirm(`'${name}' 이(가) 이미 있습니다. 덮어쓸까요?`)) return false;
    try {
      await post("/charprefab/save", { collection: ui.tab, name, data: ui.draft, old_name: ui.selected });
    } catch (e) { alert("저장 실패: " + e.message); return false; }
    const renamed = ui.selected && ui.selected !== name;
    refreshAllCombos(renamed ? { collection: ui.tab, from: ui.selected, to: name } : null);
    ui.selected = name;
    ui.name = name;
    ui.draft = normalize(ui.tab, clone(items()[name])); // 자동 지정된 코드 반영
    ui.dirty = false;
    renderTabs(); renderList(); renderEditor();
    updateFooter?.();
    const code = codeOf(ui.tab, items()[name]);
    toast(`'${name}' 저장됨${code ? ` (코드 ${code})` : ""}`);
    return true;
  }
  async function applyToNode() {
    if ((ui.dirty || ui.selected == null) && !(await save())) return;
    const w = widgetFor(node, ui.tab);
    if (!w) return;
    w.value = ui.selected;
    w.callback?.(w.value);
    app.graph?.setDirtyCanvas(true, true);
    updateFooter?.();
    toast(`노드에 '${ui.selected}' 적용`);
  }
  function duplicate() {
    const stem = (ui.name || "새 항목").replace(/_\d+$/, "");
    let i = 2;
    while (items()[`${stem}_${i}`]) i++;
    ui.name = `${stem}_${i}`;
    ui.selected = null;
    if (ui.tab === "pregnancy") ui.draft.before.code = ui.draft.after.code = "";
    else if (ui.tab !== "character") ui.draft.code = "";
    renderList(); renderEditor();
    markDirty();
  }
  async function remove() {
    const gone = ui.selected;
    let alsoEmotions = [];
    if (ui.tab === "emotion_group") {
      const members = bundleMembers(gone);
      if (!members.length) {
        if (!confirm(`'${gone}' 묶음을 삭제할까요? (묶인 감정 없음)`)) return;
      } else {
        const shared = members.filter((m) => bundleNames().some((b) => b !== gone && bundleMembers(b).includes(m)));
        const pick = await askChoice(`'${gone}' 묶음을 삭제`,
          el("div", {},
            el("div", {}, `묶인 감정 ${members.length}개: ${members.join(", ")}`),
            el("div", { className: "cpm-hint", style: { marginTop: "6px" } },
              shared.length ? `⚠ 다른 묶음에도 들어있는 감정: ${shared.join(", ")}` : "이 감정들은 다른 묶음에 들어있지 않습니다."),
            el("div", { className: "cpm-hint" }, "감정을 함께 지우면 되돌릴 수 없습니다.")),
          ["묶음만 삭제", { text: `묶음 + 감정 ${members.length}개 삭제`, danger: true }]);
        if (pick < 0) return;
        if (pick === 1) alsoEmotions = members;
      }
    } else if (!confirm(`'${gone}' 을(를) 삭제할까요?`)) return;

    try {
      if (alsoEmotions.length) await post("/charprefab/delete_many", { collection: "emotion", names: alsoEmotions });
      await post("/charprefab/delete", { collection: ui.tab, name: gone });
    } catch (e) { alert("삭제 실패: " + e.message); return; }
    refreshAllCombos();
    if (ui.tab === "emotion") dropEmotionsFromNodes([gone]);
    if (alsoEmotions.length) { dropEmotionsFromNodes(alsoEmotions); toast(`'${gone}' 묶음과 감정 ${alsoEmotions.length}개 삭제`); }
    ui.dirty = false;
    renderTabs();
    select(sortedNames(ui.tab)[0] ?? null, true);
    updateFooter?.();
  }
  async function sectionToPrefab(sec) {
    const src = ui.draft[sec];
    const label = sec === "pregnancy" ? "임신" : STATE.schema[sec].label;
    const name = prompt(`${label} 프리팹 이름`, src.name || "")?.trim();
    if (!name) return;
    if (STATE.collections[sec]?.[name] && !confirm(`'${name}' 이(가) 이미 있습니다. 덮어쓸까요?`)) return;
    try { await post("/charprefab/save", { collection: sec, name, data: src }); } catch (e) { alert("저장 실패: " + e.message); return; }
    const saved = STATE.collections[sec][name];
    ui.draft[sec] = { name, ...(sec === "pregnancy" ? normPregnancy(clone(saved)) : normPrefab(sec, clone(saved))) };
    refreshAllCombos();
    renderTabs(); renderEditor(true);
    markDirty();
    toast(`${label} 프리팹 '${name}' 저장됨`);
  }

  // ---- 하단 바 : 이 노드에서 선택된 감정 (모든 탭에서 보임) + 조합 요약
  function buildFooter() {
    const chipsBox = el("div", { className: "cpm-chips", style: { flex: 1, minWidth: 0 } });
    const label = el("span", { className: "combo", style: { flex: "none" } });
    const val = (n) => widgetNamed(node, n)?.value ?? "";
    const baseFromNode = () => {
      const b = normBase();
      if (nodeClass === "CharacterLoad") {
        Object.assign(b, normBase(STATE.collections.character?.[val("character")] || {}));
        for (const [sec, w] of [["outfit", "outfit_override"], ["background", "background_override"]]) {
          const src = STATE.collections[sec]?.[val(w)];
          if (src) b[sec] = { name: val(w), ...normPrefab(sec, clone(src)) };
        }
      } else {
        for (const sec of BASE_SECTIONS) {
          const n = val(sec);
          const src = STATE.collections[sec]?.[n];
          b[sec] = { name: src ? n : "", ...normPrefab(sec, clone(src || {})) };
        }
        for (const [k] of GENERAL) b[k] = val(k);
      }
      const pn = val("pregnancy");
      const ps = STATE.collections.pregnancy?.[pn];
      b.pregnancy = { name: ps ? pn : "", ...normPregnancy(clone(ps || {})) };
      b.pregnancy_state = STATE.state_choices[val("pregnancy_state")] || "before";
      b.emotions = resolveEmotions(val("emotions"));
      return b;
    };
    updateFooter = () => {
      const sel = resolveEmotions(val("emotions"));
      fill(chipsBox, 
        el("span", { style: { opacity: 0.8, marginRight: "2px", alignSelf: "center" } }, "😊 선택된 감정:"),
        ...(sel.length ? sel.map((n) => el("span", {
          className: "cpm-chip on", title: "클릭: 이 감정 편집 / ✕: 선택 해제",
          onclick: () => { if (ui.tab !== "emotion") setTab("emotion"); if (ui.tab === "emotion" && ui.selected !== n) select(n); },
        }, n,
        el("span", {
          style: { marginLeft: "4px", opacity: 0.8 },
          onclick: (e) => { e.stopPropagation(); setEmotionWidget(node, sel.filter((x) => x !== n)); renderList(); updateFooter(); },
        }, "✕"))) : [el("span", { className: "cpm-hint", style: { alignSelf: "center" } }, "없음 (감정 없이 1장)")]));
      const b = baseFromNode();
      label.textContent = `${hasPregnancy(b.pregnancy) ? `${b.pregnancy.name}: ${val("pregnancy_state")} · ` : ""}⇒ ${expandBase(b).length}장`;
    };
    const saveBtn = nodeClass === "CharacterPrefabComposer" ? el("button", {
      className: "primary",
      title: "캐릭터·의상·배경·태그만 저장 (감정/임신 제외)",
      onclick: async () => {
        const def = val("appearance") !== STATE.none ? val("appearance") : "";
        const name = prompt("저장할 캐릭터 이름 (감정·임신은 제외하고 저장됩니다)", def)?.trim();
        if (!name) return;
        if (STATE.collections.character?.[name] && !confirm(`'${name}' 이(가) 이미 있습니다. 덮어쓸까요?`)) return;
        const data = { ...baseFromNode(), emotions: [], pregnancy: normBase().pregnancy, pregnancy_state: "before" };
        try { await post("/charprefab/save", { collection: "character", name, data }); } catch (e) { alert("저장 실패: " + e.message); return; }
        refreshAllCombos();
        toast(`캐릭터 '${name}' 저장됨 (감정·임신 제외)`);
        if (!confirmDiscard()) { renderTabs(); return; }
        ui.dirty = false;
        ui.tab = "character";
        renderTabs();
        select(name, true);
      },
    }, "⭐ 현재 조합을 캐릭터로 저장") : null;
    return el("div", { className: "cpm-foot" }, chipsBox, label, saveBtn);
  }

  updateFooter?.();
  setTab(startTab, true);
  search.focus();
}

// ================================================================ 노드 안 감정 패널
const PANEL_FONT = "12px system-ui, sans-serif";
const CHIP_H = 20, CHIP_GAP = 4, HEAD_H = 18, PAD = 6, BAR_GAP = 6;
let _measureCtx = null;
function textWidth(t) {
  _measureCtx = _measureCtx || document.createElement("canvas").getContext("2d");
  _measureCtx.font = PANEL_FONT;
  return _measureCtx.measureText(t).width;
}
const emotionNamesByCode = () => natSort(Object.keys(emoItems())); // 숫자 순 (1, 2 … 10)
function chipLabel(n) {
  const e = emoItems()[n] || {};
  const v = e.background?.variant;
  const bg = v && v !== "main" ? ` ·${STATE.bg_variants?.[v] || ""}` : e.background?.prefab ? " ·배경" : "";
  const combat = (e.parts?.appearance?.combat ? " ⚔" : "") + (Object.values(e.extras || {}).some(Boolean) ? " ✨" : "");
  const res = e.resolution?.mode === "custom" ? ` ·${e.resolution.width}×${e.resolution.height}` : "";
  const eo = normPrefab("emotion", e).outfit;
  const slotShort = { default: "기본옷", idol: "아이돌" };
  const oc = eo.code || (eo.slot === "prefab" ? STATE.collections.outfit?.[eo.prefab]?.code || "의상" : slotShort[eo.slot] || "");
  const outfitTag = oc ? ` ·${oc}` : "";
  return `${n}${outfitTag}${bg}${res}${combat}${Object.keys(e.groups || {}).length ? " ⚙" : ""}`;
}

function wrapRows(labels, inner) {
  let rows = 1, x = 0;
  for (const t of labels) {
    const w = textWidth(t) + 22;
    if (x > 0 && x + w > inner) { rows++; x = 0; }
    x += w + CHIP_GAP;
  }
  return rows;
}
const barLabels = () => ["전체 켜기", "전체 끄기", ...bundleNames().map((b) => `📦 ${b}`)];
function panelHeight(node, width) {
  if (!STATE) return HEAD_H + CHIP_H * 2 + PAD * 2;
  const inner = Math.max(80, (width || node.size[0]) - 20 - PAD * 2);
  const bar = wrapRows(barLabels(), inner);
  const block = (r) => r * CHIP_H + (r - 1) * CHIP_GAP;
  const groups = folderGroups(emotionNamesByCode());
  let chipsH = 0;
  groups.forEach(([f, members], i) => {          // 폴더마다 새 줄에서 시작 (폴더 칩 + 감정 칩)
    chipsH += block(wrapRows([...(f ? [`📁 ${f}`] : []), ...members.map(chipLabel)], inner)) + (i ? CHIP_GAP : 0);
  });
  return HEAD_H + block(bar) + BAR_GAP + Math.max(CHIP_H, chipsH) + PAD * 2 + 14; // 여유분 포함
}

function injectPanelStyle() {
  if (document.getElementById("cpn-style")) return;
  const s = document.createElement("style");
  s.id = "cpn-style";
  s.textContent = `
.cpn-panel{box-sizing:border-box;width:100%;height:100%;padding:${PAD}px;font:${PANEL_FONT};color:var(--fg-color,#ddd);overflow:hidden;background:rgba(0,0,0,.18);border-radius:6px}
.cpn-head{height:${HEAD_H}px;display:flex;justify-content:space-between;align-items:center;font-size:11px;opacity:.9;white-space:nowrap;overflow:hidden}
.cpn-head b{color:#91a7ff;font-weight:600}
.cpn-chips{display:flex;flex-wrap:wrap;gap:${CHIP_GAP}px}
.cpn-chip{height:${CHIP_H}px;line-height:${CHIP_H - 2}px;box-sizing:border-box;padding:0 8px;border-radius:10px;border:1px solid rgba(160,160,160,.35);cursor:pointer;user-select:none;white-space:nowrap;opacity:.55}
.cpn-chip:hover{opacity:.9}
.cpn-chip.on{background:#3b5bdb;border-color:#5c7cfa;color:#fff;opacity:1}
.cpn-empty{opacity:.6}
.cpn-bar{margin-bottom:${BAR_GAP}px}
.cpn-chip.cpn-btn{opacity:.9;background:rgba(255,255,255,.06);border-radius:4px}
.cpn-chip.cpn-bundle{border-style:dashed;opacity:.75}
.cpn-fblocks{display:flex;flex-direction:column;gap:${CHIP_GAP}px}
.cpn-chip.cpn-folder{border-radius:4px;font-weight:600;opacity:.8;background:rgba(245,159,0,.12);border-color:rgba(245,159,0,.5)}
.cpn-chip.cpn-folder.some{background:rgba(245,159,0,.35);opacity:1}
.cpn-chip.cpn-folder.on{background:#e67700;border-color:#f59f00;color:#fff;opacity:1}
.cpn-chip.cpn-bundle.some{background:rgba(59,91,219,.35);border-color:#5c7cfa;opacity:1}
.cpn-chip.cpn-bundle.on{background:#2f9e44;border-color:#40c057;border-style:solid;color:#fff;opacity:1}
`;
  document.head.append(s);
}

function updatePanel(node) {
  const p = node?._cpPanel;
  if (!p || !STATE) return;
  const sel = selectedEmotions(node);
  const states = itemStates(node);
  const count = Math.max(1, sel.length) * states.length;
  const split = isSplitMode(node);
  const head = el("div", { className: "cpn-head" },
    el("span", {}, "😊 감정 ", el("b", {}, `${sel.length}개 선택`), sel.length ? "" : " (감정 없이)"),
    el("span", {}, `⇒ ${count}장 · ${split ? "따로 실행" : "한 번에"} · 기본 ${widgetNamed(node, "width")?.value ?? "?"}×${widgetNamed(node, "height")?.value ?? "?"}`));
  const names = emotionNamesByCode();
  const chipFor = (n) => {
      const on = sel.includes(n);
      const eb = emoItems()[n]?.background || {};
      const ep = normPrefab("emotion", emoItems()[n] || {}).parts;
      const eres = normPrefab("emotion", emoItems()[n] || {}).resolution;
      const offs = PART_SECTIONS.flatMap((sec) => STATE.schema[sec].fields.filter((f) => f.key !== "combat" && !ep[sec][f.key]).map((f) => f.label.replace(/\s*\([^)]{4,}\)$/, "")));
      const g = [`배경: ${STATE.bg_variants?.[eb.variant || "main"]}${eb.prefab ? ` (${eb.prefab})` : ""}`,
        `추가 경로: ${normPrefab("emotion", emoItems()[n] || {}).path || "(없음)"}`,
        `의상: ${outfitChoiceLabel(normPrefab("emotion", emoItems()[n] || {}).outfit)}${emoItems()[n]?.outfit?.code ? ` (코드 ${emoItems()[n].outfit.code})` : ""}`,
        `해상도: ${eres.mode === "custom" ? `${eres.width}×${eres.height}` : "노드 설정 따름"}`,
        `전투: ${ep.appearance.combat ? "켜짐" : "꺼짐"}`,
        `추가 프롬: ${Object.keys(normPrefab("emotion", emoItems()[n] || {}).extras).join(", ") || "없음"}`, `빼는 칸: ${offs.join(", ") || "없음"}`,
        ...Object.entries(emoItems()[n]?.groups || {}).map(([t, a]) => `${t}: ${a}`)].join("\n");
      return el("span", {
        className: "cpn-chip" + (on ? " on" : ""),
        title: `${on ? "선택됨 — 클릭해서 해제" : "클릭해서 선택"}${g ? `\n${g}` : ""}`,
        onpointerdown: (e) => { e.stopPropagation(); e.preventDefault(); },
        onclick: (e) => {
          e.stopPropagation();
          const cur = selectedEmotions(node);
          setEmotionWidget(node, on ? cur.filter((x) => x !== n) : [...cur, n]);
        },
      }, chipLabel(n));
  };
  const stopEv = (e) => { e.stopPropagation(); e.preventDefault(); };
  const chips = names.length
    ? el("div", { className: "cpn-fblocks" }, folderGroups(names).map(([f, members]) => {
      const st = setState(sel, members);
      return el("div", { className: "cpn-chips" },
        f ? el("span", {
          className: "cpn-chip cpn-folder" + (st === "all" ? " on" : st === "some" ? " some" : ""),
          title: `📁 ${f} 폴더 (${members.length}개)\n클릭: ${st === "all" ? "폴더 전체 끄기" : "폴더 전체 켜기"}`,
          onpointerdown: stopEv,
          onclick: (e) => { e.stopPropagation(); toggleMembers(node, members); },
        }, `📁 ${f}`) : null,
        members.map(chipFor));
    }))
    : el("span", { className: "cpn-empty" }, "감정 프리팹이 없습니다 — 매니저에서 추가");
  const stop = { onpointerdown: (e) => { e.stopPropagation(); e.preventDefault(); } };
  const bar = el("div", { className: "cpn-chips cpn-bar" },
    el("span", { className: "cpn-chip cpn-btn", title: "모든 감정 켜기", ...stop, onclick: (e) => { e.stopPropagation(); setAllEmotions(node, true); } }, "전체 켜기"),
    el("span", { className: "cpn-chip cpn-btn", title: "모든 감정 끄기", ...stop, onclick: (e) => { e.stopPropagation(); setAllEmotions(node, false); } }, "전체 끄기"),
    bundleNames().map((b) => {
      const st = bundleState(sel, b);
      return el("span", {
        className: "cpn-chip cpn-bundle" + (st === "all" ? " on" : st === "some" ? " some" : ""),
        title: `📦 묶음: ${bundleMembers(b).join(", ") || "(비어 있음)"}\n클릭: ${st === "all" ? "묶음 전체 끄기" : "묶음 전체 켜기"}`,
        ...stop,
        onclick: (e) => { e.stopPropagation(); toggleBundle(node, b); },
      }, `📦 ${b}`);
    }));
  fill(p.root, head, bar, chips);
  const h = panelHeight(node);
  if (h !== p.h) {
    p.h = h;
    const sz = node.computeSize();
    node.setSize([node.size[0], Math.max(node.size[1], sz[1])]);
    app.graph?.setDirtyCanvas(true, true);
  }
}
const updateAllPanels = () => graphNodes().forEach((n) => updatePanel(n));

function addEmotionPanel(node) {
  injectPanelStyle();
  const root = el("div", { className: "cpn-panel" });
  const getH = () => panelHeight(node);
  const w = node.addDOMWidget("emotion_panel", "cp_emotion_panel", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: getH,
    getMaxHeight: getH,
    getHeight: getH,
  });
  w.serialize = false;
  w.computeSize = (width) => [width, panelHeight(node, width)];
  // 패널을 run_mode(또는 emotions) 위젯 바로 아래로 이동
  const ws = node.widgets;
  const at = Math.max(ws.findIndex((x) => x.name === "run_mode"), ws.findIndex((x) => x.name === "emotions"));
  if (at >= 0 && ws.indexOf(w) !== at + 1) { ws.splice(ws.indexOf(w), 1); ws.splice(at + 1, 0, w); }
  node._cpPanel = { root, h: 0, widget: w };
  // 관련 위젯이 바뀌면 패널 갱신
  for (const name of ["emotions", "pregnancy", "pregnancy_state", "run_mode", "width", "height"]) {
    const ww = widgetNamed(node, name);
    if (!ww) continue;
    const cb = ww.callback;
    ww.callback = function () {
      const r = cb?.apply(this, arguments);
      updatePanel(node);
      return r;
    };
  }
  setTimeout(() => updatePanel(node), 0);
}

// ================================================================ 확장 등록
app.registerExtension({
  name: "CharacterParts.PrefabManager",
  async setup() {
    try { await fetchData(); } catch (e) { console.warn("[CharacterPrefab]", e); }
    installQueueHook();
    updateAllPanels();
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!TARGETS.includes(nodeData.name)) return;
    const name = nodeData.name;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      const add = (label, fn) => {
        const b = this.addWidget("button", label, null, fn, { serialize: false });
        b.serialize = false;
      };
      if (name === "CharacterPrefabComposer" || name === "CharacterLoad") {
        addEmotionPanel(this);
        add("😊 감정 편집 · 🗂 프리팹 매니저", () => openManager(this, "emotion"));
        add("📊 표로 편집 (새 창)", () => openSheet());
      } else if (name === "CharacterSave") {
        add("🗂 프리팹 매니저", () => openManager(this, "character"));
        add("📊 표로 편집 (새 창)", () => openSheet());
      }
      const sz = this.computeSize();
      this.setSize([Math.max(sz[0], 340), sz[1]]);
      return r;
    };

    if (name === "CharacterPrefabComposer" || name === "CharacterLoad") {
      const onConfigure = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function () {
        const r = onConfigure?.apply(this, arguments);
        setTimeout(() => updatePanel(this), 0); // 워크플로 불러온 뒤 선택 상태 표시
        return r;
      };
    }

    if (name === "CharacterSave") {
      const onExecuted = nodeType.prototype.onExecuted;
      nodeType.prototype.onExecuted = function (msg) {
        onExecuted?.apply(this, arguments);
        const text = msg?.text?.[0];
        if (text) toast(text, text.includes("완료") ? "success" : "warn");
        fetchData().then(() => { refreshAllCombos(); updateAllPanels(); }).catch(() => {});
      };
    }
  },
});
