/* 5199 游戏厅 · 前端 */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);

  const state = {
    games: [],
    filter: 'all',
    query: '',
    current: null
  };

  const els = {
    grid: $('#grid'),
    empty: $('#empty'),
    hero: $('#hero'),
    heroCover: $('#heroCover'),
    heroTag: $('#heroTag'),
    heroTitle: $('#heroTitle'),
    heroSub: $('#heroSub'),
    heroDesc: $('#heroDesc'),
    heroMeta: $('#heroMeta'),
    heroPlay: $('#heroPlay'),
    heroInfo: $('#heroInfo'),
    liveCount: $('#liveCount'),
    footStat: $('#footStat'),
    chips: $('#chips'),
    search: $('#search'),
    player: $('#player'),
    launch: $('#launch'),
    launchBg: $('#launchBg'),
    launchIcon: $('#launchIcon'),
    launchName: $('#launchName'),
    launchTag: $('#launchTag'),
    launchCap: $('#launchCap'),
    launchDesc: $('#launchDesc'),
    launchKeys: $('#launchKeys'),
    loading: $('#loading'),
    loadingTitle: $('#loadingTitle'),
    loadingTip: $('#loadingTip'),
    loaderIcon: $('#loaderIcon'),
    frame: $('#frame'),
    pName: $('#pName'),
    pState: $('#pState'),
    btnStart: $('#btnStart'),
    btnBack: $('#btnBack'),
    btnShare: $('#btnShare'),
    btnReload: $('#btnReload'),
    btnFull: $('#btnFull'),
    toast: $('#toast')
  };

  let toastTimer = null;
  function toast(text) {
    els.toast.textContent = text;
    els.toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('on'), 2400);
  }

  /* ---------------- 数据 ---------------- */
  async function loadGames() {
    try {
      const res = await fetch('/api/games', { cache: 'no-store' });
      const data = await res.json();
      state.games = data.games || [];
      render();
      updateLive(data.total);
    } catch (e) {
      els.grid.innerHTML = '<p class="empty">游戏列表加载失败，请刷新重试。</p>';
    }
  }

  async function pollStatus() {
    try {
      const res = await fetch('/api/games', { cache: 'no-store' });
      const data = await res.json();
      const bySlug = new Map((data.games || []).map(g => [g.slug, g]));
      state.games = state.games.map(g => ({ ...g, ...(bySlug.get(g.slug) || {}) }));
      updateLive(data.total);
      // 同步卡片上的在线数字
      document.querySelectorAll('.card').forEach(card => {
        const g = bySlug.get(card.dataset.slug);
        const badge = card.querySelector('.card-badge');
        if (g && badge) {
          badge.textContent = g.online > 0 ? `● ${g.online} 人在房间` : (g.onlineCapable ? '联机' : '单机');
          badge.classList.toggle('live', g.online > 0);
        }
      });
      if (state.current) updateStatePill(state.current);
    } catch (e) { /* 静默 */ }
  }

  function updateLive(n) {
    els.liveCount.textContent = n == null ? '—' : n;
    els.footStat.textContent = `${state.games.length} 款游戏`;
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    const featured = state.games.find(g => g.slug === 'sky-dogfight') || state.games[0];
    if (featured) renderHero(featured);
    renderGrid();
  }

  function renderHero(g) {
    els.heroTag.textContent = '本周推荐';
    els.heroTitle.textContent = g.name;
    els.heroSub.textContent = `${g.en} · ${g.tag}`;
    els.heroDesc.textContent = g.desc;
    els.heroMeta.innerHTML = `
      <span>人数 <b>${g.players}</b></span>
      <span>状态 <b data-hero-state>${g.online > 0 ? `房间内 ${g.online} 人` : (g.onlineCapable ? '可联机' : '单机')}</b></span>
      <span>操作 <b>${g.keys.split('·')[0].trim()}</b></span>`;
    els.hero.style.setProperty('--accent', g.color || '#7dd3fc');

    const img = new Image();
    img.onload = () => {
      els.heroCover.style.backgroundImage = `url("${g.cover}")`;
      els.heroCover.classList.add('on');
    };
    img.src = g.cover;

    els.heroPlay.onclick = () => openGame(g.slug, true);
    els.heroInfo.onclick = () => openGame(g.slug, false);
  }

  function visibleGames() {
    return state.games.filter(g => {
      if (state.filter === 'online' && !g.onlineCapable) return false;
      if (state.filter === 'solo' && g.onlineCapable) return false;
      if (!state.query) return true;
      const q = state.query.toLowerCase();
      return (g.name + g.en + g.tag + g.desc).toLowerCase().includes(q);
    });
  }

  function renderGrid() {
    const list = visibleGames();
    els.empty.hidden = list.length > 0;
    els.grid.innerHTML = list.map(g => `
      <article class="card" data-slug="${g.slug}" style="--c:${g.color};--c2:${g.color2}" tabindex="0" role="button" aria-label="打开 ${g.name}">
        <div class="card-media">
          <div class="card-icon">${g.icon}</div>
          <img src="${g.cover}" alt="${g.name}" loading="lazy" onload="this.classList.add('ok')" onerror="this.remove()" />
          <span class="card-badge ${g.online > 0 ? 'live' : ''}">${g.online > 0 ? `● ${g.online} 人在房间` : (g.onlineCapable ? '联机' : '单机')}</span>
          <span class="card-play">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
          </span>
        </div>
        <div class="card-body">
          <div class="card-title"><h3>${g.name}</h3><span>${g.en}</span></div>
          <div class="card-tag">${g.tag} · ${g.players}</div>
          <p class="card-desc">${g.desc}</p>
        </div>
      </article>`).join('');

    els.grid.querySelectorAll('.card').forEach(card => {
      card.addEventListener('click', () => openGame(card.dataset.slug, false));
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGame(card.dataset.slug, false); }
      });
    });
  }

  /* ---------------- 游戏弹层 ---------------- */
  function openGame(slug, autoStart) {
    const g = state.games.find(x => x.slug === slug);
    if (!g) return;
    state.current = g;
    window.__CURRENT_GAME__ = g.slug;   // 供心跳上报当前位置
    els.player.hidden = false;
    document.body.style.overflow = 'hidden';

    els.pName.textContent = g.name;
    els.launch.style.setProperty('--c', g.color);
    els.launch.style.setProperty('--c2', g.color2);
    els.launchIcon.textContent = g.icon;
    els.launchName.textContent = g.name;
    els.launchTag.textContent = `${g.en} · ${g.tag}`;
    els.launchCap.textContent = g.players;
    els.launchDesc.textContent = g.desc;
    els.launchKeys.textContent = g.keys;
    els.launchBg.style.backgroundImage = `url("${g.cover}")`;

    els.frame.hidden = true;
    els.frame.removeAttribute('src');
    els.launch.hidden = false;
    els.loading.hidden = true;
    els.loaderIcon.textContent = g.icon;
    els.loadingTitle.textContent = '正在加载游戏资源…';
    els.loadingTip.textContent = '正在连接游戏服务，请稍候';
    setPill('准备中', false);

    history.replaceState(null, '', `#/game/${g.slug}`);
    updateStatePill(g);

    if (autoStart) setTimeout(() => startGame(), 260);
  }

  function startGame() {
    const g = state.current;
    if (!g) return;
    els.launch.hidden = true;
    els.loading.hidden = false;
    els.frame.hidden = false;
    setPill('加载资源中', false);

    const started = Date.now();
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      els.loading.hidden = true;
      setPill('已进入', true);
      updateStatePill(g);
    };

    els.frame.onload = () => {
      // 至少让加载动画走完 600ms，避免闪跳
      const wait = Math.max(0, 600 - (Date.now() - started));
      setTimeout(finish, wait);
    };

    els.frame.src = `/play/${g.slug}/?t=${Date.now()}`;

    // 慢加载提示：不写死「冷启动」，因为服务可能已在跑、只是资源大
    setTimeout(() => {
      if (done) return;
      els.loadingTip.textContent = '资源较多，正在加载…请再等几秒';
    }, 6000);
    setTimeout(() => {
      if (done) return;
      els.loadingTip.textContent = '加载时间超出预期，点右上角刷新可重新连接';
    }, 25000);
    setTimeout(() => {
      if (done) return;
      els.loadingTip.textContent = '长时间无响应，返回大厅重新进入会自动修复';
    }, 45000);
  }

  function setPill(text, live) {
    els.pState.innerHTML = `<i class="dot"></i>${text}`;
    els.pState.classList.toggle('live', !!live);
  }

  function updateStatePill(g) {
    if (!g) return;
    if (g.online > 0) setPill(`房间内 ${g.online} 人`, true);
  }

  function closeGame() {
    if (!state.current) return;
    state.current = null;
    window.__CURRENT_GAME__ = 'lobby';
    els.player.hidden = true;
    els.frame.onload = null;
    els.frame.removeAttribute('src');
    els.frame.hidden = true;
    document.body.style.overflow = '';
    history.replaceState(null, '', '#/');
    setPill('准备中', false);
  }

  /* ---------------- 事件 ---------------- */
  els.btnStart.addEventListener('click', startGame);
  els.btnBack.addEventListener('click', closeGame);
  els.btnShare.addEventListener('click', async () => {
    if (!state.current) return;
    // 保留当前地址上的访问参数（如 ?sharecode=...），否则好友打开会被拒
    const url = new URL(location.href);
    url.hash = `#/game/${state.current.slug}`;
    try {
      await navigator.clipboard.writeText(url.toString());
      toast('邀请链接已复制，发给好友即可同房');
    } catch (e) {
      toast(url.toString());
    }
  });
  els.btnReload.addEventListener('click', () => {
    if (!state.current) return;
    els.loading.hidden = false;
    els.frame.hidden = false;
    setPill('重新加载中', false);
    els.frame.src = `/play/${state.current.slug}/?t=${Date.now()}`;
  });
  els.btnFull.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else els.player.requestFullscreen && els.player.requestFullscreen();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.current) closeGame();
  });

  els.chips.addEventListener('click', e => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    els.chips.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === btn));
    renderGrid();
  });

  els.search.addEventListener('input', () => {
    state.query = els.search.value.trim();
    renderGrid();
  });

  window.addEventListener('scroll', () => {
    document.querySelector('.topbar').classList.toggle('solid', window.scrollY > 40);
  }, { passive: true });

  window.addEventListener('hashchange', () => {
    const m = /^#\/game\/([\w-]+)$/.exec(location.hash);
    if (m) {
      const g = state.games.find(x => x.slug === m[1]);
      if (g && state.current?.slug !== g.slug) openGame(g.slug, false);
    } else if (state.current) {
      closeGame();
    }
  });

  /* ---------------- 启动 ---------------- */
  loadGames().then(() => {
    const m = /^#\/game\/([\w-]+)$/.exec(location.hash);
    if (m) openGame(m[1], false);
  });
  setInterval(pollStatus, 10000);
})();
