# DESIGN §28, §29 — The co-op team economy and the 协同共竞 mode

Part of [DESIGN.md](../DESIGN.md) (the index; section numbers are global).

## 28. 协同经济 — the co-op team economy

A default-off rule set (`config.economy.team`, or a mode's own `teamEconomy` block) for co-op matches — never solo.
`GameData.teamEconomy` returns null while it is off and every entry point checks it, so the layer is inert and every
protocol addition optional. Its state lives on the Match (`server/match/match/economy.js`, a method module like the other
`match/*` ones): `teamReserve`, `econRequests`, `econRound`, `econDebts`, `econCover*`, `econRelief*`, `teamProjects` —
personal funds stay on PlayerState.

- **Capability probe**: `m.public.econ` exists only while the rule set is on (the client's capability probe: nothing is
  rendered or sent without it). Shipped starting values, all overridable: `transfer { maxPerRequest: 5,
  requestsPerRound: 1, teamCapPerRound: 8, ttlSec: 30, repayInterest: 0 }`, `reserve { convertPerPlayerMax: 2,
  perfectReward: 1, perfectRewardCapPerRound: 2 }`, `relief { enabled: false, amount: 1, lpThreshold: 10,
  perPlayerPerRound: 2, teamPerRound: 4 }`, projects 联合采购 / 应急仓储 / 后勤调度 at `costs: [4, 8, 12]`
  (`logistics` also `teamCapBonus: [4, 8, 12]` and `extraRequestsAtL3: 1`). **A mode ships exactly the projects its
  `projects` block names** — 协同共竞 lists 应急仓储 and 后勤调度, so 联合采购 is not sold or advertised there (§29).
- **The team reserve** (`Match.econConvertLeftover`, at the prep end before `PlayerState.endPrep`): each alive player
  converts `min(funds − keep, convertPerPlayerMax)` into it — `keep` is 应急仓储's level (`teamKeepFor`); a 坎诺特 band
  skips the conversion (its leftover is kept whole). A 全员无伤 round pays `perfectReward` into it
  (`econPerfectReward`, capped per round). The reserve buys the projects (`g.econ.project`), which grant the team's free
  refreshes (联合采购, at the round start), the keep (应急仓储) and the transfer cap / extra requests (后勤调度) — and
  it funds 救济 below. Note that 应急仓储 and the conversion draw on the same leftovers: a team that keeps more of them
  converts less, which is the intended trade-off between a personal buffer and the team pot.
- **全员无伤 — the perfect reward is a team achievement** (user decision 2026-10-09): `settle()` grants it once per
  settlement, and only when **every alive player was charged nothing that round** — the 「全员无伤」 line the official
  result box already reports, not one field's own perfect. It is judged on the settlement's own `loss` (so a 联防 round
  counts a leaker's enemies against whoever ends up holding them), and a player eliminated by that very round is still
  in the judged set, so its loss blocks the reward.
- **救济 — the weakest teammate draws on the reserve** (user decision 2026-10-09): `g.econ.relief` (no arguments) takes
  `relief.amount` (one fund at a time) out of the reserve and gives it to the **asking player itself** — 「血最少的人
  自己选择取还是不取」. It is a grant, not a loan: nothing is owed back. The gate is strict and server-side, so a healthy
  team has nobody eligible: the player must be alive, in PREP, not ready, **at or below `relief.lpThreshold`** (default
  10 = `lpCapPerRound`, i.e. one worst-case round from elimination) and **(tied for) the team's lowest LP**. Caps:
  `relief.perPlayerPerRound` per player and `relief.teamPerRound` for the team, both re-armed every round; the reserve
  must cover the draw. `m.private.econ.relief` carries `eligible`/`left` to the client, `m.public.econ.relief` the
  public `amount`/`threshold`/`left`.
- **Transfer requests (PREP only)**: `g.econ.request { to, amount }`, `g.econ.respond { id, approve }`. One in-flight
  request per player in either role, one request per player per round, team total ≤ `teamCapPerRound`, 30 s TTL; the
  answer, the TTL, the prep end, a leave or an elimination closes them — **a request cannot be withdrawn** (user
  decision 2026-10-08, `g.econ.cancel` retired before it ever shipped). Both sides obey the
  gate (alive, PREP, not ready): a ready player's outgoing request is withdrawn, and a **ready target is refused** (it
  could not answer, so the ask would only burn the asker's budget). A bot seat answers on the spot.
- **被拒后可换人再借** (user decision 2026-10-08): a refusal — an explicit 拒绝 or an expired TTL — **gives the asker's
  budget back** (`econRound.byPlayer` is decremented) and remembers the refuser (`econDeniedBy`) for the rest of the
  round, so the asker may turn to another teammate but cannot re-ask the same one. A bot asker does this on its own
  clock (300–800 ms after the refusal). Both memories are **per round**: `econNewRound` (called from `startRound`)
  clears `byPlayer`, `spent`, `perfectGranted` and `econDeniedBy`, so every round starts with a full budget and a full
  team total — the counters used to run for the whole match, which is what made round 2 look like it had one ask left
  (user report 2026-10-08).
- **方案 B — the loan is repaid out of the next income** (user decision 2026-10-07/08): an approved transfer leaves the
  borrower owing `amount + transfer.repayInterest` at its next income (`econSettleDebts`, right after
  `PlayerState.startRound` granted it). Funds still clear every round; only the debt rides on income, and the round's
  budget is capped by that very income — `econRequestsPerRound(ps) = min(requestsPerRound, gd.income(round + 1))` — so
  the debt is solvent by construction and the settlement never has to forgive. `m.private.econ.owe/.due` carry the
  ledger to the client (the plate shows 欠 N / 应收 N).
- **兜底利息 — the PvE interest** (`coverInterest`, default off): holding teammates' leaked enemies in 联防 earns
  interest on a repaid loan. `econCoverTally` counts what the 联防 field attributed to each helper (the field's players
  are the helpers; both the server-run and the client-combat unite paths tally). The rate is
  `min(capPct, floor(100 × 兜底 kills / the match's planned enemy total))` percent of the repaid principal, accrued
  fractionally per lender and paid in **whole funds** only (the remainder waits for the next loan, so coins stay
  integers). Calibrated 2026-10-07 for 标准: 251 planned enemies, rounds 1–9 spawn 125 (≈49%), so a 100% rate is
  impossible before round 10 by construction (a test guards the wave tables).
- **阵亡分红** (`deathDividend`, default off): a fallen teammate's would-be next income (`gd.income(round + 1)` plus its
  withheld `pendingFunds`) is diced out to the survivors — each rolls `1..dice` on the match's own `rngEcon` stream, the
  shares follow the rolls (`floor(pool × roll / Σrolls)`), the remainder goes to the highest roll and the total never
  exceeds that income — and its outstanding debts are void (the lender is told).
- **借款意愿 — the bot lender's roll** (`botLend`, default off): instead of the flat "can spare it" rule, a bot answers
  on a seeded roll of `rngEcon` after a 0.6–2.2 s "thought about it" pause (`econRequest` schedules it and stamps
  `req.decideAt`, which also holds the bot's ordinary prep slices off the answer). The chance is
  `basePct + weakPct · weak + solventPct · solvent + coverPct · cover`, capped at `maxPct`:
  - `weak` — how far the borrower's board trails the team's median (`econBorrowerBehind`, 0..1: half the median or less
    is 1); the under-developed teammate this mode carries;
  - `solvent` — 1 when the borrower looks able to repay (units on the board and LP at or above the team's median): the
    debt itself is always affordable by construction, so death is the only way to default;
  - `cover` — the lender's own 兜底 rate: the teammate who holds the leaks is the one who pays it forward.
  `tightFactorPct` (50) scales the chance down when the loan would eat the bot's own shopping money. Shipped for
  协同共竞: `{ 10, 20, 10, 10, max 50 }` — 10% for a plain ask, up to 50% for a fully-covered lender carrying a wiped
  board. Off by default, so every other mode keeps the flat rule (`botLend.enabled false → econBotLendChance 0`).
- **兜底率分红 — the risk premium** (`coverInterest.lagPremium`, default 1 = off): a debt whose borrower trailed the
  team's median **when the loan was made** (`lag`, a snapshot on the debt record, not a live test) earns `lagPremium ×`
  the normal 兜底 interest on repayment (`econCoverPayout(lender, pay, lagPremium)`, still capped at the principal).
  This is the answer to "why would the strong player lend to the under-developed one": the risk is priced, not shared —
  a lender at a 25% 兜底 rate breaks even on a lagging loan above a ~33% death rate instead of ~17%, and the premium is
  minted by the PvE 兜底 reward, so it costs the borrower nothing.
- **AI 主动借钱 — the bot borrower's roll** (`botAsk`, default off): a bot teammate also *asks*, on a seeded roll — to
  an AI teammate or a human, alike. Two branches, each rolled **at most once per round** (`_econAskRolled` /
  `_econKeyRolled` on the seat, both stamped with the round):
  - ordinary — `min(maxPct, basePct + brokePct · broke)`: `broke` is the old trigger (≤ 2 funds and nothing affordable
    in the shop), so the base ask is 8% and a broke seat 48%, never above `maxPct` (50);
  - 关键节点 — `min(keyMaxPct, basePct + keyPct)`: 68% at a 调度中心 level-up the bot wants but cannot fund (the very
    `wantsLevelUp` rule its prep uses) or an elite chess in the shop it cannot buy (a golden piece, or the copy that
    completes a merge), never above `keyMaxPct` (80).
  User decision 2026-10-08: "遇到关键节点时随机率最高到 80%，正常游玩时最高 50，达不到没事，49 也可以" — the caps are
  ceilings, the shipped numbers sit under them. The amount asked is what the seat is short of (the 关键节点's gap, else
  `4 − funds`), capped by `maxPerRequest`. The roll is evaluated at the prep start **and** again after the money is spent
  (right after the level-up attempts), because that is where a shortfall actually shows up; a refusal makes the asker
  turn to another teammate on its own clock instead of rolling again.

## 29. 协同共竞 — the co-op mode

A standalone mode built on the untouched standard economy, with the team economy layered on top: its players may borrow
funds from each other during PREP, pool their leftovers into the reserve, draw 救济 when they are about to die, and buy
two logistics projects. The mode ids `mode_xie_funny|normal|hard|abyss` (data/config.json) clone their `mode_multi_*`
counterpart field for field and carry
`teamEconomy { enabled: true, transfer { maxPerRequest: 1, requestsPerRound: 4, teamCapPerRound: 8, ttlSec: 30,
repayInterest: 0 }, reserve { convertPerPlayerMax: 2, perfectReward: 2, perfectRewardCapPerRound: 2 },
relief { enabled: true, amount: 1, lpThreshold: 10, perPlayerPerRound: 2, teamPerRound: 4 },
projects { storehouse { costs: [4, 8, 12] }, logistics { costs: [4, 8, 12], teamCapBonus: [4, 8, 12] } },
deathDividend { enabled: true, dice: 6 }, coverInterest { enabled: true, capPct: 100, lagPremium: 2 }, botLend …, botAsk … }`.
**联合采购 is deliberately not shipped here** (user decision 2026-10-09: 应急仓储 and 后勤调度 only), and the mode is no
longer borrow-only — the reserve, the conversion, the 全员无伤 reward and 救济 are all live in it. Every other mode keeps
`teamEconomy` absent and behaves exactly as before (the existing suites run unchanged).
`requestsPerRound: 4` is the team cap (8) split across the mode's two-player table, so the per-player allowance and the
team total bind together and one seat cannot monopolise the pot. It is deliberately **under** the income floor
(`income(round + 1)` ≥ 5 from round 1 in 标准) — that is what keeps `logistics.extraRequestsAtL3` live: the budget and
the L3 bonus (4 → 5) are both inside what the borrower can repay, so the solvency clamp never swallows the bonus. A
config of 12 (what this mode shipped first) sat above every income the clamp allows, which made L3 a no-op.

- **Entry & lobby**: the title screen's 开始 button gains a right-hand neighbour (协同共竞, `.xie-entry`); it writes
  `lobby.mode=coop` + `lobby.variant=xie` and enters the session. The lobby shows a third mode card; creating a room
  sends `room.create { mode: 'coop', difficulty, variant: 'xie' }` and, this mode being a two-player table for now,
  fills the second seat with an AI teammate. `modeIdFor(roomMode, difficulty, variant)` resolves
  `mode_<variant>_<difficulty>` and the Room carries the variant into `room.state` and its Match.
- **Borrowing numbers**: one fund per request; the per-round budget is `min(requestsPerRound, gd.income(round + 1))` —
  **4** in this mode (5 with 后勤调度 Lv3), since the income floor of 5 never binds; team total ≤ 8 per round (+ 后勤调度),
  30 s TTL.
  Approving moves the funds directly; the answer / the TTL / the prep end / a leave / an elimination close the request.
- **救济 in this mode**: the weakest teammate (tied lowest LP, at or below 10) may take one fund per draw, up to twice a
  round, out of the reserve — four draws for the team per round. It is free: the debt ledger stays the borrow protocol's.
- **The reserve's cheap exit**: with 联合采购 dropped, the reserve's sinks are 应急仓储, 后勤调度 and 救济. A teammate
  revive is **not** implemented by this PR (the user believed one already existed; no player-level revive exists in either
  this repository or the Paper-Yuan fork — only the in-battle operator revives: 阿戈尔's five-tier, M3茧甲, 埃芒加德).
- **UI**: 借钱 is one control in the HUD (public/js/ui/borrowPlate.js, mounted by screens/game.js as `.gm__borrow`, right
  of the 整备区 row on the shop bar's button line): the official `garrisonTypeIcon/icon_gold` 资金 icon with the count and
  a 借钱 caption on a CSS button, clicking it opens the teammate picker beside it — **one teammate per row** (user
  decision 2026-10-08; the column is anchored to the plate and grows upward, so opening it never moves the strip); a
  pending request replaces the plate with a plain 已向 … 请求 … readout on the outgoing side and 同意 / 拒绝 on the
  incoming one (no 撤回 — see above), and 欠 N / 应收 N / 兜底 N% chips show the ledger and the coverage. The lobby
  card's badge is the official `hudPanel/icon_coop` (local extraction first, the mirror copy second, a glyph last).
  救济 sits on the shop bar's 协同经济 strip (public/js/ui/shopBar.js `EconStrip`), next to the reserve it draws on: a
  领取救济 button, enabled only while the server says this player may take (`m.private.econ.relief.eligible`).
- **Tests**: `test/match/coop-economy.test.js` (the framework, the mode's numbers, 救济 and its caps, the debts, the two
  PvE rewards, the two willingness rolls and the 兜底率分红), `test/ui/coop-economy-ui.test.js` (the plate and the strip)
  and the docs-consistency gate (§28/§29 ⇄ `mode_xie_*` ⇄ the shipped numbers).
- **救援 (促融共竞 only)**: a teammate whose LP runs out is **not eliminated on the spot** — the settle phase opens a
  rescue window instead. They are held at 0 LP (`PlayerState.pendingDeath`, their board and shop intact) and the room
  is told; whoever **held the line in this round's 联防** (`plan.helpers`) **and came through their own battle clean**
  (no counted leaks, no synthetic result) may spend `REVIVAL_COST` (10) LP to bring them back with **1 LP** — the donor
  keeps at least 1, so the floor is `REVIVAL_MIN_DONOR_LP` (11). `g.revive { playerId, round }`; the round guards a
  click queued in an earlier window. When the window closes (`afterSettle` → `revivalFinalizeAll`) whoever is still
  held is eliminated through the normal path (board returned, economy closed, death dividend paid) and the reason is
  recorded on the player (`revivalUnavailableReason`: `no-helper`, `donor-lp`, `window-expired`, …) so the UI can say
  why nobody came. The rule is **part of the mode** (`mode.revival.enabled`, GameData.revival), not a room option —
  促融共竞 ships it on, every other mode (and solo) never resolves it. Server: `server/match/match/revival.js`;
  the settle hooks are in `settle.js` (`revivalDefer` / `eliminatePlayer` / `afterSettle`); the window is advertised
  in `m.public.revival` (`{ open, round, cost, minDonorLp, donors, targets }`) and the client renders it with
  `public/js/ui/revivePlate.js`. Tests: `test/match/revival.test.js` (the window, the donor rule, the refusals, the
  close) and `test/ui/revive-ui.test.js` (the plate).
- **邀请码加入**: the mode's own room page (public/js/screens/xieRoom.js) carries a 「02 加入同盟」 panel — a code field
  (normalized to the uppercase `[0-9A-Z]` alphabet), 加入, and the recent-room chips — reusing the lobby's
  `CODE_RE` / `normalizeCode` / `codeArg` / `recentRooms` primitives and the same `room.join { code }` intent, so the
  two entry points cannot drift apart.
