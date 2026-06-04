// ─── Design tokens (neon dark) ────────────────────────────────────
const C = {
  bg: "#040d1c",
  surface: "#080f1e",
  surfaceHigh: "#0d1a30",
  border: "#152a45",
  accent: "#00e5ff",
  accent2: "#ff4d6d",
  gold: "#ffd166",
  green: "#06ffa5",
  purple: "#b48eff",
  text: "#e8f4ff",
  muted: "#3a6a8a",
  mutedLight: "#5a8aaa",
};

// ─── Utilities ────────────────────────────────────────────────────
const fmt = (d) => d.toISOString().slice(0, 16);
const fmtDate = (d) => new Date(d).toLocaleDateString("ja-JP", { month: "short", day: "numeric", weekday: "short" });
const fmtTime = (d) => new Date(d).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

const DURATION_OPTIONS = [
  { label: "30分", value: 30 },
  { label: "1時間", value: 60 },
  { label: "1時間30分", value: 90 },
  { label: "2時間", value: 120 },
  { label: "3時間", value: 180 },
];

// ─── Storage helpers (shared across users) ────────────────────────
const KEY = (id) => `schedroom_${id}`;

async function saveRoom(id, data) {
  try { await window.storage.set(KEY(id), JSON.stringify(data), true); return true; }
  catch { 
    // window.storage がない場合のローカルフォールバック
    try { localStorage.setItem(KEY(id), JSON.stringify(data)); return true; } catch { return false; }
  }
}
async function loadRoom(id) {
  try { const r = await window.storage.get(KEY(id), true); return r ? JSON.parse(r.value) : null; }
  catch { 
    try { const r = localStorage.getItem(KEY(id)); return r ? JSON.parse(r) : null; } catch { return null; }
  }
}

function genRoomId() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

// ─── Parse events from free-text ─────────────────────────────────
async function parseScheduleText(text, startDate, endDate) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: `あなたはスケジュール解析AIです。
ユーザーが貼り付けたGoogleカレンダーの予定テキストを解析し、予定の一覧をJSONで返してください。
出力形式: {"events": [{"title": "タイトル", "start": "2026-06-03T09:00:00", "end": "2026-06-03T10:00:00"}]}
・日時はISO8601形式（タイムゾーンなし）
・対象期間: ${startDate} 〜 ${endDate}
・マークダウン不要、JSONのみ返すこと`,
      messages: [{ role: "user", content: `以下の予定テキストを解析してください:\n\n${text}` }],
    }),
  });
  const data = await res.json();
  for (const block of (data.content || [])) {
    if (block.type !== "text") continue;
    try {
      const clean = block.text.replace(/```json\n?|```\n?/g, "").trim();
      const parsed = JSON.parse(clean);
      if (Array.isArray(parsed.events)) return parsed.events;
    } catch {}
  }
  return [];
}

// ─── Compute free slots ───────────────────────────────────────────
function computeFreeSlots(events, startDate, endDate, durationMin) {
  const slots = [];
  const dur = durationMin * 60 * 1000;
  let cursor = new Date(startDate);
  const end = new Date(endDate);
  const busy = events.map(e => ({ s: new Date(e.start), e: new Date(e.end) })).sort((a, b) => a.s - b.s);
  while (cursor < end) {
    const slotEnd = new Date(cursor.getTime() + dur);
    if (slotEnd > end) break;
    const conflict = busy.find(b => b.s < slotEnd && b.e > cursor);
    if (conflict) { cursor = new Date(conflict.e); }
    else { slots.push({ start: new Date(cursor), end: slotEnd }); cursor = slotEnd; }
  }
  return slots;
}

function intersectSlots(allSlots) {
  if (!allSlots.length) return [];
  let result = allSlots[0];
  for (let i = 1; i < allSlots.length; i++) {
    const next = [];
    for (const a of result) for (const b of allSlots[i]) {
      const s = new Date(Math.max(+a.start, +b.start));
      const e = new Date(Math.min(+a.end, +b.end));
      if (s < e) next.push({ start: s, end: e });
    }
    result = next;
  }
  return result;
}

function makeGCalLink(title, start, end, desc = "") {
  const f = d => d.toISOString().replace(/[-:]/g, "").replace(".000", "");
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${f(start)}/${f(end)}&details=${encodeURIComponent(desc)}`;
}

function makeCalendarPrompt(startDate, endDate) {
  return `私のGoogleカレンダーの予定を${startDate}から${endDate}まで全て教えてください。各予定のタイトル・開始時間・終了時間を一覧形式で出力してください。`;
}

// ─── Main App ─────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState("top");
  const [roomId, setRoomId] = useState(null);
  const [joinInput, setJoinInput] = useState("");
  const [hostedRooms, setHostedRooms] = useState([]);

  // アプリ起動時に自分が作成したルームの履歴をローカルから復元
  useEffect(() => {
    try {
      const saved = localStorage.getItem("schedsync_hosted_history");
      if (saved) setHostedRooms(JSON.parse(saved));
    } catch {}
  }, []);

  const handleCreateRoom = async () => {
    const id = genRoomId();
    await saveRoom(id, { id, submissions: [], createdAt: new Date().toISOString() });
    
    // 履歴を更新（最大5件保持）
    const nextHistory = [id, ...hostedRooms.filter(historyId => historyId !== id)].slice(0, 5);
    setHostedRooms(nextHistory);
    try { localStorage.setItem("schedsync_hosted_history", JSON.stringify(nextHistory)); } catch {}

    setRoomId(id); 
    setScreen("host");
  };

  const handleResumeRoom = (id) => {
    setRoomId(id);
    setScreen("host");
  };

  return (
    <Page>
      {screen === "top" && <TopScreen
        onCreate={handleCreateRoom}
        onJoin={() => setScreen("join")}
        hostedRooms={hostedRooms}
        onResume={handleResumeRoom}
      />}
      {screen === "join" && <JoinScreen
        value={joinInput} onChange={setJoinInput}
        onBack={() => setScreen("top")}
        onJoin={async () => {
          const id = joinInput.trim().toUpperCase();
          const data = await loadRoom(id);
          if (!data) { alert("ルームが見つかりません。IDを確認してください。"); return; }
          setRoomId(id); setScreen("member");
        }}
      />}
      {screen === "member" && <MemberScreen roomId={roomId} onBack={() => setScreen("top")} />}
      {screen === "host" && <HostScreen roomId={roomId} onBack={() => setScreen("top")} />}
      <GlobalStyle />
    </Page>
  );
}

// ─── TOP ─────────────────────────────────────────────────────────
function TopScreen({ onCreate, onJoin, hostedRooms, onResume }) {
  return (
    <div style={{ maxWidth: 440, margin: "0 auto", padding: "48px 20px 32px", textAlign: "center" }}>
      <GlowOrb color={C.accent} opacity={0.12} size={200} style={{ top: -60, left: "50%", transform: "translateX(-50%)" }} />
      <div style={{ fontSize: 48, marginBottom: 16 }}>📅</div>
      <h1 style={{ margin: "0 0 6px", fontSize: 30, fontWeight: 900, letterSpacing: "-2px", fontFamily: "monospace" }}>
        <span style={{ color: C.accent }}>SCHED</span><span style={{ color: C.text }}>SYNC</span>
      </h1>
      <p style={{ margin: "0 0 48px", color: C.muted, fontSize: 13 }}>予定テキスト貼り付け → 全員の空き時間を自動算出</p>

      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 32 }}>
        <ModeBtn color={C.accent} emoji="✨" title="ルームを作成する" desc="主催者として部屋を作り、参加者にIDを共有する" onClick={onCreate} />
        <ModeBtn color={C.gold} emoji="🔑" title="ルームに参加する" desc="主催者から届いたルームIDを入力して参加する" onClick={onJoin} />
      </div>

      {/* 👑 主催したルームの履歴セクション */}
      {hostedRooms.length > 0 && (
        <div style={{ textAlign: "left", marginTop: 24 }}>
          <p style={{ fontSize: 11, color: C.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", marginBottom: 8, paddingLeft: 4 }}>
            👑 あなたが作成したルーム履歴
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {hostedRooms.map((id) => (
              <div key={id} onClick={() => onResume(id)} style={{
                background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px 14px",
                display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", transition: "all 0.2s"
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.gold; e.currentTarget.style.background = `${C.gold}05`; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.background = C.surface; }}>
                <span style={{ fontFamily: "monospace", fontWeight: 800, color: C.gold, letterSpacing: "1px" }}>{id}</span>
                <span style={{ fontSize: 11, color: C.mutedLight }}>管理画面を開く →</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ModeBtn({ color, emoji, title, desc, onClick }) {
  const [h, setH] = useState(false);
  return (
    <button onClick={onClick} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{ background: h ? `${color}18` : C.surface, border: `1.5px solid ${h ? color : C.border}`, borderRadius: 16, padding: "20px 18px", cursor: "pointer", textAlign: "left", transition: "all 0.2s", boxShadow: h ? `0 0 24px ${color}33` : "none", display: "flex", gap: 14, alignItems: "flex-start", width: "100%" }}>
      <span style={{ fontSize: 26 }}>{emoji}</span>
      <div>
        <p style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 800, color: C.text }}>{title}</p>
        <p style={{ margin: 0, fontSize: 12, color: C.mutedLight, lineHeight: 1.5 }}>{desc}</p>
      </div>
    </button>
  );
}

// ─── JOIN ─────────────────────────────────────────────────────────
function JoinScreen({ value, onChange, onJoin, onBack }) {
  return (
    <div style={{ maxWidth: 420, margin: "0 auto", padding: "24px 20px" }}>
      <BackBtn onClick={onBack} />
      <SecTitle color={C.gold}>🔑 ルームに参加</SecTitle>
      <Card>
        <FieldLabel>ルームID（6文字）</FieldLabel>
        <input value={value} onChange={e => onChange(e.target.value.toUpperCase())} placeholder="例：AB12CD" maxLength={6}
          style={{ ...iSt, textAlign: "center", fontSize: 24, letterSpacing: "8px", fontWeight: 900, marginBottom: 14 }} />
        <NBtn color={C.gold} onClick={onJoin} full style={{ color: "#1a1000" }}>参加する →</NBtn>
      </Card>
    </div>
  );
}

// ─── MEMBER ───────────────────────────────────────────────────────
function MemberScreen({ roomId, onBack }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState(() => fmt(new Date()));
  const [endDate, setEndDate] = useState(() => fmt(addDays(new Date(), 14)));
  const [duration, setDuration] = useState(60);
  const [pastedText, setPastedText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [freeSlots, setFreeSlots] = useState([]);
  const [copied, setCopied] = useState(false);

  const prompt = makeCalendarPrompt(startDate, endDate);

  // 🛡️ 改良された堅牢なコピールーチン (WebView/非HTTPS環境対応フォールバック付)
  const copyPrompt = async () => {
    let success = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(prompt);
        success = true;
      } else {
        // フォールバック: 一時的なtextareaを用いた古典的コピー処理
        const textArea = document.createElement("textarea");
        textArea.value = prompt;
        textArea.style.position = "fixed"; 
        textArea.style.top = "0";
        textArea.style.left = "0";
        textArea.style.opacity = "0";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        success = document.execCommand('copy');
        document.body.removeChild(textArea);
      }
    } catch (e) {
      success = false;
    }

    if (success) {
      setCopied(true);
    } else {
      alert("自動コピーがブロックされました。枠内の文字を長押しして手動でコピーしてください。");
    }
    setTimeout(() => setCopied(false), 2000);
  };

  const analyze = async () => {
    if (!pastedText.trim()) { setError("予定テキストを貼り付けてください"); return; }
    setLoading(true); setError(null);
    try {
      const events = await parseScheduleText(pastedText, startDate, endDate);
      const slots = computeFreeSlots(events, new Date(startDate), new Date(endDate), duration);
      setFreeSlots(slots);
      setStep(4);
    } catch (e) {
      setError("解析に失敗しました: " + e.message);
    } finally { setLoading(false); }
  };

  const submit = async () => {
    if (!name.trim()) { setError("名前を入力してください"); return; }
    setLoading(true); setError(null);
    try {
      const room = await loadRoom(roomId);
      if (!room) throw new Error("ルームが見つかりません");
      const others = (room.submissions || []).filter(s => s.name !== name.trim());
      room.submissions = [...others, {
        name: name.trim(),
        slots: freeSlots.map(s => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
        submittedAt: new Date().toISOString(),
      }];
      await saveRoom(roomId, room);
      setStep(5);
    } catch (e) {
      setError(e.message);
    } finally { setLoading(false); }
  };

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "24px 20px" }}>
      <BackBtn onClick={onBack} />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
        <SecTitle color={C.accent}>👤 空き時間を送信</SecTitle>
        <RoomBadge id={roomId} />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 20 }}>
        {[1,2,3,4].map((s, i) => (
          <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 26, height: 26, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700,
              background: step > s ? C.green : step === s ? C.accent : C.surfaceHigh,
              color: step >= s ? C.bg : C.muted, border: `1.5px solid ${step > s ? C.green : step === s ? C.accent : C.border}`,
              boxShadow: step === s ? `0 0 10px ${C.accent}66` : "none", transition: "all 0.3s",
            }}>{step > s ? "✓" : s}</div>
            {i < 3 && <div style={{ width: 20, height: 1.5, background: step > s ? C.green : C.border, transition: "background 0.3s" }} />}
          </div>
        ))}
        <span style={{ color: C.mutedLight, fontSize: 11, marginLeft: 8 }}>
          {["設定", "Claudeへ", "貼り付け", "送信"][Math.min(step,4)-1]}
        </span>
      </div>

      {step === 5 && (
        <Card style={{ textAlign: "center", padding: "40px 20px" }}>
          <GlowOrb color={C.green} size={100} opacity={0.15} style={{ top: 10, left: "50%", transform: "translateX(-50%)" }} />
          <div style={{ fontSize: 52, marginBottom: 12 }}>✅</div>
          <p style={{ fontSize: 20, fontWeight: 900, color: C.green, margin: "0 0 8px" }}>送信完了！</p>
          <p style={{ color: C.mutedLight, fontSize: 13, margin: "0 0 4px" }}>{name} さんの空き時間</p>
          <p style={{ color: C.accent, fontWeight: 900, fontSize: 32, margin: 0 }}>{freeSlots.length}<span style={{ fontSize: 14, fontWeight: 400 }}>件</span></p>
          <p style={{ color: C.muted, fontSize: 12, marginTop: 20, lineHeight: 1.7 }}>
            主催者がルーム画面を更新すると<br />あなたの空き時間が反映されます
          </p>
          <NBtn color={C.muted} onClick={onBack} full style={{ marginTop: 20, background: C.surfaceHigh, boxShadow: "none" }}>トップに戻る</NBtn>
        </Card>
      )}

      {step === 1 && (
        <Card>
          <FieldLabel>あなたの名前</FieldLabel>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="例：田中 太郎" style={{ ...iSt, marginBottom: 14 }} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
            <div><FieldLabel>開始日時</FieldLabel><input type="datetime-local" value={startDate} onChange={e => setStartDate(e.target.value)} style={iSt} /></div>
            <div><FieldLabel>終了日時</FieldLabel><input type="datetime-local" value={endDate} onChange={e => setEndDate(e.target.value)} style={iSt} /></div>
          </div>
          <FieldLabel>必要な空き時間</FieldLabel>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            {DURATION_OPTIONS.map(o => <DurChip key={o.value} label={o.label} active={duration === o.value} onClick={() => setDuration(o.value)} />)}
          </div>
          {error && <ErrBox msg={error} />}
          <NBtn color={C.accent} onClick={() => { if (!name.trim()) { setError("名前を入力してください"); return; } setError(null); setStep(2); }} full style={{ marginTop: 16, color: C.bg }}>次へ →</NBtn>
        </Card>
      )}

      {step === 2 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Card style={{ borderColor: `${C.purple}55` }}>
            <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: C.purple }}>
              📋 STEP 1 — Claudeのチャットで予定を取得
            </p>
            <p style={{ color: C.mutedLight, fontSize: 13, lineHeight: 1.7, margin: "0 0 14px" }}>
              下のプロンプトをコピーして、<strong style={{ color: C.text }}>Claudeのチャット画面</strong>に貼り付けてください。<br />
              ClaudeがGoogleカレンダーを読んで予定一覧を返してくれます。
            </p>

            <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", marginBottom: 10, fontFamily: "monospace", fontSize: 12, color: C.text, lineHeight: 1.7, whiteSpace: "pre-wrap", userSelect: "all" }}>
              {prompt}
            </div>
            <button onClick={copyPrompt} style={{
              width: "100%", padding: "10px", background: copied ? `${C.green}22` : `${C.purple}22`,
              border: `1px solid ${copied ? C.green : C.purple}`, borderRadius: 8,
              color: copied ? C.green : C.purple, cursor: "pointer", fontSize: 13, fontWeight: 700,
            }}>
              {copied ? "✓ コピーしました！" : "📋 プロンプトをコピー"}
            </button>
          </Card>

          <Card style={{ borderColor: `${C.accent}33` }}>
            <p style={{ margin: "0 0 8px", fontSize: 13, color: C.mutedLight, lineHeight: 1.7 }}>
              <span style={{ color: C.gold, fontWeight: 700 }}>①</span> Claudeのチャット画面を開く<br />
              <span style={{ color: C.gold, fontWeight: 700 }}>②</span> プロンプトを貼り付けて送信<br />
              <span style={{ color: C.gold, fontWeight: 700 }}>③</span> Claudeが返した予定テキストをコピー<br />
              <span style={{ color: C.gold, fontWeight: 700 }}>④</span> このアプリに戻って「次へ」を押す
            </p>
          </Card>

          <NBtn color={C.accent} onClick={() => setStep(3)} full style={{ color: C.bg }}>Claudeから予定を取得したら次へ →</NBtn>
          <BackStep onClick={() => setStep(1)} />
        </div>
      )}

      {step === 3 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Card>
            <p style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 700, color: C.accent }}>
              📝 STEP 2 — Claudeの返答を貼り付け
            </p>
            <p style={{ color: C.mutedLight, fontSize: 13, margin: "0 0 12px", lineHeight: 1.6 }}>
              ClaudeがGoogleカレンダーの予定を返答したテキストをそのまま貼り付けてください。
            </p>
            <textarea value={pastedText} onChange={e => setPastedText(e.target.value)}
              placeholder={"例：\n6/5（木）10:00〜11:00 チームMTG\n6/6（金）14:00〜15:00 クライアント面談\n..."}
              rows={9} style={{ ...iSt, resize: "vertical", fontFamily: "monospace", fontSize: 12, lineHeight: 1.6 }} />
            {error && <ErrBox msg={error} />}
          </Card>
          <NBtn color={C.accent} onClick={analyze} loading={loading} full style={{ color: C.bg }}>
            {loading ? "⏳ 解析中…" : "🔍 空き時間を自動算出"}
          </NBtn>
          <BackStep onClick={() => setStep(2)} />
        </div>
      )}

      {step === 4 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Card style={{ borderColor: `${C.green}44` }}>
            <p style={{ margin: "0 0 14px", fontSize: 14, fontWeight: 700, color: C.green }}>
              ✅ 空き時間の算出完了
            </p>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <span style={{ color: C.mutedLight, fontSize: 13 }}>算出された空き時間</span>
              <span style={{ color: C.accent, fontWeight: 900, fontSize: 22 }}>{freeSlots.length}<span style={{ fontSize: 13, fontWeight: 400 }}>件</span></span>
            </div>

            <div style={{ maxHeight: 180, overflowY: "auto", display: "flex", flexDirection: "column", gap: 5, marginBottom: 14 }}>
              {freeSlots.slice(0, 10).map((s, i) => (
                <div key={i} style={{ background: C.bg, borderRadius: 7, padding: "8px 12px", display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12, color: C.text }}>{fmtDate(s.start)}</span>
                  <span style={{ fontSize: 12, color: C.mutedLight }}>{fmtTime(s.start)} 〜 {fmtTime(s.end)}</span>
                </div>
              ))}
              {freeSlots.length > 10 && <p style={{ color: C.muted, fontSize: 11, textAlign: "center", margin: 0 }}>…他 {freeSlots.length - 10} 件</p>}
            </div>

            <FieldLabel>送信者名の確認</FieldLabel>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="名前" style={{ ...iSt, marginBottom: 14 }} />

            {error && <ErrBox msg={error} />}
            <NBtn color={C.green} onClick={submit} loading={loading} full style={{ color: C.bg }}>
              {loading ? "⏳ 送信中…" : "📤 主催者に送信する"}
            </NBtn>
          </Card>
          <BackStep onClick={() => setStep(3)} />
        </div>
      )}
    </div>
  );
}

// ─── HOST ─────────────────────────────────────────────────────────
function HostScreen({ roomId, onBack }) {
  const [room, setRoom] = useState(null);
  const [loading, setLoading] = useState(true);
  const [commonSlots, setCommonSlots] = useState([]);
  const [computed, setComputed] = useState(false);
  const [selected, setSelected] = useState(null);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const data = await loadRoom(roomId);
    setRoom(data); setLoading(false);
  }, [roomId]);

  useEffect(() => { refresh(); }, [refresh]);

  const compute = () => {
    const subs = room?.submissions || [];
    if (subs.length < 2) return;
    const allSlots = subs.map(s => s.slots.map(sl => ({ start: new Date(sl.start), end: new Date(sl.end) })));
    setCommonSlots(intersectSlots(allSlots));
    setComputed(true); setSelected(null);
  };

  const shareText = `【スケジュール調整】\nルームID: ${roomId}\n\n以下の手順で空き時間を送ってください👇\n1. 共有されたアプリリンクを開く\n2. 「ルームに参加する」を選択\n3. ルームID「${roomId}」を入力`;

  const copyShare = async () => {
    let success = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(shareText);
        success = true;
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = shareText;
        textArea.style.position = "fixed"; textArea.style.opacity = "0";
        document.body.appendChild(textArea);
        textArea.focus(); textArea.select();
        success = document.execCommand('copy');
        document.body.removeChild(textArea);
      }
    } catch {}
    
    if (success) setCopied(true);
    else alert("手動でコピーしてください");
    setTimeout(() => setCopied(false), 2500);
  };

  const gcalLink = selected ? makeGCalLink(title || "ミーティング", selected.start, selected.end, desc) : null;
  const subs = room?.submissions || [];

  return (
    <div style={{ maxWidth: 520, margin: "0 auto", padding: "24px 20px" }}>
      <BackBtn onClick={onBack} />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
        <SecTitle color={C.gold}>👑 主催者ビュー</SecTitle>
        <RoomBadge id={roomId} />
      </div>

      <Card style={{ borderColor: `${C.gold}44`, marginBottom: 14 }}>
        <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: C.gold }}>📤 参加者に共有する</p>
        <div style={{ background: C.bg, borderRadius: 10, padding: "12px 14px", marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <p style={{ margin: "0 0 2px", fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "1px" }}>Room ID</p>
            <p style={{ margin: 0, fontSize: 28, fontWeight: 900, color: C.gold, letterSpacing: "6px", fontFamily: "monospace" }}>{roomId}</p>
          </div>
          <button onClick={copyShare} style={{
            background: copied ? `${C.green}22` : `${C.gold}22`, border: `1px solid ${copied ? C.green : C.gold}`,
            borderRadius: 8, padding: "8px 14px", color: copied ? C.green : C.gold, cursor: "pointer", fontSize: 12, fontWeight: 700,
          }}>{copied ? "✓ コピー済" : "📋 共有文をコピー"}</button>
        </div>
        <p style={{ margin: 0, fontSize: 11, color: C.muted, lineHeight: 1.7 }}>
          LINEなどでルームIDを共有。参加者はアプリを開き、手順に従って空き時間を送信します。
        </p>
      </Card>

      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: C.text }}>
            送信済み <span style={{ color: C.accent, fontSize: 20, fontWeight: 900 }}>{subs.length}</span> 名
          </p>
          <button onClick={refresh} style={{ background: `${C.accent}15`, border: `1px solid ${C.accent}44`, borderRadius: 8, padding: "6px 12px", color: C.accent, cursor: "pointer", fontSize: 12 }}>
            {loading ? "…" : "🔄 更新"}
          </button>
        </div>

        {subs.length === 0 ? (
          <p style={{ color: C.muted, fontSize: 13, textAlign: "center", padding: "20px 0" }}>まだ誰も送信していません</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {subs.map((s, i) => (
              <div key={i} style={{ background: C.bg, borderRadius: 8, padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: C.text }}>{s.name}</p>
                  <p style={{ margin: 0, fontSize: 11, color: C.muted }}>空き時間 {s.slots.length}件</p>
                </div>
                <span style={{ color: C.green, fontSize: 12, fontWeight: 600 }}>✓ 送信済み</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {subs.length >= 2 ? (
        <NBtn color={C.gold} onClick={compute} full style={{ marginBottom: 14, color: "#1a1000" }}>
          🔍 全員の共通空き時間を算出
        </NBtn>
      ) : (
        <p style={{ color: C.muted, fontSize: 12, textAlign: "center", marginBottom: 14 }}>
          2名以上の送信が必要です（現在 {subs.length}名）
        </p>
      )}

      {computed && (
        <Card style={{ marginBottom: 14 }}>
          <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: commonSlots.length > 0 ? C.green : C.accent2 }}>
            {commonSlots.length > 0 ? `✅ 共通の空き時間 ${commonSlots.length}件` : "❌ 共通の空き時間が見つかりませんでした"}
          </p>
          {commonSlots.length === 0 && (
            <p style={{ color: C.muted, fontSize: 13 }}>期間を広げるか、参加者に再送信してもらいましょう。</p>
          )}
          <div style={{ maxHeight: 280, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
            {commonSlots.map((slot, i) => (
              <div key={i} onClick={() => setSelected(slot)} style={{
                padding: "12px 14px", borderRadius: 8, cursor: "pointer",
                background: selected === slot ? `${C.gold}22` : C.bg,
                border: `1.5px solid ${selected === slot ? C.gold : C.border}`,
                display: "flex", justifyContent: "space-between", alignItems: "center",
                transition: "all 0.15s", boxShadow: selected === slot ? `0 0 12px ${C.gold}33` : "none",
              }}>
                <span style={{ fontSize: 13, color: C.text }}>{fmtDate(slot.start)}</span>
                <span style={{ fontSize: 13, color: C.mutedLight }}>{fmtTime(slot.start)} 〜 {fmtTime(slot.end)}</span>
                {selected === slot && <span style={{ fontSize: 11, color: C.gold, fontWeight: 800 }}>✓</span>}
              </div>
            ))}
          </div>
        </Card>
      )}

      {selected && (
        <Card style={{ borderColor: `${C.accent}44` }}>
          <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: C.accent }}>📝 予定を作成</p>
          <div style={{ background: `${C.accent}11`, border: `1px solid ${C.accent}33`, borderRadius: 8, padding: "10px 12px", marginBottom: 14 }}>
            <p style={{ margin: 0, fontSize: 13, color: C.accent, fontWeight: 600 }}>
              {fmtDate(selected.start)} {fmtTime(selected.start)} 〜 {fmtTime(selected.end)}
            </p>
          </div>
          <FieldLabel>イベントタイトル</FieldLabel>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="例：チームミーティング" style={{ ...iSt, marginBottom: 12 }} />
          <FieldLabel>説明・場所など（任意）</FieldLabel>
          <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder="アジェンダ、場所、URLなど" rows={3} style={{ ...iSt, resize: "vertical", marginBottom: 14 }} />
          <a href={gcalLink} target="_blank" rel="noreferrer" style={{
            display: "block", textAlign: "center", padding: "14px",
            background: `${C.accent}22`, border: `1.5px solid ${C.accent}`,
            borderRadius: 12, color: C.accent, textDecoration: "none", fontSize: 14, fontWeight: 700,
            boxShadow: `0 0 16px ${C.accent}33`,
          }}>
            📅 Googleカレンダーで予定を作成 →
          </a>
          <p style={{ color: C.muted, fontSize: 11, textAlign: "center", marginTop: 8 }}>
            リンクを開くとGoogleカレンダーの予定作成画面が開きます
          </p>
        </Card>
      )}
    </div>
  );
}

// ─── Shared UI ────────────────────────────────────────────────────
function Page({ children }) {
  return <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Noto Sans JP', sans-serif", position: "relative" }}>{children}</div>;
}
function GlowOrb({ color, size, opacity = 0.15, style = {} }) {
  return <div style={{ position: "absolute", width: size, height: size, borderRadius: "50%", background: color, filter: "blur(70px)", opacity, pointerEvents: "none", ...style }} />;
}
function Card({ children, style = {} }) {
  return <div style={{ background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 16, padding: "18px 16px", ...style }}>{children}</div>;
}
function NBtn({ children, color, onClick, loading, full, style = {} }) {
  return (
    <button onClick={onClick} disabled={loading} style={{ padding: "13px 20px", background: color, border: "none", borderRadius: 12, color: "#fff", cursor: loading ? "wait" : "pointer", fontSize: 14, fontWeight: 800, boxShadow: `0 0 18px ${color}55`, width: full ? "100%" : "auto", transition: "opacity 0.2s", ...style }}>
      {children}
    </button>
  );
}
function BackBtn({ onClick }) {
  return <button onClick={onClick} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 13, padding: "0 0 16px", display: "flex", alignItems: "center", gap: 4 }}>← 戻る</button>;
}
function BackStep({ onClick }) {
  return <button onClick={onClick} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 12, padding: "4px 0", display: "block" }}>← 前のステップへ</button>;
}
function SecTitle({ children, color }) {
  return <h2 style={{ margin: 0, fontSize: 18, fontWeight: 900, color: C.text, borderLeft: `3px solid ${color}`, paddingLeft: 10, fontFamily: "monospace", boxShadow: `inset 3px 0 8px ${color}33` }}>{children}</h2>;
}
function RoomBadge({ id }) {
  return <span style={{ background: `${C.gold}18`, border: `1px solid ${C.gold}55`, borderRadius: 6, padding: "3px 8px", fontSize: 12, color: C.gold, fontFamily: "monospace", fontWeight: 900, letterSpacing: "2px" }}>{id}</span>;
}
function FieldLabel({ children }) {
  return <label style={{ display: "block", fontSize: 10, color: C.muted, marginBottom: 5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }}>{children}</label>;
}
function DurChip({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{ padding: "7px 13px", borderRadius: 20, border: `1.5px solid ${active ? C.accent : C.border}`, background: active ? `${C.accent}22` : C.surfaceHigh, color: active ? C.accent : C.muted, cursor: "pointer", fontSize: 12, fontWeight: active ? 800 : 400, transition: "all 0.15s", boxShadow: active ? `0 0 10px ${C.accent}44` : "none" }}>
      {label}
    </button>
  );
}
function ErrBox({ msg }) {
  return <div style={{ background: `${C.accent2}15`, border: `1px solid ${C.accent2}55`, borderRadius: 8, padding: "10px 14px", color: C.accent2, fontSize: 12, marginTop: 10 }}>⚠ {msg}</div>;
}
const iSt = { width: "100%", padding: "10px 12px", borderRadius: 8, background: C.surfaceHigh, border: `1.5px solid ${C.border}`, color: C.text, fontSize: 14, outline: "none", boxSizing: "border-box" };
function GlobalStyle() {
  return <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;600;700;900&display=swap');
    * { box-sizing: border-box; }
    input, textarea, button, a { font-family: 'Noto Sans JP', sans-serif; }
    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 4px; }
  `}</style>;
}
