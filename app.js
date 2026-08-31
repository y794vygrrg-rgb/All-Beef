(() => {
  "use strict";

  const CFG = window.TRADE_TREE_CONFIG || {};
  const LEAGUE_ID = String(CFG.leagueId || "");
  const MAX_WEEKS = Number(CFG.maxTransactionWeeks || 18);
  const CACHE_HOURS = Number(CFG.playerCacheHours || 24);
  const API = "https://api.sleeper.app/v1";

  const state = {
    leagueChain: [],
    seasons: [],
    usersByLeague: new Map(),
    rostersByLeague: new Map(),
    managerMap: new Map(),
    trades: [],
    players: {},
    currentLeague: null,
    selectedRosterId: null,
    selectedTradeId: null
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));

  async function api(path) {
    const res = await fetch(`${API}${path}`);
    if (!res.ok) throw new Error(`Sleeper request failed (${res.status})`);
    return res.json();
  }

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  function fmtDate(ms) {
    if (!ms) return "Unknown date";
    return new Intl.DateTimeFormat(undefined, {month:"short", day:"numeric", year:"numeric"})
      .format(new Date(Number(ms)));
  }

  function teamName(leagueId, rosterId) {
    const key = `${leagueId}:${rosterId}`;
    const m = state.managerMap.get(key);
    return m?.teamName || m?.displayName || `Roster ${rosterId}`;
  }

  function teamAvatar(leagueId, rosterId) {
    const key = `${leagueId}:${rosterId}`;
    return state.managerMap.get(key)?.avatar || null;
  }

  function avatarHTML(leagueId, rosterId) {
    const avatar = teamAvatar(leagueId, rosterId);
    if (avatar) {
      return `<img class="avatar" alt="" src="https://sleepercdn.com/avatars/thumbs/${esc(avatar)}">`;
    }
    const initials = teamName(leagueId, rosterId).split(/\s+/).slice(0,2).map(x=>x[0]||"").join("").toUpperCase();
    return `<span class="avatar fallback">${esc(initials || "T")}</span>`;
  }

  async function loadLeagueChain() {
    let id = LEAGUE_ID;
    const seen = new Set();
    while (id && id !== "0" && !seen.has(id)) {
      seen.add(id);
      const league = await api(`/league/${id}`);
      state.leagueChain.push(league);
      id = league.previous_league_id;
    }
    state.currentLeague = state.leagueChain[0];
    state.seasons = [...new Set(state.leagueChain.map(l => String(l.season)))].sort((a,b)=>b-a);
  }

  async function loadPeople() {
    for (const league of state.leagueChain) {
      const [users, rosters] = await Promise.all([
        api(`/league/${league.league_id}/users`),
        api(`/league/${league.league_id}/rosters`)
      ]);
      state.usersByLeague.set(String(league.league_id), users);
      state.rostersByLeague.set(String(league.league_id), rosters);

      const usersById = new Map(users.map(u => [String(u.user_id), u]));
      rosters.forEach(r => {
        const u = usersById.get(String(r.owner_id));
        state.managerMap.set(`${league.league_id}:${r.roster_id}`, {
          rosterId: r.roster_id,
          ownerId: r.owner_id,
          teamName: u?.metadata?.team_name || u?.display_name || `Roster ${r.roster_id}`,
          displayName: u?.display_name || "",
          avatar: u?.avatar || null,
          roster: r
        });
      });
    }
  }

  async function loadTrades() {
    const all = [];
    for (const league of state.leagueChain) {
      const requests = Array.from({length: MAX_WEEKS}, (_, i) =>
        api(`/league/${league.league_id}/transactions/${i+1}`).catch(() => [])
      );
      const weeks = await Promise.all(requests);
      weeks.flat().forEach(tx => {
        if (tx?.type === "trade" && tx?.status === "complete") {
          all.push({...tx, _leagueId:String(league.league_id), _season:String(league.season)});
        }
      });
    }
    const deduped = new Map();
    all.forEach(t => deduped.set(String(t.transaction_id), t));
    state.trades = [...deduped.values()].sort((a,b)=>Number(b.created||0)-Number(a.created||0));
  }

  async function loadPlayers() {
    const key = "dynastyTradeTree.players.v1";
    try {
      const cached = JSON.parse(localStorage.getItem(key) || "null");
      if (cached && Date.now() - cached.savedAt < CACHE_HOURS * 3600000 && cached.players) {
        state.players = cached.players;
        return;
      }
    } catch (_) {}
    try {
      state.players = await api("/players/nfl");
      try { localStorage.setItem(key, JSON.stringify({savedAt:Date.now(), players:state.players})); } catch (_) {}
    } catch (_) {
      state.players = {};
      toast("Player directory unavailable; IDs will be shown.");
    }
  }

  function playerName(id) {
    if (!id) return "Unknown player";
    const p = state.players[String(id)];
    return p?.full_name || [p?.first_name,p?.last_name].filter(Boolean).join(" ") || (String(id).length <= 3 ? `${id} D/ST` : `Player ${id}`);
  }

  function pickKey(p) {
    return `pick:${p.season}:${p.round}:${p.roster_id}`;
  }

  function pickLabel(p, leagueId) {
    const ordinal = {1:"1st",2:"2nd",3:"3rd"}[Number(p.round)] || `${p.round}th`;
    const original = teamName(leagueId, p.roster_id);
    return `${p.season} ${ordinal} (${original})`;
  }

  function allAssets(tx) {
    const result = [];
    const adds = tx.adds || {};
    const drops = tx.drops || {};
    const playerIds = new Set([...Object.keys(adds), ...Object.keys(drops)]);
    playerIds.forEach(pid => {
      result.push({
        key:`player:${pid}`, type:"player", id:pid, label:playerName(pid),
        from:drops[pid] ?? null, to:adds[pid] ?? null
      });
    });
    (tx.draft_picks || []).forEach(p => {
      result.push({
        key:pickKey(p), type:"pick", label:pickLabel(p, tx._leagueId),
        from:p.previous_owner_id ?? null, to:p.owner_id ?? null, raw:p
      });
    });
    (tx.waiver_budget || []).forEach((w,i) => {
      result.push({
        key:`faab:${tx.transaction_id}:${i}`, type:"faab", label:`$${w.amount} FAAB`,
        from:w.sender, to:w.receiver
      });
    });
    return result;
  }

  function assetsReceived(tx, rosterId) {
    return allAssets(tx).filter(a => Number(a.to) === Number(rosterId));
  }
  function assetsSent(tx, rosterId) {
    return allAssets(tx).filter(a => Number(a.from) === Number(rosterId));
  }

  function sideAssets(tx, rosterId) {
    const rec = assetsReceived(tx, rosterId);
    return rec.length ? rec : allAssets(tx).filter(a => Number(a.to) === Number(rosterId));
  }

  function partnerLabel(tx, rosterId) {
    const others = (tx.roster_ids || []).filter(id => Number(id) !== Number(rosterId));
    if (!others.length) return "Trade";
    if (others.length > 1) return "Multi-team trade";
    return teamName(tx._leagueId, others[0]);
  }

  function currentRosterIds() {
    return (state.rostersByLeague.get(String(state.currentLeague.league_id)) || []).map(r => r.roster_id);
  }

  function currentManagerForRoster(rosterId) {
    return state.managerMap.get(`${state.currentLeague.league_id}:${rosterId}`);
  }

  function resolveHistoricRosterForCurrent(currentRosterId, tx) {
    // Sleeper roster IDs are normally stable year-to-year in renewed dynasty leagues.
    // If not, owner ID matching provides a fallback.
    if ((tx.roster_ids || []).some(x => Number(x) === Number(currentRosterId))) return Number(currentRosterId);
    const curr = currentManagerForRoster(currentRosterId);
    if (!curr?.ownerId) return Number(currentRosterId);
    const historic = (state.rostersByLeague.get(String(tx._leagueId)) || [])
      .find(r => String(r.owner_id) === String(curr.ownerId));
    return historic?.roster_id ?? Number(currentRosterId);
  }

  function tradesForCurrentRoster(currentRosterId) {
    return state.trades.filter(tx => {
      const rid = resolveHistoricRosterForCurrent(currentRosterId, tx);
      return (tx.roster_ids || []).some(x => Number(x) === Number(rid));
    });
  }

  function chipHTML(asset) {
    return `<span class="chip ${asset.type === "pick" ? "pick" : ""}">${esc(asset.label)}</span>`;
  }

  function tradeCardHTML(tx) {
    const rosterIds = tx.roster_ids || [];
    const sides = rosterIds.map(rid => {
      const received = sideAssets(tx, rid);
      return `<div class="trade-side">
        <div class="team-line">${avatarHTML(tx._leagueId, rid)}<span>${esc(teamName(tx._leagueId, rid))}</span></div>
        <div class="received">${received.length ? received.map(chipHTML).join("") : '<span class="muted">No mapped assets</span>'}</div>
      </div>`;
    }).join("");
    return `<article class="trade-card" data-search="${esc([
      ...rosterIds.map(r=>teamName(tx._leagueId,r)),
      ...allAssets(tx).map(a=>a.label),
      tx._season
    ].join(" ").toLowerCase())}">
      <div class="trade-head">
        <strong>${esc(tx._season)} · Week ${esc(tx.leg ?? "—")}</strong>
        <span>${esc(fmtDate(tx.created))}</span>
      </div>
      <div class="trade-sides">${sides}</div>
    </article>`;
  }

  function renderTrades() {
    const season = $("seasonFilter").value;
    const query = $("tradeSearch").value.trim().toLowerCase();
    const filtered = state.trades.filter(tx => {
      if (season !== "all" && tx._season !== season) return false;
      const haystack = [
        ...((tx.roster_ids || []).map(r=>teamName(tx._leagueId,r))),
        ...allAssets(tx).map(a=>a.label),
        tx._season
      ].join(" ").toLowerCase();
      return !query || haystack.includes(query);
    });
    $("tradeResultCount").textContent = filtered.length;
    $("tradeList").innerHTML = filtered.length ? filtered.map(tradeCardHTML).join("") : '<div class="card empty">No trades match those filters.</div>';
  }

  function renderTeams() {
    const currentId = String(state.currentLeague.league_id);
    const managers = currentRosterIds().map(rid => state.managerMap.get(`${currentId}:${rid}`)).filter(Boolean);
    $("teamsGrid").innerHTML = managers.map(m => {
      const trades = tradesForCurrentRoster(m.rosterId);
      const wins = m.roster?.settings?.wins ?? 0;
      const losses = m.roster?.settings?.losses ?? 0;
      return `<article class="card team-card">
        <div class="team-line">${avatarHTML(currentId,m.rosterId)}
          <div><strong>${esc(m.teamName)}</strong><p>${esc(m.displayName)}</p></div>
        </div>
        <div class="team-stats">
          <div><strong>${wins}-${losses}</strong><span>record</span></div>
          <div><strong>${trades.length}</strong><span>trades</span></div>
          <div><strong>${(m.roster?.players || []).length}</strong><span>players</span></div>
        </div>
      </article>`;
    }).join("");
  }

  function populateControls() {
    const currentId = String(state.currentLeague.league_id);
    const managerOptions = currentRosterIds().map(rid => {
      return `<option value="${rid}">${esc(teamName(currentId,rid))}</option>`;
    }).join("");
    $("treeTeamSelect").innerHTML = managerOptions;
    state.selectedRosterId = Number($("treeTeamSelect").value || currentRosterIds()[0] || 1);

    $("seasonFilter").innerHTML = `<option value="all">All seasons</option>` +
      state.seasons.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
    populateRootTrades();
  }

  function populateRootTrades() {
    const rosterId = Number($("treeTeamSelect").value);
    state.selectedRosterId = rosterId;
    const trades = tradesForCurrentRoster(rosterId);
    $("rootTradeSelect").innerHTML = trades.map(tx => {
      const rid = resolveHistoricRosterForCurrent(rosterId, tx);
      const received = assetsReceived(tx,rid).map(a=>a.label).slice(0,2).join(", ");
      return `<option value="${esc(tx.transaction_id)}">${esc(tx._season)} · ${esc(fmtDate(tx.created))} · ${esc(received || partnerLabel(tx,rid))}</option>`;
    }).join("");
    state.selectedTradeId = $("rootTradeSelect").value || null;
    renderTree();
  }

  function findNextSpend(assetKey, afterMs, currentRosterId) {
    const chronological = [...state.trades].sort((a,b)=>Number(a.created||0)-Number(b.created||0));
    for (const tx of chronological) {
      if (Number(tx.created||0) <= Number(afterMs||0)) continue;
      const rid = resolveHistoricRosterForCurrent(currentRosterId, tx);
      if (!(tx.roster_ids || []).some(x => Number(x) === Number(rid))) continue;
      const sent = assetsSent(tx,rid);
      if (sent.some(a => a.key === assetKey)) return {tx, rid};
    }
    return null;
  }

  function traceAsset(asset, rootTx, currentRosterId, depth=0, visited=new Set()) {
    const visitKey = `${asset.key}:${rootTx.transaction_id}`;
    if (visited.has(visitKey) || depth > 8) return null;
    visited.add(visitKey);

    const spend = findNextSpend(asset.key, rootTx.created, currentRosterId);
    if (!spend) {
      return {asset, status:"held", depth, children:[]};
    }
    const returns = assetsReceived(spend.tx, spend.rid);
    return {
      asset, status:"spent", depth, spentTx:spend.tx,
      children: returns.map(a => traceAsset(a, spend.tx, currentRosterId, depth+1, new Set(visited))).filter(Boolean)
    };
  }

  function flattenBranches(node, path=[], out=[]) {
    const nextPath = [...path,node];
    if (!node.children?.length) out.push(nextPath);
    else node.children.forEach(c => flattenBranches(c,nextPath,out));
    return out;
  }

  function renderTree() {
    const currentRosterId = Number($("treeTeamSelect").value);
    const tx = state.trades.find(t => String(t.transaction_id) === String($("rootTradeSelect").value));
    if (!tx) {
      $("treeCanvas").innerHTML = '<div class="empty">No completed trades found for this team.</div>';
      $("treeTitle").textContent = teamName(state.currentLeague.league_id,currentRosterId);
      $("branchCount").textContent = "0";
      return;
    }
    state.selectedTradeId = String(tx.transaction_id);
    const rid = resolveHistoricRosterForCurrent(currentRosterId, tx);
    const roots = assetsReceived(tx,rid).map(a => traceAsset(a,tx,currentRosterId)).filter(Boolean);
    const branches = roots.flatMap(r => flattenBranches(r));

    $("treeTitle").textContent = `${teamName(tx._leagueId,rid)} ← ${partnerLabel(tx,rid)}`;
    $("treeDate").textContent = `${tx._season} · ${fmtDate(tx.created)}`;
    $("branchCount").textContent = branches.length;

    const held = branches.filter(b => b[b.length-1].status === "held").length;
    const longest = branches.reduce((m,b)=>Math.max(m,b.length),0);
    $("treeSummary").innerHTML = `
      <div class="summary-card"><span>Assets originally acquired</span><strong>${roots.length}</strong></div>
      <div class="summary-card"><span>Open branches</span><strong>${held}</strong></div>
      <div class="summary-card"><span>Longest chain</span><strong>${longest} move${longest===1?"":"s"}</strong></div>`;

    if (!roots.length) {
      $("treeCanvas").innerHTML = '<div class="empty">This trade has no player/pick/FAAB assets mapped as received for the selected roster.</div>';
      return;
    }

    // Render each root as a vertical lineage. When an asset is later traded,
    // the assets received in that later trade become child branches.
    function nodeHTML(node, level=0) {
      const spent = node.status === "spent";
      const status = spent ? `Moved on ${fmtDate(node.spentTx.created)}` : "No later trade found";
      const children = node.children || [];
      return `<div class="tree-level">
        <div class="tree-trade">
          <div class="tree-meta">${level===0 ? "ROOT ASSET" : `RETURN · STEP ${level}`}</div>
          <strong>${esc(node.asset.label)}</strong>
          <div class="tree-meta">${esc(status)}</div>
        </div>
        <div>
          <div class="tree-assets">
            <div class="asset ${spent ? "spent" : "live"}">
              <span class="asset-type">${esc(node.asset.type)}</span>
              <strong>${esc(node.asset.label)}</strong>
              <small>${spent ? `Traded to create ${children.length} return asset${children.length===1?"":"s"}` : "Branch currently ends here"}</small>
            </div>
          </div>
          ${spent ? `<div class="tree-return">↳ ${esc(node.spentTx._season)} · ${esc(partnerLabel(node.spentTx, resolveHistoricRosterForCurrent(currentRosterId,node.spentTx)))}</div>` : ""}
        </div>
      </div>${children.map(c=>nodeHTML(c,level+1)).join("")}`;
    }
    $("treeCanvas").innerHTML = roots.map(r=>`<div class="tree-root">${nodeHTML(r)}</div>`).join("");
  }

  function renderHeader() {
    const league = state.currentLeague;
    document.title = `${league.name || "Dynasty"} · Trade Tree`;
    $("leagueName").textContent = league.name || "Dynasty Trade Tree";
    $("leagueIdLabel").textContent = league.league_id;
    $("footerLeague").textContent = league.league_id;
    $("seasonBadge").textContent = `Season ${league.season}`;
    $("teamsBadge").textContent = `${league.total_rosters || currentRosterIds().length} teams`;
    $("tradesBadge").textContent = `${state.trades.length} trades`;
    $("syncText").textContent = "Live Sleeper data";
    $("aboutSeasons").textContent = state.seasons.length;
    $("aboutTrades").textContent = state.trades.length;
    $("aboutManagers").textContent = currentRosterIds().length;
  }

  function bind() {
    document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));
      document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
      tab.classList.add("active");
      $(`view-${tab.dataset.view}`).classList.add("active");
    }));
    $("treeTeamSelect").addEventListener("change", populateRootTrades);
    $("rootTradeSelect").addEventListener("change", renderTree);
    $("tradeSearch").addEventListener("input", renderTrades);
    $("seasonFilter").addEventListener("change", renderTrades);
    $("refreshBtn").addEventListener("click", () => location.reload());
  }

  async function init() {
    if (!LEAGUE_ID) throw new Error("No Sleeper league ID configured.");
    $("leagueIdLabel").textContent = LEAGUE_ID;
    $("footerLeague").textContent = LEAGUE_ID;
    try {
      $("syncText").textContent = "Loading league…";
      await loadLeagueChain();
      $("syncText").textContent = "Loading managers…";
      await loadPeople();
      $("syncText").textContent = "Loading trades…";
      await loadTrades();
      $("syncText").textContent = "Loading player names…";
      await loadPlayers();

      renderHeader();
      populateControls();
      renderTrades();
      renderTeams();
      bind();
    } catch (err) {
      console.error(err);
      $("syncText").textContent = "Could not load";
      $("treeCanvas").innerHTML = `<div class="empty"><strong>Could not load Sleeper data.</strong><br>${esc(err.message)}<br><br>Verify that league ${esc(LEAGUE_ID)} is publicly reachable.</div>`;
      toast("Sleeper data could not be loaded.");
    }
  }

  init();
})();