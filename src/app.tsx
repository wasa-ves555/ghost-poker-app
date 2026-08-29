/* ============================================================
   G POKER
   Pass-and-play bluffing card game (original ruleset inspired
   by "Kakerlakenpoker", reskinned with original ghost/monster
   motifs). React + TypeScript, no build step — transpiled in the
   browser via Babel standalone.
   ============================================================ */

const { useState, useReducer, useEffect, useMemo, useRef } = React;

// ---------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------

type CreatureId = "kappa" | "dracula" | "mummy" | "jack" | "blackcat" | "witch" | "werewolf" | "skeleton";

interface Creature {
  id: CreatureId;
  name: string;
  emoji: string;
  tagline: string;
}

interface CardT {
  id: string;
  type: CreatureId;
}

interface PlayerState {
  id: number;
  name: string;
  hand: CardT[];
  pile: Record<CreatureId, number>;
}

interface ActiveCard {
  card: CardT;
  claim: CreatureId;
  fromId: number;
  toId: number;
  chain: number[];
}

interface ResultInfo {
  active: ActiveCard;
  believedTrue: boolean;
  claimWasTrue: boolean;
  judgmentHit: boolean;
  takerId: number;
}

type Phase =
  | { kind: "setup" }
  | { kind: "hide"; forId: number; next: "initiator" | "recipient"; pendingActive?: ActiveCard; isFirst?: boolean }
  | { kind: "initiator"; playerId: number }
  | { kind: "recipient"; active: ActiveCard }
  | { kind: "passAlong"; active: ActiveCard }
  | { kind: "believeChoice"; active: ActiveCard }
  | { kind: "reveal"; result: ResultInfo }
  | {
      kind: "gameOver";
      winners: number[];
      losers: number[];
      triggerPlayerId: number | null;
      triggerType: CreatureId | null;
      nextStartId: number;
    };

interface GameState {
  players: PlayerState[];
  threshold: 4 | 5;
  phase: Phase;
  log: string[];
}

// ---------------------------------------------------------------
// Content: the eight spirits haunting the séance table
// ---------------------------------------------------------------

const CREATURES: Creature[] = [
  { id: "kappa", name: "カッパ", emoji: "\u{1F422}", tagline: "水辺に潜み、皿の水を切らすと途端に弱る" },
  { id: "dracula", name: "ドラキュラ", emoji: "\u{1F9DB}", tagline: "夜霧とともに現れる、血に飢えた貴族" },
  { id: "mummy", name: "ミイラ", emoji: "\u{1F9DF}", tagline: "包帯の下で何千年も眠り続ける古の亡者" },
  { id: "jack", name: "ジャックオーランタン", emoji: "\u{1F383}", tagline: "くり抜かれた顔に灯る、ハロウィンの案内役" },
  { id: "blackcat", name: "黒猫", emoji: "\u{1F408}\u{200D}\u{2B1B}", tagline: "夜道を横切り、不吉な予感を運んでくる" },
  { id: "witch", name: "魔女", emoji: "\u{1F9D9}", tagline: "箒にまたがり、怪しい薬を煮出す夜の住人" },
  { id: "werewolf", name: "狼男", emoji: "\u{1F43A}", tagline: "満月の夜だけ牙を剥く、二つの顔を持つ者" },
  { id: "skeleton", name: "骸骨", emoji: "\u{1F480}", tagline: "肉を失ってなお踊り続ける、陽気な骨" },
];

const CREATURE_MAP: Record<CreatureId, Creature> = CREATURES.reduce((acc, c) => {
  acc[c.id] = c;
  return acc;
}, {} as Record<CreatureId, Creature>);

const CARDS_PER_TYPE = 8;
const TWO_PLAYER_EXCLUDED = 10;

function emptyPile(): Record<CreatureId, number> {
  return { kappa: 0, dracula: 0, mummy: 0, jack: 0, blackcat: 0, witch: 0, werewolf: 0, skeleton: 0 };
}

// ---------------------------------------------------------------
// Deck / dealing utilities
// ---------------------------------------------------------------

function buildDeck(): CardT[] {
  const deck: CardT[] = [];
  for (const c of CREATURES) {
    for (let n = 0; n < CARDS_PER_TYPE; n++) {
      deck.push({ id: `${c.id}-${n}`, type: c.id });
    }
  }
  return deck;
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function dealNewGame(names: string[]): { players: PlayerState[]; threshold: 4 | 5 } {
  const n = names.length;
  let deck = shuffle(buildDeck());
  const threshold: 4 | 5 = n === 2 ? 5 : 4;

  if (n === 2) {
    // Remove 10 cards, unseen, from play.
    deck = deck.slice(TWO_PLAYER_EXCLUDED);
  }

  const players: PlayerState[] = names.map((name, i) => ({
    id: i,
    name,
    hand: [],
    pile: emptyPile(),
  }));

  deck.forEach((card, i) => {
    players[i % n].hand.push(card);
  });

  return { players, threshold };
}

// ---------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------

type Action =
  | { type: "START"; names: string[] }
  | { type: "CONFIRM_HIDE" }
  | { type: "INITIATE"; cardId: string; claim: CreatureId; targetId: number }
  | { type: "CHOOSE_JUDGE" }
  | { type: "CHOOSE_PASS_ALONG" }
  | { type: "BACK_TO_RECIPIENT" }
  | { type: "SUBMIT_PASS_ALONG"; claim: CreatureId; targetId: number }
  | { type: "BELIEVE"; believe: boolean }
  | { type: "CONTINUE_AFTER_REVEAL" }
  | { type: "RESTART" }
  | { type: "REPLAY"; startPlayerId: number };

function checkThresholdEnd(players: PlayerState[], threshold: number) {
  for (const p of players) {
    for (const c of CREATURES) {
      if (p.pile[c.id] >= threshold) {
        const losers = players.filter((q) => Object.values(q.pile).some((n) => n >= threshold)).map((q) => q.id);
        const winners = players.filter((q) => !losers.includes(q.id)).map((q) => q.id);
        return { over: true, winners, losers, triggerPlayerId: p.id, triggerType: c.id };
      }
    }
  }
  return { over: false, winners: [] as number[], losers: [] as number[], triggerPlayerId: null as number | null, triggerType: null as CreatureId | null };
}

function playerName(players: PlayerState[], id: number): string {
  return players.find((p) => p.id === id)?.name ?? "?";
}

const initialState: GameState = {
  players: [],
  threshold: 4,
  phase: { kind: "setup" },
  log: [],
};

function reducer(state: GameState, action: Action): GameState {
  switch (action.type) {
    case "START": {
      const { players, threshold } = dealNewGame(action.names);
      return {
        players,
        threshold,
        log: [],
        phase: { kind: "hide", forId: players[0].id, next: "initiator", isFirst: true },
      };
    }

    case "CONFIRM_HIDE": {
      if (state.phase.kind !== "hide") return state;
      const { forId, next, pendingActive } = state.phase;
      if (next === "initiator") {
        return { ...state, phase: { kind: "initiator", playerId: forId } };
      }
      return { ...state, phase: { kind: "recipient", active: pendingActive as ActiveCard } };
    }

    case "INITIATE": {
      if (state.phase.kind !== "initiator") return state;
      const playerId = state.phase.playerId;
      const player = state.players.find((p) => p.id === playerId);
      if (!player) return state;
      const card = player.hand.find((c) => c.id === action.cardId);
      if (!card) return state;

      const players = state.players.map((p) =>
        p.id === playerId ? { ...p, hand: p.hand.filter((c) => c.id !== action.cardId) } : p
      );
      const active: ActiveCard = {
        card,
        claim: action.claim,
        fromId: playerId,
        toId: action.targetId,
        chain: [playerId],
      };
      return {
        ...state,
        players,
        phase: { kind: "hide", forId: action.targetId, next: "recipient", pendingActive: active },
      };
    }

    case "CHOOSE_JUDGE": {
      if (state.phase.kind !== "recipient") return state;
      return { ...state, phase: { kind: "believeChoice", active: state.phase.active } };
    }

    case "CHOOSE_PASS_ALONG": {
      if (state.phase.kind !== "recipient") return state;
      return { ...state, phase: { kind: "passAlong", active: state.phase.active } };
    }

    case "BACK_TO_RECIPIENT": {
      if (state.phase.kind !== "believeChoice" && state.phase.kind !== "passAlong") return state;
      return { ...state, phase: { kind: "recipient", active: state.phase.active } };
    }

    case "SUBMIT_PASS_ALONG": {
      if (state.phase.kind !== "passAlong") return state;
      const active = state.phase.active;
      const newActive: ActiveCard = {
        ...active,
        claim: action.claim,
        fromId: active.toId,
        toId: action.targetId,
        chain: [...active.chain, active.toId],
      };
      return {
        ...state,
        phase: { kind: "hide", forId: action.targetId, next: "recipient", pendingActive: newActive },
      };
    }

    case "BELIEVE": {
      if (state.phase.kind !== "believeChoice") return state;
      const active = state.phase.active;
      // The claim can be true or a lie; the receiver's believe/not-believe
      // choice is their guess at that fact. Guessing right (judgmentHit)
      // means the card goes back to whoever made the claim; guessing wrong
      // means the receiver is stuck with it. This holds for every player count.
      const claimWasTrue = active.claim === active.card.type;
      const judgmentHit = action.believe === claimWasTrue;
      const takerId = judgmentHit ? active.fromId : active.toId;
      const players = state.players.map((p) =>
        p.id === takerId ? { ...p, pile: { ...p.pile, [active.card.type]: p.pile[active.card.type] + 1 } } : p
      );
      const result: ResultInfo = { active, believedTrue: action.believe, claimWasTrue, judgmentHit, takerId };
      const claimC = CREATURE_MAP[active.claim];
      const trueC = CREATURE_MAP[active.card.type];
      const logLine = `${playerName(state.players, active.fromId)}→${playerName(state.players, active.toId)}「${claimC.name}」と宣言 … ${
        playerName(state.players, active.toId)
      }は${action.believe ? "信じた" : "疑った"}（正体:${trueC.name}／判定${judgmentHit ? "的中" : "ハズレ"}）→ ${playerName(
        state.players,
        takerId
      )}が引き取り`;
      return { ...state, players, log: [logLine, ...state.log].slice(0, 30), phase: { kind: "reveal", result } };
    }

    case "CONTINUE_AFTER_REVEAL": {
      if (state.phase.kind !== "reveal") return state;
      const { takerId } = state.phase.result;
      const end = checkThresholdEnd(state.players, state.threshold);
      if (end.over) {
        return {
          ...state,
          phase: {
            kind: "gameOver",
            winners: end.winners,
            losers: end.losers,
            triggerPlayerId: end.triggerPlayerId,
            triggerType: end.triggerType,
            nextStartId: end.triggerPlayerId as number,
          },
        };
      }
      const taker = state.players.find((p) => p.id === takerId)!;
      if (taker.hand.length === 0) {
        return {
          ...state,
          phase: {
            kind: "gameOver",
            winners: state.players.map((p) => p.id),
            losers: [],
            triggerPlayerId: null,
            triggerType: null,
            nextStartId: taker.id,
          },
        };
      }
      return { ...state, phase: { kind: "hide", forId: takerId, next: "initiator" } };
    }

    case "RESTART":
      return initialState;

    case "REPLAY": {
      const names = state.players.map((p) => p.name);
      const { players, threshold } = dealNewGame(names);
      const startId = players.some((p) => p.id === action.startPlayerId) ? action.startPlayerId : players[0].id;
      return {
        players,
        threshold,
        log: [],
        phase: { kind: "hide", forId: startId, next: "initiator", isFirst: true },
      };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------

function CreatureTile(props: {
  creature: Creature;
  small?: boolean;
  selected?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  badge?: number;
  bubble?: boolean;
}) {
  const { creature, small, selected, onClick, disabled, badge, bubble } = props;
  const cls = [
    "creature-card",
    small ? "creature-card--sm" : "",
    bubble ? "creature-card--bubble" : "",
    onClick ? "creature-card--btn" : "",
    selected ? "creature-card--selected" : "",
    disabled ? "creature-card--empty" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const Tag: any = onClick ? "button" : "div";
  return (
    <Tag className={cls} onClick={onClick} disabled={disabled} type={onClick ? "button" : undefined}>
      {badge && badge > 1 ? <span className="group-badge">×{badge}</span> : null}
      <span className="creature-card__emoji">{creature.emoji}</span>
      <span className="creature-card__label">{creature.name}</span>
    </Tag>
  );
}

function StatusStrip(props: { state: GameState; onMenuClick: () => void }) {
  const { state } = props;
  const { phase, players } = state;

  let turnId: number | null = null;
  let turnLabel = "";
  let chain: number[] = [];
  let pendingId: number | null = null;

  if (phase.kind === "hide") {
    turnId = phase.forId;
    turnLabel = phase.next === "initiator" ? "手番待ち" : "受け取り待ち";
    if (phase.pendingActive) {
      chain = phase.pendingActive.chain;
      pendingId = phase.forId;
    }
  } else if (phase.kind === "initiator") {
    turnId = phase.playerId;
    turnLabel = "宣言してカードを渡す番";
  } else if (phase.kind === "recipient" || phase.kind === "believeChoice") {
    turnId = phase.active.toId;
    turnLabel = "判定 or 転送の番";
    chain = phase.active.chain;
    pendingId = phase.active.toId;
  } else if (phase.kind === "passAlong") {
    turnId = phase.active.toId;
    turnLabel = "転送先を選ぶ番";
    chain = phase.active.chain;
    pendingId = phase.active.toId;
  } else if (phase.kind === "reveal") {
    turnId = phase.result.active.toId;
    turnLabel = "開示結果を確認中";
  }

  if (phase.kind === "setup" || phase.kind === "gameOver") return null;

  return (
    <div className="status-strip">
      <div className="status-strip__turn-row">
        <div className="status-strip__turn">
          現在: <b>{turnId !== null ? playerName(players, turnId) : "-"}</b> — {turnLabel}
        </div>
        <button className="menu-btn" onClick={props.onMenuClick}>
          🏠 メニュー
        </button>
      </div>
      {chain.length > 0 && (
        <div className="status-strip__chain">
          {chain.map((id, i) => (
            <React.Fragment key={id}>
              {i > 0 && <span className="chain-arrow">→</span>}
              <span className="chain-node">{playerName(players, id)}</span>
            </React.Fragment>
          ))}
          {pendingId !== null && (
            <>
              <span className="chain-arrow">→</span>
              <span className="chain-node chain-node--pending">{playerName(players, pendingId)}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CollectedPanel(props: { state: GameState }) {
  const { state } = props;
  const [activeId, setActiveId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);

  if (state.phase.kind === "setup" || state.players.length === 0) return null;

  const player = state.players.find((p) => p.id === activeId) ?? state.players[0];

  function tapTab(id: number) {
    if (expanded && activeId === id) {
      setExpanded(false);
    } else {
      setActiveId(id);
      setExpanded(true);
    }
  }

  return (
    <div className="collected-panel">
      <div className="player-tabs">
        {state.players.map((p) => (
          <button
            key={p.id}
            className={`player-tab ${expanded && p.id === player.id ? "player-tab--active" : ""}`}
            onClick={() => tapTab(p.id)}
          >
            {p.name}
          </button>
        ))}
      </div>
      {expanded && (
        <div className="collected-panel__detail">
          <div className="collected-panel__detail-head">
            <span className="collected-panel__detail-name">{player.name} の手札状況</span>
            <button className="collected-panel__close" onClick={() => setExpanded(false)}>
              ▲ しまう
            </button>
          </div>
          <div className="collected-grid">
            {CREATURES.map((c) => {
              const n = player.pile[c.id];
              const reach = n === state.threshold - 1;
              return (
                <div key={c.id} className={`collected-cell ${reach ? "collected-cell--reach" : ""}`}>
                  <span className="collected-cell__emoji">{c.emoji}</span>
                  <span className="collected-cell__count">{n}</span>
                  {reach && <span className="collected-cell__tag">リーチ</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// Screens
// ---------------------------------------------------------------

interface RulesPage {
  eyebrow: string;
  heading: string;
  diagram: any;
  bullets: string[];
}

function RulesFlow(props: { onClose: () => void }) {
  const [page, setPage] = useState(0);

  const pages: RulesPage[] = [
    {
      eyebrow: "STEP 1",
      heading: "宣言してカードを渡す",
      diagram: (
        <div className="vs-diagram">
          <div className="vs-diagram__person">🧑</div>
          <div className="vs-diagram__bubble">「これは○○だ」</div>
          <div className="vs-diagram__arrow">→</div>
          <div className="vs-diagram__person">🧑</div>
        </div>
      ),
      bullets: ["手札から1種類選び、正体を宣言してとなりの人へ渡す", "宣言は本当でもウソでもOK"],
    },
    {
      eyebrow: "STEP 2",
      heading: "ホント？ウソ？を判定",
      diagram: (
        <div className="vs-diagram">
          <div className="vs-diagram__person">🧑</div>
          <div className="vs-diagram__arrow">🔎</div>
          <div className="vs-diagram__result">
            <span>ホント！</span>
            <span>ウソ！</span>
          </div>
        </div>
      ),
      bullets: ["受け取った人が中身を確認し「ホント！」か「ウソ！」を判定", "的中なら宣言した人、ハズレなら受け取った人がカードを引き取る"],
    },
    {
      eyebrow: "STEP 3",
      heading: "2人プレイの場合",
      diagram: (
        <div className="vs-diagram">
          <div className="vs-diagram__person">🧑</div>
          <div className="vs-diagram__vs">VS</div>
          <div className="vs-diagram__person">🧑</div>
        </div>
      ),
      bullets: ["開始時にカードを10枚、見ずに除外してから配る", "相手は1人だけなので「回す」は使わず、判定するのみ", "同じ幽霊を5枚集めてしまったら負け"],
    },
    {
      eyebrow: "STEP 4",
      heading: "3〜6人プレイの場合",
      diagram: (
        <div className="vs-diagram">
          <div className="vs-diagram__person">🧑</div>
          <div className="vs-diagram__arrow">→</div>
          <div className="vs-diagram__person">🧑</div>
          <div className="vs-diagram__arrow">→</div>
          <div className="vs-diagram__person">🧑</div>
        </div>
      ),
      bullets: [
        "受け取った側は「判定する」か「確認せず新しい宣言をつけて別の人へ回す」を選べる",
        "全員に回りきったら、最後に受け取った人が強制的に判定する",
        "同じ幽霊を4枚集めてしまったら負け",
      ],
    },
  ];

  const p = pages[page];
  const isLast = page === pages.length - 1;

  return (
    <div className="main-stage">
      <div className="doc-card">
        <button className="btn-back" onClick={props.onClose}>
          ← タイトルに戻る
        </button>
        <div className="doc-eyebrow">{p.eyebrow} / {pages.length}</div>
        <h2 className="doc-heading">{p.heading}</h2>

        {p.diagram}

        <div className="rules-box">
          <ul>
            {p.bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>

        <div className="rules-dots">
          {pages.map((_, i) => (
            <span key={i} className={`rules-dot ${i === page ? "rules-dot--active" : ""}`} />
          ))}
        </div>

        <div className="btn-row" style={{ flexDirection: "row" }}>
          <button className="btn btn--ghost btn--block" disabled={page === 0} onClick={() => setPage((n) => n - 1)}>
            戻る
          </button>
          <button
            className="btn btn--primary btn--block"
            onClick={() => (isLast ? props.onClose() : setPage((n) => n + 1))}
          >
            {isLast ? "タイトルに戻る" : "次へ"}
          </button>
        </div>
      </div>
    </div>
  );
}

type SetupStep = "title" | "rules" | "count" | "names";

function SetupFlow(props: { onStart: (names: string[]) => void }) {
  const [step, setStep] = useState<SetupStep>("title");
  const [count, setCount] = useState(4);
  const [names, setNames] = useState<string[]>(["", "", "", ""]);

  function setCountClamped(n: number) {
    const c = Math.max(2, Math.min(6, n));
    setCount(c);
    setNames((prev) => {
      const next = prev.slice(0, c);
      while (next.length < c) next.push("");
      return next;
    });
  }

  function updateName(i: number, v: string) {
    setNames((prev) => {
      const next = prev.slice();
      next[i] = v;
      return next;
    });
  }

  function handleStart() {
    const finalNames = names.map((n, i) => (n.trim() ? n.trim() : `プレイヤー${i + 1}`));
    props.onStart(finalNames);
  }

  if (step === "title") {
    return (
      <div className="main-stage">
        <div className="title-screen">
          <div className="title-screen__ghosts">👻 🎃 💀</div>
          <div className="title-screen__logo">G Poker</div>
          <div className="title-screen__menu">
            <button className="btn btn--primary btn--block" onClick={() => setStep("count")}>
              はじめる
            </button>
            <button className="btn btn--ghost btn--block" onClick={() => setStep("rules")}>
              遊び方
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === "rules") {
    return <RulesFlow onClose={() => setStep("title")} />;
  }

  if (step === "count") {
    return (
      <div className="main-stage">
        <div className="doc-card">
          <button className="btn-back" onClick={() => setStep("title")}>
            ← タイトルに戻る
          </button>
          <h2 className="doc-heading">人数を決める</h2>
          <div className="doc-eyebrow">プレイヤー人数（2〜6人）</div>
          <div className="stepper">
            <button className="btn stepper__btn" onClick={() => setCountClamped(count - 1)} disabled={count <= 2} aria-label="人数を減らす">
              −
            </button>
            <span className="stepper__value">{count}</span>
            <button className="btn stepper__btn" onClick={() => setCountClamped(count + 1)} disabled={count >= 6} aria-label="人数を増やす">
              ＋
            </button>
          </div>
          {count === 2 && (
            <div className="rules-box">2人プレイ特別ルール: 10枚を見ずに除外／決着は同種5枚／「回す」は使いません。</div>
          )}
          <button className="btn btn--primary btn--block" onClick={() => setStep("names")}>
            次へ（名前を入力）
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="main-stage">
      <div className="doc-card">
        <button className="btn-back" onClick={() => setStep("count")}>
          ← 人数選びに戻る
        </button>
        <h2 className="doc-heading">名前を入力</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {names.map((n, i) => (
            <div className="name-field" key={i}>
              <span className="name-field__badge">#{i + 1}</span>
              <input
                type="text"
                aria-label={`プレイヤー${i + 1}の名前`}
                placeholder={`プレイヤー${i + 1}`}
                value={n}
                maxLength={12}
                onChange={(e: any) => updateName(i, e.target.value)}
              />
            </div>
          ))}
        </div>
        <button className="btn btn--primary btn--block" onClick={handleStart}>
          ゲームスタート
        </button>
      </div>
    </div>
  );
}

function HideScreen(props: { state: GameState; onConfirm: () => void }) {
  const phase = props.state.phase;
  if (phase.kind !== "hide") return null;
  const name = playerName(props.state.players, phase.forId);
  const message =
    phase.isFirst
      ? "カードが配られました。最初のプレイヤーに画面を渡してください。"
      : phase.next === "initiator"
      ? "新しいカードを回す番です。画面を渡してください。"
      : "カードが届いています。画面を渡してください。";

  return (
    <div className="main-stage">
      <div className="hide-screen">
        <div className="hide-screen__card">
          <div>
            <div className="doc-eyebrow">画面を渡す</div>
            <div className="hide-screen__name">{name} さん</div>
          </div>
          <div className="hide-screen__hint">{message}<br />他の人に画面が見えないようにしてから進んでください。</div>
          <button className="btn btn--primary btn--block" onClick={props.onConfirm}>
            自分は{name}です。確認する
          </button>
        </div>
      </div>
    </div>
  );
}

function InitiatorScreen(props: { state: GameState; playerId: number; dispatch: (a: Action) => void }) {
  const player = props.state.players.find((p) => p.id === props.playerId)!;
  const others = props.state.players.filter((p) => p.id !== props.playerId);
  const soleTarget = others.length === 1 ? others[0] : null;
  const [step, setStep] = useState<"pick" | "confirm">("pick");
  const [selectedType, setSelectedType] = useState<CreatureId | null>(null);
  const [claim, setClaim] = useState<CreatureId | null>(null);
  const [targetId, setTargetId] = useState<number | null>(soleTarget ? soleTarget.id : null);

  const groups = CREATURES.map((c) => ({
    type: c.id,
    cards: player.hand.filter((h) => h.type === c.id),
  })).filter((g) => g.cards.length > 0);

  const canSubmit = selectedType !== null && claim !== null && targetId !== null;

  function handleSubmit() {
    const group = groups.find((g) => g.type === selectedType);
    if (!group) return;
    props.dispatch({ type: "INITIATE", cardId: group.cards[0].id, claim: claim as CreatureId, targetId: targetId as number });
  }

  if (step === "confirm" && claim !== null && targetId !== null) {
    const claimC = CREATURE_MAP[claim];
    const targetName = playerName(props.state.players, targetId);
    return (
      <div className="main-stage">
        <div className="doc-card">
          <button className="btn-back" onClick={() => setStep("pick")}>
            ← 戻る
          </button>
          <div className="doc-eyebrow">最終確認</div>
          <h2 className="doc-heading">この内容で渡します</h2>

          <div className="claim-slip">
            <div className="claim-slip__emoji">{claimC.emoji}</div>
            <div>
              <div className="claim-slip__from">{targetName} さんへ</div>
              <div className="claim-slip__text">「これは {claimC.name} だ」</div>
            </div>
          </div>

          <p className="doc-body">
            <b>{targetName}さんに「これは{claimC.name}だ」と声に出して宣言</b>してから、カードを渡してください。
          </p>

          <button className="btn btn--primary btn--block" onClick={handleSubmit}>
            カード宣言完了
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="main-stage">
      <div className="doc-card">
        <div className="doc-eyebrow">{player.name} の手札（{player.hand.length}枚）</div>
        <h2 className="doc-heading">どのカードを渡す？</h2>

        <div className="hand-scroller">
          {groups.map((g) => (
            <CreatureTile
              key={g.type}
              creature={CREATURE_MAP[g.type]}
              selected={selectedType === g.type}
              onClick={() => setSelectedType(g.type)}
              badge={g.cards.length}
            />
          ))}
        </div>

        <div>
          <h2 className="doc-heading">何だと宣言する？</h2>
          <div className="doc-eyebrow" style={{ marginBottom: "0.5rem" }}>本当でもウソでもOK</div>
          <div className="creature-grid">
            {CREATURES.map((c) => (
              <CreatureTile key={c.id} creature={c} bubble selected={claim === c.id} onClick={() => setClaim(c.id)} />
            ))}
          </div>
        </div>

        {soleTarget ? (
          <div>
            <h2 className="doc-heading">誰に渡す？</h2>
            <div className="doc-eyebrow">
              <b style={{ color: "var(--ink)" }}>{soleTarget.name}</b>（対戦相手は1人のため自動選択）
            </div>
          </div>
        ) : (
          <div>
            <h2 className="doc-heading" style={{ marginBottom: "0.5rem" }}>誰に渡す？</h2>
            <div className="chip-row">
              {others.map((p) => (
                <button
                  key={p.id}
                  className={`chip ${targetId === p.id ? "chip--selected" : ""}`}
                  onClick={() => setTargetId(p.id)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <button className="btn btn--primary btn--block" disabled={!canSubmit} onClick={() => setStep("confirm")}>
          この内容で渡す
        </button>
      </div>
    </div>
  );
}

function RecipientScreen(props: { state: GameState; active: ActiveCard; dispatch: (a: Action) => void }) {
  const { active, state } = props;
  const claimC = CREATURE_MAP[active.claim];
  const fromName = playerName(state.players, active.fromId);
  const eligibleTargets = state.players.filter((p) => p.id !== active.toId && !active.chain.includes(p.id));
  const canPassAlong = eligibleTargets.length > 0;

  return (
    <div className="main-stage">
      <div className="doc-card">
        <div className="doc-eyebrow">届いたカード</div>
        <h2 className="doc-heading">{playerName(state.players, active.toId)} 宛て</h2>

        <div className="claim-slip">
          <div className="claim-slip__emoji">{claimC.emoji}</div>
          <div>
            <div className="claim-slip__from">{fromName} より申告</div>
            <div className="claim-slip__text">「これは {claimC.name} だ」</div>
          </div>
        </div>

        <p className="doc-body">
          {canPassAlong
            ? "中身を確認して判定するか、確認せずに新しい申告をつけて別のプレイヤーへ回すか選んでください。"
            : "これ以上回せる相手がいません。中身を確認して判定してください。"}
        </p>

        <div className="btn-row">
          <button className="btn btn--primary btn--block" onClick={() => props.dispatch({ type: "CHOOSE_JUDGE" })}>
            🔍 中身を確認して判定する
          </button>
          {canPassAlong && (
            <button className="btn btn--ghost btn--block" onClick={() => props.dispatch({ type: "CHOOSE_PASS_ALONG" })}>
              🙈 確認せず他のプレイヤーへ回す
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PassAlongScreen(props: { state: GameState; active: ActiveCard; dispatch: (a: Action) => void }) {
  const { active, state } = props;
  const eligibleTargets = state.players.filter((p) => p.id !== active.toId && !active.chain.includes(p.id));
  const [step, setStep] = useState<"pick" | "confirm">("pick");
  const [claim, setClaim] = useState<CreatureId | null>(null);
  const [targetId, setTargetId] = useState<number | null>(null);
  const canSubmit = claim !== null && targetId !== null;

  function handleSubmit() {
    props.dispatch({ type: "SUBMIT_PASS_ALONG", claim: claim as CreatureId, targetId: targetId as number });
  }

  if (step === "confirm" && claim !== null && targetId !== null) {
    const claimC = CREATURE_MAP[claim];
    const targetName = playerName(state.players, targetId);
    return (
      <div className="main-stage">
        <div className="doc-card">
          <button className="btn-back" onClick={() => setStep("pick")}>
            ← 戻る
          </button>
          <div className="doc-eyebrow">最終確認</div>
          <h2 className="doc-heading">この内容で回します</h2>

          <div className="claim-slip">
            <div className="claim-slip__emoji">{claimC.emoji}</div>
            <div>
              <div className="claim-slip__from">{targetName} さんへ</div>
              <div className="claim-slip__text">「これは {claimC.name} だ」</div>
            </div>
          </div>

          <p className="doc-body">
            <b>{targetName}さんに「これは{claimC.name}だ」と声に出して宣言</b>してから、カードを回してください。
          </p>

          <button className="btn btn--primary btn--block" onClick={handleSubmit}>
            カード宣言完了
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="main-stage">
      <div className="doc-card">
        <button className="btn-back" onClick={() => props.dispatch({ type: "BACK_TO_RECIPIENT" })}>
          ← 戻る
        </button>
        <div className="doc-eyebrow">{playerName(state.players, active.toId)} — 未確認のまま転送</div>
        <h2 className="doc-heading">新しい申告をつける</h2>
        <p className="doc-body">中身は見ていません。好きな申告をつけて次のプレイヤーへ回せます。</p>

        <div>
          <h2 className="doc-heading">何だと申告する？</h2>
          <div className="creature-grid">
            {CREATURES.map((c) => (
              <CreatureTile key={c.id} creature={c} bubble selected={claim === c.id} onClick={() => setClaim(c.id)} />
            ))}
          </div>
        </div>

        <div>
          <h2 className="doc-heading" style={{ marginBottom: "0.5rem" }}>誰に回す？</h2>
          <div className="chip-row">
            {eligibleTargets.map((p) => (
              <button
                key={p.id}
                className={`chip ${targetId === p.id ? "chip--selected" : ""}`}
                onClick={() => setTargetId(p.id)}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>

        <button className="btn btn--primary btn--block" disabled={!canSubmit} onClick={() => setStep("confirm")}>
          回す
        </button>
      </div>
    </div>
  );
}

function JudgeScreen(props: { state: GameState; active: ActiveCard; result?: ResultInfo; dispatch: (a: Action) => void }) {
  const { active, state, result } = props;
  const claimC = CREATURE_MAP[active.claim];
  const trueC = CREATURE_MAP[active.card.type];
  const fromName = playerName(state.players, active.fromId);
  const toName = playerName(state.players, active.toId);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (!result) {
      setRevealed(false);
      return;
    }
    const t = setTimeout(() => setRevealed(true), 150);
    return () => clearTimeout(t);
  }, [result]);

  return (
    <div className="main-stage">
      <div className="doc-card">
        {!result && (
          <button className="btn-back" onClick={() => props.dispatch({ type: "BACK_TO_RECIPIENT" })}>
            ← 戻る
          </button>
        )}
        <div className="doc-eyebrow">{result ? "開示結果" : "最終判定"}</div>
        <h2 className="doc-heading">{result ? "結果報告" : "ホント？ウソ？"}</h2>

        <div className="claim-slip">
          <div className="claim-slip__emoji">{claimC.emoji}</div>
          <div>
            <div className="claim-slip__from">{fromName} → {toName}</div>
            <div className="claim-slip__text">「これは {claimC.name} だ」</div>
          </div>
        </div>

        {!result && (
          <>
            <p className="doc-body">正しく見抜けば申告した側、見抜けなければ受け取った側がカードを引き取ります。</p>
            <div className="btn-row">
              <button className="btn btn--safe btn--block" onClick={() => props.dispatch({ type: "BELIEVE", believe: true })}>
                ホント！
              </button>
              <button className="btn btn--danger btn--block" onClick={() => props.dispatch({ type: "BELIEVE", believe: false })}>
                ウソ！
              </button>
            </div>
          </>
        )}

        {result && (
          <div className="reveal-stage">
            <div className="flip-scene">
              <div className={`flip-card ${revealed ? "flip-card--revealed" : ""}`}>
                <div className="flip-face flip-face--back">
                  <span>🔮</span>
                </div>
                <div className="flip-face flip-face--front">
                  <span className="creature-card__emoji">{trueC.emoji}</span>
                  <span className="creature-card__label">{trueC.name}</span>
                </div>
              </div>
            </div>

            {revealed && (
              <>
                <div className={`verdict ${result.judgmentHit ? "verdict--correct" : "verdict--wrong"}`}>
                  {toName}の判定は{result.judgmentHit ? "的中！" : "ハズレ！"}
                </div>
                <div className="verdict-detail">
                  <b>{playerName(state.players, result.takerId)}</b> がこのカードを引き取ります
                </div>
              </>
            )}

            <button
              className="btn btn--primary btn--block"
              disabled={!revealed}
              onClick={() => props.dispatch({ type: "CONTINUE_AFTER_REVEAL" })}
            >
              次へ
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function GameOverScreen(props: {
  state: GameState;
  winners: number[];
  losers: number[];
  triggerPlayerId: number | null;
  triggerType: CreatureId | null;
  nextStartId: number;
  dispatch: (a: Action) => void;
}) {
  const { state, winners, triggerPlayerId, triggerType, nextStartId, dispatch } = props;
  const loserName = triggerPlayerId !== null ? playerName(state.players, triggerPlayerId) : null;
  const loserCreature = triggerType !== null ? CREATURE_MAP[triggerType].name : null;

  return (
    <div className="main-stage">
      <div className="doc-card">
        <div className="doc-eyebrow">ゲーム終了</div>
        <h2 className="doc-heading">結果発表</h2>
        {loserName && loserCreature ? (
          <p className="doc-body">
            <b>{loserName}</b>さんの手元に<b>{loserCreature}</b>が{state.threshold}枚揃いました。<b>{loserName}</b>さんの負けです。
          </p>
        ) : (
          <p className="doc-body">配るカードがなくなったため、ここで終了です。全員が勝者です。</p>
        )}

        <div className="result-list">
          {state.players.map((p) => {
            const isWin = winners.includes(p.id);
            return (
              <div key={p.id} className={`result-row ${isWin ? "result-row--win" : "result-row--lose"}`}>
                <span className="result-row__name">{p.name}</span>
                <span className="result-row__stamp">{isWin ? "勝者" : "アウト"}</span>
              </div>
            );
          })}
        </div>

        <TallyTable state={state} />

        <div className="btn-row">
          <button className="btn btn--primary btn--block" onClick={() => dispatch({ type: "REPLAY", startPlayerId: nextStartId })}>
            もう一度プレイ
          </button>
          <button className="btn btn--ghost btn--block" onClick={() => dispatch({ type: "RESTART" })}>
            メニューに戻る
          </button>
        </div>
      </div>
    </div>
  );
}

function TallyTable(props: { state: GameState }) {
  const { state } = props;
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="tally-table">
        <thead>
          <tr>
            <th>プレイヤー</th>
            {CREATURES.map((c) => (
              <th key={c.id} title={c.name}>
                {c.emoji}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {state.players.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              {CREATURES.map((c) => {
                const n = p.pile[c.id];
                const cls = n >= state.threshold ? "tally-cell--out" : n === state.threshold - 1 ? "tally-cell--warn" : "";
                return (
                  <td key={c.id} className={cls}>
                    {n}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// AdSense bottom banner. Uses a placeholder publisher/slot ID and Google's
// official data-adtest="on" dev mode — swap in real IDs and drop
// data-adtest before going live. The adsbygoogle script can't load inside
// the sandboxed Artifact preview, so the fallback label stays visible
// there; on a self-hosted page a filled ad renders on top of it.
function AdBanner() {
  useEffect(() => {
    try {
      ((window as any).adsbygoogle = (window as any).adsbygoogle || []).push({});
    } catch (e) {
      // adsbygoogle.js didn't load (sandboxed preview, blocker, offline) — fine, fallback stays visible.
    }
  }, []);

  return (
    <div className="ad-slot">
      <div className="ad-slot__fallback">Ad</div>
      <ins
        className="adsbygoogle"
        style={{ display: "block", width: "100%", height: "100%" }}
        data-ad-client="ca-pub-0000000000000000"
        data-ad-slot="0000000000"
        data-ad-format="horizontal"
        data-full-width-responsive="true"
        data-adtest="on"
      />
    </div>
  );
}

// ---------------------------------------------------------------
// App root
// ---------------------------------------------------------------

function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [confirmMenu, setConfirmMenu] = useState(false);
  const phase = state.phase;

  let body: any = null;
  if (phase.kind === "setup") {
    body = <SetupFlow onStart={(names) => dispatch({ type: "START", names })} />;
  } else if (phase.kind === "hide") {
    body = <HideScreen state={state} onConfirm={() => dispatch({ type: "CONFIRM_HIDE" })} />;
  } else if (phase.kind === "initiator") {
    body = <InitiatorScreen state={state} playerId={phase.playerId} dispatch={dispatch} />;
  } else if (phase.kind === "recipient") {
    body = <RecipientScreen state={state} active={phase.active} dispatch={dispatch} />;
  } else if (phase.kind === "passAlong") {
    body = <PassAlongScreen state={state} active={phase.active} dispatch={dispatch} />;
  } else if (phase.kind === "believeChoice" || phase.kind === "reveal") {
    const active = phase.kind === "believeChoice" ? phase.active : phase.result.active;
    const result = phase.kind === "reveal" ? phase.result : undefined;
    body = <JudgeScreen state={state} active={active} result={result} dispatch={dispatch} />;
  } else if (phase.kind === "gameOver") {
    body = (
      <GameOverScreen
        state={state}
        winners={phase.winners}
        losers={phase.losers}
        triggerPlayerId={phase.triggerPlayerId}
        triggerType={phase.triggerType}
        nextStartId={phase.nextStartId}
        dispatch={dispatch}
      />
    );
  }

  return (
    <div className="app-shell">
      <div className="tape-strip" />
      <CollectedPanel state={state} />
      <StatusStrip state={state} onMenuClick={() => setConfirmMenu(true)} />
      {body}
      <AdBanner />

      {confirmMenu && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-box">
            <div className="doc-eyebrow">確認</div>
            <h2 className="doc-heading">メニューに戻りますか？</h2>
            <p className="doc-body">進行中のゲームは失われます。</p>
            <div className="btn-row">
              <button
                className="btn btn--danger btn--block"
                onClick={() => {
                  setConfirmMenu(false);
                  dispatch({ type: "RESTART" });
                }}
              >
                はい、メニューに戻る
              </button>
              <button className="btn btn--ghost btn--block" onClick={() => setConfirmMenu(false)}>
                いいえ、続ける
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
