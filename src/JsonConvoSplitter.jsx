import React, { useState, useMemo, useEffect, useRef } from "react";

export default function JsonConvoSplitter() {
  // ---------- state ----------
  const [convos, setConvos] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState(false);
  const [previewIdx, setPreviewIdx] = useState(null);
  const [theme, setTheme] = useState("cream");

  // focus search with "/"
  const searchRef = useRef(null);

  // ---------- helpers ----------
  const safe = (s) => (s || "Untitled").replace(/[^0-9A-Za-z_\-\u4e00-\u9fa5]+/g, "_").slice(0, 80);

  // Build a linear message chain from a mapping tree — KEEP ONLY user/assistant
  const buildChain = (conv) => {
    const chain = [];
    let nid = conv?.current_node;
    const mapping = conv?.mapping || {};
    const guard = new Set();
    while (nid && !guard.has(nid)) {
      guard.add(nid);
      const node = mapping[nid];
      if (!node) break;
      const msg = node.message;
      if (msg) {
        const role = msg.author?.role;
        if (role === "user" || role === "assistant") chain.push(msg);
      }
      nid = node.parent;
    }
    return chain.reverse();
  };

  // Robust text extraction, ignore system/tool/metadata noise
  const extractText = (message) => {
    if (!message?.content) return "";
    const c = message.content;
    // Legacy shape: { content: { parts: ["..."] } }
    if (Array.isArray(c.parts)) return c.parts.map(p => typeof p === 'string' ? p : String(p ?? "")).join("\n\n");
    // Newer shape: { content: [ { type: 'text', text: {...} } ] }
    if (Array.isArray(c)) {
      return c.map(part => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return typeof part.text === 'string' ? part.text : part.text?.value || '';
        // non-text parts (images/tools) are hidden in preview/export
        return '';
      }).filter(Boolean).join("\n\n");
    }
    if (typeof c.text === 'string') return c.text;
    if (typeof c === 'string') return c;
    return ""; // skip other structures to avoid dumping system/tool JSON
  };

  // Markdown serialization
  const toMarkdown = (conv) => {
    const chain = buildChain(conv);
    return chain
      .map((m) => {
        const role = m.author?.role || "assistant";
        const text = extractText(m);
        if (!text.trim()) return "";
        const displayRole = role === "assistant" ? "Syzygy" : "串串";
        return `**${displayRole}**:\n${text}`;
      })
      .filter(Boolean)
      .join("\n\n\n");
  };

  const triggerDownload = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // Accept seconds or milliseconds
  const fmtDate = (tsLike) => {
    let ms = Number(tsLike ?? Date.now());
    if (!Number.isFinite(ms)) ms = Date.now();
    // If value looks like seconds (<= 1e11), multiply to ms
    if (ms < 1e11) ms = ms * 1000;
    const d = new Date(ms);
    const iso = d.toISOString().slice(0, 16).replace(/[:T]/g, "-");
    return { d, iso };
  };

  // ---------- Minimal ZIP (store) ----------
  const crc32Table = useMemo(() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  }, []);
  const crc32 = (u8) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = crc32Table[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const le16 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255]);
  const le32 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
  const concatBytes = (parts) => {
    const size = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(size);
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return out;
  };
  const makeZip = async (files) => {
    const chunks = [];
    const central = [];
    let offset = 0;
    const enc = new TextEncoder();
    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);
      const hdr = [
        le32(0x04034b50), le16(20), le16(0), le16(0), le16(0), le16(0),
        le32(crc), le32(data.length), le32(data.length), le16(nameBytes.length), le16(0)
      ];
      const local = concatBytes([...hdr, nameBytes, data]);
      chunks.push(local);
      const cenHdr = [
        le32(0x02014b50), le16(20), le16(20), le16(0), le16(0), le16(0), le16(0),
        le32(crc), le32(data.length), le32(data.length), le16(nameBytes.length), le16(0), le16(0), le16(0), le16(0),
        le32(offset)
      ];
      central.push(concatBytes([...cenHdr, nameBytes]));
      offset += local.length;
    }
    const centralDir = concatBytes(central);
    const end = concatBytes([le32(0x06054b50), le16(0), le16(0), le16(files.length), le16(files.length), le32(centralDir.length), le32(offset), le16(0)]);
    const zipBytes = concatBytes([...chunks, centralDir, end]);
    return new Blob([zipBytes], { type: 'application/zip' });
  };

  // ---------- events ----------
  const onFile = async (file) => {
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      if (!Array.isArray(json)) throw new Error("Unexpected JSON format");
      setConvos(json);
      setSelected(new Set(json.map((_, i) => i)));
      setPreviewIdx(json.length ? 0 : null);
    } catch (e) {
      alert("无法解析 JSON：" + e.message);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFile(file);
  };

  const toggle = (idx) => {
    const next = new Set(selected);
    next.has(idx) ? next.delete(idx) : next.add(idx);
    setSelected(next);
  };

  const highlight = (idx) => setPreviewIdx(idx);

  // visible list after filter
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return convos.map((c, idx) => ({ c, idx }));
    return convos
      .map((c, idx) => ({ c, idx }))
      .filter(({ c }) => String(c.title || "").toLowerCase().includes(q));
  }, [convos, query]);

  // cache message counts to avoid recomputing chains repeatedly
  const msgCounts = useMemo(() => {
    const map = new Map();
    for (let i = 0; i < convos.length; i++) {
      map.set(i, buildChain(convos[i]).length);
    }
    return map;
  }, [convos]);

  const selectAllVisible = () => { const n = new Set(selected); visible.forEach(({ idx }) => n.add(idx)); setSelected(n); };
  const deselectAllVisible = () => { const n = new Set(selected); visible.forEach(({ idx }) => n.delete(idx)); setSelected(n); };
  const invertVisible = () => { const n = new Set(selected); visible.forEach(({ idx }) => (n.has(idx) ? n.delete(idx) : n.add(idx))); setSelected(n); };

  const downloadOne = (idx) => {
    const conv = convos[idx];
    const { iso } = fmtDate(conv.create_time);
    const filename = `${iso}_${safe(conv.title)}.md`;
    const blob = new Blob([toMarkdown(conv)], { type: "text/markdown" });
    triggerDownload(blob, filename);
  };
  const downloadSelected = () => { if (!selected.size) return; [...selected].sort((a,b)=>a-b).forEach(downloadOne); };
  const downloadZip = async () => {
    if (!selected.size) return;
    const enc = new TextEncoder();
    const files = [...selected].sort((a,b)=>a-b).map(i => {
      const conv = convos[i];
      const { iso } = fmtDate(conv.create_time);
      const name = `${iso}_${safe(conv.title)}.md`;
      const data = enc.encode(toMarkdown(conv));
      return { name, data };
    });
    const zip = await makeZip(files);
    triggerDownload(zip, `conversations_${Date.now()}.zip`);
  };

  // NEW: merge export into a single Markdown
  const downloadMerged = () => {
    if (!selected.size) return;
    const parts = [];
    const sep = "\n\n---\n\n";
    [...selected].sort((a,b)=>a-b).forEach(i => {
      const conv = convos[i];
      const { iso } = fmtDate(conv.create_time);
      parts.push(`# ${conv.title || 'Untitled'} (${iso})\n\n` + toMarkdown(conv));
    });
    const blob = new Blob([parts.join(sep)], { type: 'text/markdown' });
    triggerDownload(blob, `merged_conversations_${Date.now()}.md`);
  };

  // NEW: copy preview to clipboard
  const copyPreview = async () => {
    if (previewIdx == null) return;
    const md = toMarkdown(convos[previewIdx]);
    try { await navigator.clipboard.writeText(md); alert('已复制预览到剪贴板'); } catch { alert('复制失败'); }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (e.key.toLowerCase() === 'a') selectAllVisible();
      if (e.key.toLowerCase() === 'i') invertVisible();
      if (e.key.toLowerCase() === 'd') downloadSelected();
      if (e.key.toLowerCase() === 'z') downloadZip();
      if (e.key.toLowerCase() === 'm') downloadMerged();
      if (e.key.toLowerCase() === 'c') copyPreview();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, selected, previewIdx, convos]);

  const previewConv = previewIdx != null ? convos[previewIdx] : null;
  const previewMsgs = previewConv ? buildChain(previewConv).filter(m => (extractText(m) || '').trim().length > 0) : [];

  return (
    <div className={`outer ${themeClass(theme)}`}>
      <style>{pickThemeCss(theme)}</style>
      <div className="wrap">
        <header className="hero">
          <h1>Conversation Splitter <span className="ham">🐹</span></h1>
          <p>拖入 <code>conversations.json</code>，筛选、预览并批量导出 Markdown。</p>
        </header>

        <section
          className={"dropzone" + (dragging ? " dragging" : "")}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <input type="file" accept="application/json" onChange={(e) => onFile(e.target.files?.[0])} />
          <div className="hint"><strong>点击或拖拽</strong> <code>conversations.json</code> 到此处上传</div>
        </section>

        {convos.length > 0 && (
          <>
            <div className="toolbar">
              <div className="stats">共 <b>{convos.length}</b> 条 · 显示 <b>{visible.length}</b> 条 · 已选 <b>{selected.size}</b> 条</div>
              <div className="actions">
                <select className="select" value={theme} onChange={(e)=>setTheme(e.target.value)} aria-label="主题">
                  <option value="cream">奶油糊糊</option>
                  <option value="berry">浆果啃啃</option>
                  <option value="basket">花篮翻翻</option>
                  <option value="cloud">云朵团团</option>
                </select>
                <input ref={searchRef} className="search" placeholder="按标题筛选…（按 / 聚焦）" value={query} onChange={(e)=>setQuery(e.target.value)} />
                <button onClick={selectAllVisible} title="A">全选(当前筛选)</button>
                <button onClick={deselectAllVisible}>取消全选</button>
                <button onClick={invertVisible} title="I">反选</button>
                <button className="primary" disabled={!selected.size} onClick={downloadSelected} title="D">吱吱收下</button>
                <button className="primary" disabled={!selected.size} onClick={downloadZip} title="Z">打包ZIP</button>
                <button disabled={!selected.size} onClick={downloadMerged} title="M">合并导出MD</button>
                <button disabled={previewIdx==null} onClick={copyPreview} title="C">复制预览</button>
              </div>
            </div>

            <div className="split">
              {/* left list */}
              <div className="list">
                {visible.map(({ c, idx }) => {
                  const checked = selected.has(idx);
                  const { d } = fmtDate(c.create_time);
                  const date = d.toISOString().slice(0, 10);
                  const msgCount = msgCounts.get(idx) || 0;
                  const active = previewIdx === idx;
                  return (
                    <div
                      key={c.id || idx}
                      className={"row" + (active ? " active" : "")}
                      onClick={() => highlight(idx)}
                    >
                      <label className="chk">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => { e.stopPropagation(); toggle(idx); }}
                        />
                      </label>
                      <div className="meta">
                        <div className="title" title={c.title || "Untitled"}>{date}｜{c.title || "Untitled"}</div>
                        <div className="sub">{msgCount} 条消息</div>
                      </div>
                      <div className="spacer" />
                      <button className="ghost" onClick={(e) => { e.stopPropagation(); downloadOne(idx); }}>单独下载</button>
                    </div>
                  );
                })}
              </div>

              {/* right preview */}
              <div className="preview">
                {previewConv ? (
                  <>
                    <div className="pv-head">
                      <div className="pv-title" title={previewConv.title || "Untitled"}>{previewConv.title || "Untitled"}</div>
                      <div className="pv-sub">{fmtDate(previewConv.create_time).d.toLocaleString()} · {previewMsgs.length} 条消息</div>
                    </div>
                    <div className="pv-body">
                      {previewMsgs.map((m, i) => {
                        const role = m.author?.role || "assistant";
                        const text = extractText(m);
                        const side = role === "assistant" ? "left" : "right";
                        const displayRole = role === "assistant" ? "Syzygy" : "串串";
                        return (
                          <div key={i} className={`msg ${side}`}>
                            <div className="bubble">
                              <div className="role">{displayRole}</div>
                              <div className="text">{text}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <div className="pv-empty">选择左侧一条对话进行预览</div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// 主题选择器
function themeClass(theme) {
  return theme === 'cream' ? 'theme-cream' : theme === 'berry' ? 'theme-berry' : theme === 'basket' ? 'theme-basket' : 'theme-cloud';
}
function pickThemeCss(theme) {
  if (theme === 'cream') return cssCream;
  if (theme === 'berry') return cssBerry;
  if (theme === 'basket') return cssBasket;
  return cssCloud; // default to cloud if unknown
}

// ------------------- Themes -------------------
// 奶油糊糊（浅色）
const cssCream = `
:root{--bg:#F5E6D1;--card:#fff;--muted:#5E7B9B;--text:#2b2b2b;--accent:#B46C72;--accent-600:#6E2E34;--ring:#FFC8CB;--bubble-user:#fff;--bubble-assist:#FFECEF}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
.outer{min-height:100vh;display:flex;align-items:center;justify-content:center}
.wrap{max-width:1100px;margin:32px auto;padding:0 16px;color:var(--text)}
.hero{background:linear-gradient(135deg,rgba(255,200,203,.45),rgba(180,108,114,.15));border:1px solid rgba(180,108,114,.25);padding:18px 20px;border-radius:16px;box-shadow:0 8px 24px rgba(110,46,52,.12)}
.hero h1{margin:0 0 6px 0;font-size:22px;letter-spacing:.4px;display:flex;align-items:center;gap:8px}
.hero .ham{font-size:20px}
.hero p{margin:0;color:var(--muted)}
.dropzone{margin-top:14px;border:2px dashed rgba(180,108,114,.45);border-radius:14px;padding:18px;text-align:center;background:rgba(255,255,255,.6)}
.dropzone.dragging{background:rgba(255,200,203,.4);border-color:var(--ring)}
.dropzone input{display:block;margin:0 auto 8px}
.dropzone .hint{color:var(--muted)}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:16px}
.toolbar .stats{color:#566}
.toolbar .actions{margin-left:auto;display:flex;gap:8px;align-items:center}
.select{height:34px;padding:0 8px;border-radius:10px;border:1px solid rgba(110,46,52,.25);background:#fff}
.search{height:34px;padding:6px 10px;border-radius:10px;border:1px solid rgba(110,46,52,.25);background:#fff;color:var(--text);min-width:180px;outline:none}
.search:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(255,200,203,.45)}
button{height:34px;padding:0 12px;border-radius:10px;border:1px solid rgba(110,46,52,.25);background:#fff;color:var(--text);cursor:pointer}
button:hover{border-color:var(--accent)}
button.primary{background:var(--accent);border-color:transparent;color:#fff}
button.primary:disabled{opacity:.55;cursor:not-allowed}
button.ghost{background:transparent;border-color:rgba(110,46,52,.25);color:var(--muted)}
.split{display:grid;grid-template-columns: 1fr 1fr;gap:12px;margin-top:12px}
.list{border:1px solid rgba(110,46,52,.25);border-radius:12px;overflow:hidden;background:var(--card);max-height:540px;overflow-y:auto}
.row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid rgba(110,46,52,.15);background:#fff}
.row:hover{background:#fff6f7}
.row.active{background:#FFECEF}
.row:last-child{border-bottom:none}
.chk{display:flex;align-items:center}
.meta{min-width:0}
.title{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sub{font-size:12px;color:var(--muted)}
.spacer{flex:1}
.preview{border:1px solid rgba(110,46,52,.25);border-radius:12px;background:var(--card);display:flex;flex-direction:column;min-height:360px;max-height:540px;overflow:hidden}
.pv-head{padding:12px 14px;border-bottom:1px solid rgba(110,46,52,.15)}
.pv-title{font-weight:600}
.pv-sub{font-size:12px;color:var(--muted)}
.pv-body{padding:12px 10px;overflow:auto;background:#fff}
.msg{display:flex;margin:8px 0}
.msg.left{justify-content:flex-start}
.msg.right{justify-content:flex-end}
.msg .bubble{max-width:100%;padding:8px 10px;border-radius:10px;border:1px solid rgba(110,46,52,.2);background:var(--bubble-assist);box-shadow:0 2px 8px rgba(0,0,0,.04)}
.msg.right .bubble{background:var(--bubble-user)}
.msg .role{font-size:11px;color:#6E2E34;opacity:.8;margin-bottom:4px}
.msg .text{white-space:pre-wrap;word-break:break-word}
.pv-empty{padding:20px;color:var(--muted)}
@media (max-width: 900px){.split{grid-template-columns:1fr}}
`;

// 浆果啃啃（复古深莓）
const cssBerry = `
:root{--bg:#284139;--card:#111A19;--muted:#BB6830;--text:#F8D794;--accent:#BB6830;--accent-600:#F8D794;--ring:#BB6830;--bubble-user:#111A19;--bubble-assist:#2f5146}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
.outer{min-height:100vh;display:flex;align-items:center;justify-content:center}
.wrap{max-width:1100px;margin:32px auto;padding:0 16px;color:var(--text)}
.hero{background:linear-gradient(135deg,rgba(187,104,48,.25),rgba(17,26,25,.6));border:1px solid rgba(187,104,48,.4);padding:18px 20px;border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.hero h1{margin:0 0 6px 0;font-size:22px;letter-spacing:.4px;display:flex;align-items:center;gap:8px;color:var(--text)}
.hero .ham{font-size:20px}
.hero p{margin:0;color:var(--muted)}
.dropzone{margin-top:14px;border:2px dashed rgba(187,104,48,.6);border-radius:14px;padding:18px;text-align:center;background:rgba(17,26,25,.7)}
.dropzone.dragging{background:rgba(187,104,48,.25);border-color:var(--ring)}
.dropzone input{display:block;margin:0 auto 8px}
.dropzone .hint{color:var(--muted)}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:16px}
.toolbar .stats{color:var(--muted)}
.toolbar .actions{margin-left:auto;display:flex;gap:8px;align-items:center}
.select{height:34px;padding:0 8px;border-radius:10px;border:1px solid rgba(187,104,48,.4);background:#111A19;color:var(--text)}
.search{height:34px;padding:6px 10px;border-radius:10px;border:1px solid rgba(187,104,48,.4);background:#111A19;color:var(--text);min-width:180px;outline:none}
.search:focus{border-color:var(--ring);box-shadow:0 0 0 3px rgba(187,104,48,.25)}
button{height:34px;padding:0 12px;border-radius:10px;border:1px solid rgba(187,104,48,.4);background:#111A19;color:var(--text);cursor:pointer}
button:hover{border-color:var(--ring)}
button.primary{background:var(--accent);border-color:transparent;color:#111A19}
button.primary:disabled{opacity:.55;cursor:not-allowed}
button.ghost{background:transparent;border-color:rgba(187,104,48,.4);color:var(--muted)}
.split{display:grid;grid-template-columns: 1fr 1fr;gap:12px;margin-top:12px}
.list{border:1px solid rgba(187,104,48,.4);border-radius:12px;overflow:hidden;background:var(--card);max-height:540px;overflow-y:auto}
.row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid rgba(187,104,48,.3);background:#111A19;color:var(--text)}
.row:hover{background:#1a2a26}
.row.active{background:#223630}
.row:last-child{border-bottom:none}
.chk{display:flex;align-items:center}
.meta{min-width:0}
.title{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}
.sub{font-size:12px;color:var(--muted)}
.spacer{flex:1}
.preview{border:1px solid rgba(187,104,48,.4);border-radius:12px;background:var(--card);display:flex;flex-direction:column;min-height:360px;max-height:540px;overflow:hidden;color:var(--text)}
.pv-head{padding:12px 14px;border-bottom:1px solid rgba(187,104,48,.3)}
.pv-title{font-weight:600}
.pv-sub{font-size:12px;color:var(--muted)}
.pv-body{padding:12px 10px;overflow:auto;background:#111A19}
.msg{display:flex;margin:8px 0}
.msg.left{justify-content:flex-start}
.msg.right{justify-content:flex-end}
.msg .bubble{max-width:100%;padding:8px 10px;border-radius:10px;border:1px solid rgba(187,104,48,.4);background:var(--bubble-assist);box-shadow:0 2px 8px rgba(0,0,0,.25);color:var(--text)}
.msg.right .bubble{background:var(--bubble-user)}
.msg .role{font-size:11px;color:var(--accent);opacity:.9;margin-bottom:4px}
.msg .text{white-space:pre-wrap;word-break:break-word}
.pv-empty{padding:20px;color:var(--muted)}
@media (max-width: 900px){.split{grid-template-columns:1fr}}
`;

// 花篮翻翻（莫奈花园风紫色系）
const cssBasket = `
:root{--bg:#F3EAF7;--card:#FFFFFF;--muted:#9C7CA5;--text:#2E2435;--accent:#C89BCB;--accent-600:#7A4E7E;--ring:#C89BCB;--bubble-user:#fff;--bubble-assist:#F8F0FA}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
.outer{min-height:100vh;display:flex;align-items:center;justify-content:center}
.wrap{max-width:1100px;margin:32px auto;padding:0 16px;color:var(--text)}
.hero{background:linear-gradient(135deg,rgba(200,155,203,.3),rgba(122,78,126,.15));border:1px solid rgba(200,155,203,.35);padding:18px 20px;border-radius:16px;box-shadow:0 8px 24px rgba(46,36,53,.15)}
.hero h1{margin:0 0 6px 0;font-size:22px;display:flex;align-items:center;gap:8px;color:var(--text)}
.hero .ham{font-size:20px}
.hero p{margin:0;color:var(--muted)}
.dropzone{margin-top:14px;border:2px dashed rgba(200,155,203,.45);border-radius:14px;padding:18px;text-align:center;background:rgba(255,255,255,.8)}
.dropzone.dragging{background:rgba(200,155,203,.25);border-color:var(--ring)}
.dropzone input{display:block;margin:0 auto 8px}
.dropzone .hint{color:var(--muted)}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:16px}
.toolbar .stats{color:var(--muted)}
.toolbar .actions{margin-left:auto;display:flex;gap:8px;align-items:center}
.select{height:34px;padding:0 8px;border-radius:10px;border:1px solid rgba(200,155,203,.35);background:#fff;color:var(--text)}
.search{height:34px;padding:6px 10px;border-radius:10px;border:1px solid rgba(200,155,203,.35);background:#fff;color:var(--text);min-width:180px;outline:none}
.search:focus{border-color:var(--ring);box-shadow:0 0 0 3px rgba(200,155,203,.25)}
button{height:34px;padding:0 12px;border-radius:10px;border:1px solid rgba(200,155,203,.35);background:#fff;color:var(--text);cursor:pointer}
button:hover{border-color:var(--ring)}
button.primary{background:var(--accent);border-color:transparent;color:#fff}
button.primary:disabled{opacity:.55;cursor:not-allowed}
button.ghost{background:transparent;border-color:rgba(200,155,203,.35);color:var(--muted)}
.split{display:grid;grid-template-columns: 1fr 1fr;gap:12px;margin-top:12px}
.list{border:1px solid rgba(200,155,203,.35);border-radius:12px;overflow:hidden;background:var(--card);max-height:540px;overflow-y:auto}
.row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid rgba(200,155,203,.25);background:#fff}
.row:hover{background:#faf5fb}
.row.active{background:#f3e1f6}
.row:last-child{border-bottom:none}
.chk{display:flex;align-items:center}
.meta{min-width:0}
.title{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}
.sub{font-size:12px;color:var(--muted)}
.spacer{flex:1}
.preview{border:1px solid rgba(200,155,203,.35);border-radius:12px;background:var(--card);display:flex;flex-direction:column;min-height:360px;max-height:540px;overflow:hidden;color:var(--text)}
.pv-head{padding:12px 14px;border-bottom:1px solid rgba(200,155,203,.25)}
.pv-title{font-weight:600}
.pv-sub{font-size:12px;color:var(--muted)}
.pv-body{padding:12px 10px;overflow:auto;background:#fff}
.msg{display:flex;margin:8px 0}
.msg.left{justify-content:flex-start}
.msg.right{justify-content:flex-end}
.msg .bubble{max-width:100%;padding:8px 10px;border-radius:10px;border:1px solid rgba(200,155,203,.3);background:var(--bubble-assist);box-shadow:0 2px 8px rgba(0,0,0,.05);color:var(--text)}
.msg.right .bubble{background:var(--bubble-user)}
.msg .role{font-size:11px;color:var(--accent);opacity:.9;margin-bottom:4px}
.msg .text{white-space:pre-wrap;word-break:break-word}
.pv-empty{padding:20px;color:var(--muted)}
@media (max-width: 900px){.split{grid-template-columns:1fr}}
`;

// 新主题：云朵团团（蓝调清爽）
const cssCloud = `
:root{--bg:#C6D4EE;--card:#FFFFFF;--muted:#264C9D;--text:#0E246A;--accent:#5A97CA;--accent-600:#264C9D;--ring:#5A97CA;--bubble-user:#FFFFFF;--bubble-assist:#E7F0FB}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
.outer{min-height:100vh;display:flex;align-items:center;justify-content:center}
.wrap{max-width:1100px;margin:32px auto;padding:0 16px;color:var(--text)}
.hero{background:linear-gradient(135deg,rgba(90,151,202,.25),rgba(14,36,106,.10));border:1px solid rgba(90,151,202,.35);padding:18px 20px;border-radius:16px;box-shadow:0 8px 24px rgba(14,36,106,.12)}
.hero h1{margin:0 0 6px 0;font-size:22px;display:flex;align-items:center;gap:8px;color:var(--text)}
.hero .ham{font-size:20px}
.hero p{margin:0;color:var(--muted)}
.dropzone{margin-top:14px;border:2px dashed rgba(90,151,202,.55);border-radius:14px;padding:18px;text-align:center;background:rgba(255,255,255,.8)}
.dropzone.dragging{background:rgba(90,151,202,.25);border-color:var(--ring)}
.dropzone input{display:block;margin:0 auto 8px}
.dropzone .hint{color:var(--muted)}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:16px}
.toolbar .stats{color:var(--muted)}
.toolbar .actions{margin-left:auto;display:flex;gap:8px;align-items:center}
.select{height:34px;padding:0 8px;border-radius:10px;border:1px solid rgba(90,151,202,.35);background:#fff;color:var(--text)}
.search{height:34px;padding:6px 10px;border-radius:10px;border:1px solid rgba(90,151,202,.35);background:#fff;color:var(--text);min-width:180px;outline:none}
.search:focus{border-color:var(--ring);box-shadow:0 0 0 3px rgba(90,151,202,.25)}
button{height:34px;padding:0 12px;border-radius:10px;border:1px solid rgba(90,151,202,.35);background:#fff;color:var(--text);cursor:pointer}
button:hover{border-color:var(--ring)}
button.primary{background:var(--accent);border-color:transparent;color:#fff}
button.primary:disabled{opacity:.55;cursor:not-allowed}
button.ghost{background:transparent;border-color:rgba(90,151,202,.35);color:var(--muted)}
.split{display:grid;grid-template-columns: 1fr 1fr;gap:12px;margin-top:12px}
.list{border:1px solid rgba(90,151,202,.35);border-radius:12px;overflow:hidden;background:var(--card);max-height:540px;overflow-y:auto}
.row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid rgba(90,151,202,.25);background:#fff}
.row:hover{background:#f0f6ff}
.row.active{background:#E7F0FB}
.row:last-child{border-bottom:none}
.chk{display:flex;align-items:center}
.meta{min-width:0}
.title{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}
.sub{font-size:12px;color:var(--muted)}
.spacer{flex:1}
.preview{border:1px solid rgba(90,151,202,.35);border-radius:12px;background:var(--card);display:flex;flex-direction:column;min-height:360px;max-height:540px;overflow:hidden;color:var(--text)}
.pv-head{padding:12px 14px;border-bottom:1px solid rgba(90,151,202,.25)}
.pv-title{font-weight:600}
.pv-sub{font-size:12px;color:var(--muted)}
.pv-body{padding:12px 10px;overflow:auto;background:#fff}
.msg{display:flex;margin:8px 0}
.msg.left{justify-content:flex-start}
.msg.right{justify-content:flex-end}
.msg .bubble{max-width:100%;padding:8px 10px;border-radius:10px;border:1px solid rgba(90,151,202,.3);background:var(--bubble-assist);box-shadow:0 2px 8px rgba(0,0,0,.05);color:var(--text)}
.msg.right .bubble{background:var(--bubble-user)}
.msg .role{font-size:11px;color:var(--accent);opacity:.9;margin-bottom:4px}
.msg .text{white-space:pre-wrap;word-break:break-word}
.pv-empty{padding:20px;color:var(--muted)}
@media (max-width: 900px){.split{grid-template-columns:1fr}}
`;
