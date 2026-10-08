# 协同经济与协同共竞 (DESIGN §27, §28)

## 27. 协同经济 — the co-op team economy

A default-off rule set (`config.economy.team`, or a mode's own `teamEconomy` block) for co-op matches — never solo.
`GameData.teamEconomy` returns null while it is off and every entry point checks it, so the layer is inert and every
protocol addition optional. Its state lives on the Match (`server/match/match/economy.js`, a method module like the other
`match/*` ones): `teamReserve`, `econRequests`, `econRound`, `econDebts`, `econCover*`, `teamProjects` — personal funds
stay on PlayerState.

- **Capability probe**: `m.public.econ` exists only while the rule set is on (the client's capability probe: nothing is
  rendered or sent without it). Shipped starting values, all overridable: `transfer { maxPerRequest: 5,
  requestsPerRound: 1, teamCapPerRound: 8, ttlSec: 30, repayInterest: 0 }`, `reserve { convertPerPlayerMax: 2,
  perfectReward: 1, perfectRewardCapPerRound: 2 }`, projects 联合采购 / 应急仓储 / 后勤调度 at `costs: [4, 8, 12]`
  (`logistics` also `teamCapBonus: [4, 8, 12]` and `extraRequestsAtL3: 1`).
- **The team reserve** (`Match.econConvertLeftover`, at the prep end before `PlayerState.endPrep`): each alive player
  converts `min(funds − keep, convertPerPlayerMax)` into it — `keep` is 应急仓储's level (`teamKeepFor`); a 坎诺特 band
  skips the conversion (its leftover is kept whole). A perfect round pays `perfectReward` into it (`econPerfectReward`,
  capped per round). The reserve buys the projects (`g.econ.project`), which grant the team's free refreshes (联合采购, at
  the round start), the keep (应急仓储) and the transfer cap / extra requests (后勤调度).
- **Transfer requests (PREP only)**: `g.econ.request { to, amount }`, `g.econ.respond { id, approve }`,
  `g.econ.cancel { id }`. One in-flight request per player in either role, one request per player per round, team total
  ≤ `teamCapPerRound`, 30 s TTL; a deny/cancel, the prep end, a leave or an elimination closes them. Both sides obey the
  gate (alive, PREP, not ready): a ready player's outgoing request is withdrawn, and a **ready target is refused** (it
  could not answer, so the ask would only burn the asker's budget). A bot seat answers on the spot.
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

## 28. 协同共竞 — the co-op borrowing mode

A standalone mode built on the untouched standard economy: its players may borrow funds from each other during PREP and
**nothing else changes** — no reserve, no conversion, no perfect rewards, no projects. The mode ids
`mode_xie_funny|normal|hard|abyss` (data/config.json) clone their `mode_multi_*` counterpart field for field and carry
`teamEconomy { enabled: true, borrowOnly: true, transfer { maxPerRequest: 1, requestsPerRound: 12, teamCapPerRound: 8,
ttlSec: 30, repayInterest: 0 }, deathDividend { enabled: true, dice: 6 }, coverInterest { enabled: true, capPct: 100 } }`.
Every other mode keeps `teamEconomy` absent and behaves exactly as before (the existing suites run unchanged).

- **Entry & lobby**: the title screen's 开始 button gains a right-hand neighbour (协同共竞, `.xie-entry`); it writes
  `lobby.mode=coop` + `lobby.variant=xie` and enters the session. The lobby shows a third mode card; creating a room
  sends `room.create { mode: 'coop', difficulty, variant: 'xie' }` and, this mode being a two-player table for now,
  fills the second seat with an AI teammate. `modeIdFor(roomMode, difficulty, variant)` resolves
  `mode_<variant>_<difficulty>` and the Room carries the variant into `room.state` and its Match.
- **Borrowing numbers**: one fund per request; the per-round budget is **what the borrower earns next round**
  (`min(12, gd.income(round + 1))` — 5 in round 1 up to 8 from round 4 in 标准), team total ≤ 8 per round, 30 s TTL.
  Approving moves the funds directly; deny/cancel/prep-end/leave/elimination close the request.
- **UI**: 借钱 is one control in the HUD (public/js/ui/borrowPlate.js, mounted by screens/game.js as `.gm__borrow`, right
  of the 整备区 row on the shop bar's button line): the official `garrisonTypeIcon/icon_gold` 资金 icon with the count and
  a 借钱 caption on a CSS button, clicking it opens the teammate picker beside it; a pending request replaces it with
  同意 / 拒绝 (撤回 while it is mine), and 欠 N / 应收 N / 兜底 N% chips show the ledger and the coverage. The lobby
  card's badge is the official `hudPanel/icon_coop` (local extraction first, the mirror copy second, a glyph last).
- **Tests**: `test/match/coop-economy.test.js` (the framework, the mode's numbers, the debts, the two PvE rewards),
  `test/ui/coop-economy-ui.test.js` (the plate and the strip) and the docs-consistency gate (§27/§28 ⇄ `mode_xie_*` ⇄
  the shipped numbers).
