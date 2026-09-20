/**
 * 화면 조립.
 *
 * 필드명은 docs/api-contract.md 와 backend/Code.js 의 getPortfolioData()/getRebalancePlan()
 * 반환 shape을 그대로 따른다. 임의 변환/이름 바꾸기 금지.
 *
 * 비율 필드 스케일 주의: targetPct / curPct / currentPct / pnlPct / totalPnlPct 는
 * 시트 셀의 퍼센트 서식 원본값이라 "분수"(0.153 = 15.3%)로 온다. 표시할 때만 ×100 한다.
 * (기존 검증된 Index_v4 UI 의 렌더링과 동일한 처리)
 */
(function () {
  'use strict';

  var state = {
    portfolio: null,
    planByRow: {},     // row -> rebalancePlan 항목
    filter: 'all',
    loading: false,
    view: 'holdings'   // 'holdings' | 'trends'
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ── 포맷터 ─────────────────────────────────────── */

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  /** 금액(원). 소수점은 버리고 천단위 구분. */
  function won(v) {
    if (v === null || v === undefined || v === '' || !isFinite(Number(v))) return '–';
    return Math.round(Number(v)).toLocaleString('ko-KR');
  }

  /** 수량. 소수 보유가 있을 수 있으므로 최대 4자리까지만 살린다. */
  function qtyFmt(v) {
    if (v === null || v === undefined || v === '' || !isFinite(Number(v))) return '–';
    return Number(v).toLocaleString('ko-KR', { maximumFractionDigits: 4 });
  }

  /** 분수(0.153) → '15.3%' */
  function pct(v, digits) {
    if (v === null || v === undefined || v === '' || !isFinite(Number(v))) return '–';
    return (Number(v) * 100).toFixed(digits === undefined ? 1 : digits) + '%';
  }

  function signedPct(v, digits) {
    var n = num(v);
    return (n >= 0 ? '+' : '') + pct(n, digits);
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ── 토스트 / 상태 ───────────────────────────────── */

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  function setStatus(msg, isError) {
    var box = $('statusBox');
    if (!msg) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    box.textContent = msg;
    box.classList.toggle('error', !!isError);
  }

  /* ── 탭(화면 전환) ──────────────────────────────── */

  function setView(view) {
    state.view = view;
    $('viewHoldings').hidden = view !== 'holdings';
    $('viewTrends').hidden = view !== 'trends';
    // 카테고리 칩 필터는 보유 현황 화면 전용이다.
    $('chipBar').hidden = view !== 'holdings';

    Array.prototype.forEach.call($('tabBar').querySelectorAll('.tab'), function (b) {
      b.setAttribute('aria-selected', String(b.dataset.view === view));
    });

    // 추이 뷰는 열릴 때 처음으로 history 를 부른다(보유 현황만 볼 사람에게 왕복을 강요하지 않는다).
    if (view === 'trends' && window.TrendsView) window.TrendsView.activate();
  }

  function wireTabs() {
    Array.prototype.forEach.call($('tabBar').querySelectorAll('.tab'), function (b) {
      b.addEventListener('click', function () { setView(b.dataset.view); });
    });
  }

  /* ── 토큰 입력 ──────────────────────────────────── */

  function openTokenSheet(message) {
    var err = $('tokenError');
    if (message) { err.hidden = false; err.textContent = message; }
    else { err.hidden = true; err.textContent = ''; }
    $('tokenOverlay').hidden = false;
    $('tokenInput').focus();
  }

  function closeTokenSheet() {
    $('tokenOverlay').hidden = true;
    $('tokenInput').value = '';
  }

  function wireTokenSheet() {
    $('tokenSaveBtn').addEventListener('click', function () {
      var value = $('tokenInput').value.trim();
      if (!value) { openTokenSheet('토큰을 입력해주세요.'); return; }
      if (!API.setToken(value)) {
        openTokenSheet('이 브라우저에서 localStorage 를 쓸 수 없습니다(프라이빗 모드?).');
        return;
      }
      closeTokenSheet();
      load();
    });

    $('tokenInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('tokenSaveBtn').click();
    });

    $('bootstrapBtn').addEventListener('click', async function () {
      var btn = this;
      btn.disabled = true;
      try {
        var token = await API.bootstrapToken();
        $('tokenInput').value = token || '';
        $('tokenError').hidden = true;
        toast('토큰이 발급됐습니다. 저장하고 시작을 누르세요.');
      } catch (e) {
        openTokenSheet(
          e.code === 'already_initialized'
            ? '이미 발급된 토큰이 있습니다. 기존 토큰을 입력해주세요.'
            : '발급 실패: ' + e.message
        );
      } finally {
        btn.disabled = false;
      }
    });

    $('resetTokenBtn').addEventListener('click', function () {
      API.clearToken();
      openTokenSheet('새 토큰을 입력해주세요.');
    });
  }

  /* ── 렌더링 ─────────────────────────────────────── */

  function renderHero(data) {
    $('totalValue').textContent = won(data.total) + '원';

    var up = num(data.totalPnl) >= 0;
    $('totalSub').innerHTML =
      '투자원금 ' + esc(won(data.invested)) + '원 · ' +
      '<span class="' + (up ? 'up' : 'down') + '">' +
      (up ? '+' : '') + esc(won(data.totalPnl)) + '원 (' + esc(signedPct(data.totalPnlPct, 2)) + ')' +
      '</span>';

    $('updatedAt').textContent = data.updatedAt ? '마지막 갱신 ' + data.updatedAt : '';
  }

  function renderChips(categories) {
    var bar = $('chipBar');
    bar.innerHTML = '';
    var names = ['all'].concat(categories.map(function (c) { return c.name; }));
    names.forEach(function (name) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.textContent = name === 'all' ? '전체' : name;
      btn.setAttribute('aria-pressed', String(state.filter === name));
      btn.addEventListener('click', function () {
        state.filter = name;
        renderChips(categories);
        renderList();
      });
      bar.appendChild(btn);
    });
  }

  /**
   * 리밸런싱 배지. rebalancePlan 응답을 우선 쓰고(실제 주문 대상과 동일한 소스),
   * 없으면 portfolio 항목의 rebalQty 로 대체한다. 이번 단계는 표시 전용 — 주문 버튼 없음.
   */
  function badgeHtml(item) {
    if (!item.hasCode) return '<span class="badge none">종목코드 미등록</span>';

    var plan = state.planByRow[item.row];
    if (plan) {
      var isBuy = plan.side === '매수';
      return '<span class="badge ' + (isBuy ? 'buy' : 'sell') + '">' +
        esc(plan.side) + ' ' + esc(qtyFmt(plan.qty)) + '주 · 약 ' + esc(won(plan.amount)) + '원' +
        '</span>';
    }

    var rq = num(item.rebalQty);
    if (rq > 0) return '<span class="badge buy">매수 ' + esc(qtyFmt(rq)) + '주 필요</span>';
    if (rq < 0) return '<span class="badge sell">매도 ' + esc(qtyFmt(Math.abs(rq))) + '주 필요</span>';
    return '<span class="badge none">리밸런싱 불필요</span>';
  }

  function cardHtml(item) {
    var targetPct = num(item.targetPct) * 100;
    var curPct = num(item.curPct) * 100;
    // 두 값 중 큰 쪽에 여유를 둬 목표 마커가 트랙 밖으로 나가지 않게 한다.
    var barMax = Math.max(targetPct, curPct, 10) * 1.3;
    var fillW = Math.max(0, Math.min(100, (curPct / barMax) * 100));
    var markerX = Math.max(0, Math.min(100, (targetPct / barMax) * 100));

    var pnlUp = num(item.pnlPct) >= 0;

    return '' +
      '<article class="card">' +
        '<div class="card-top">' +
          '<div class="card-id">' +
            '<div class="card-name">' + esc(item.name) + '</div>' +
            '<div class="card-sub">' + esc(qtyFmt(item.qty)) + '주 · 평단 ' + esc(won(item.avgPrice)) + '원</div>' +
          '</div>' +
          '<div class="card-num">' +
            '<div class="card-value">' + esc(won(item.value)) + '원</div>' +
            '<div class="card-pnl ' + (pnlUp ? 'up' : 'down') + '">' + esc(signedPct(item.pnlPct)) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="card-meta">' +
          '<span>현재가 <b>' + esc(won(item.curPrice)) + '원</b></span>' +
          '<span>투자원금 <b>' + esc(won(item.invested)) + '원</b></span>' +
        '</div>' +
        '<div class="bar-wrap">' +
          '<div class="bar-track">' +
            '<div class="bar-fill" style="width:' + fillW.toFixed(1) + '%"></div>' +
            '<div class="bar-target" style="left:' + markerX.toFixed(1) + '%"></div>' +
          '</div>' +
          '<div class="bar-labels">' +
            '<span>현재 ' + curPct.toFixed(1) + '%</span>' +
            '<span>목표 ' + targetPct.toFixed(1) + '%</span>' +
          '</div>' +
        '</div>' +
        badgeHtml(item) +
      '</article>';
  }

  function renderList() {
    var list = $('list');
    var data = state.portfolio;
    if (!data) { list.innerHTML = ''; return; }

    var html = '';
    data.categories.forEach(function (cat) {
      if (state.filter !== 'all' && state.filter !== cat.name) return;

      // 빈 행(시트 여백)은 제외
      var items = (cat.items || []).filter(function (it) { return it.name; });

      html += '<section class="cat-section">' +
        '<div class="cat-header">' +
          '<span class="cat-name">' + esc(cat.name) + '</span>' +
          '<span class="cat-pct">목표 <b>' + esc(pct(cat.targetPct)) + '</b> · ' +
            '현재 <b>' + esc(pct(cat.currentPct)) + '</b></span>' +
        '</div>' +
        (items.length ? items.map(cardHtml).join('') : '<div class="empty">표시할 종목이 없습니다.</div>') +
        '</section>';
    });

    list.innerHTML = html || '<div class="empty">표시할 데이터가 없습니다.</div>';
  }

  /* ── 로딩 ───────────────────────────────────────── */

  async function load() {
    if (state.loading) return;
    if (!API.hasToken()) { openTokenSheet(); return; }

    state.loading = true;
    $('reloadBtn').disabled = true;
    setStatus('불러오는 중…');

    try {
      var portfolio = await API.apiGet('portfolio');
      state.portfolio = portfolio;
      setStatus('');
      renderHero(portfolio);
      renderChips(portfolio.categories || []);
      renderList();
      // 추이 뷰는 같은 portfolio 응답을 재사용한다(배분 도넛 + 투영 기준값).
      if (window.TrendsView) window.TrendsView.setPortfolio(portfolio);
    } catch (e) {
      if (e.code === 'unauthorized' || e.code === 'no_token') {
        API.clearToken();
        setStatus('');
        openTokenSheet('토큰이 유효하지 않습니다. 다시 입력해주세요.');
        return;
      }
      setStatus('불러오기 실패: ' + e.message, true);
      return;
    } finally {
      state.loading = false;
      $('reloadBtn').disabled = false;
    }

    // 리밸런싱 계획은 부가 정보 — 실패해도 포트폴리오 화면은 유지한다.
    try {
      var plan = await API.apiGet('rebalancePlan');
      var map = {};
      (plan || []).forEach(function (p) { map[p.row] = p; });
      state.planByRow = map;
      renderList();
    } catch (e) {
      toast('리밸런싱 계획을 불러오지 못했습니다: ' + e.message);
    }
  }

  /* ── 시작 ───────────────────────────────────────── */

  // 추이 뷰가 토스트를 쓸 수 있게 최소 인터페이스만 공개한다.
  window.Dashboard = { toast: toast, setView: setView };

  wireTokenSheet();
  wireTabs();
  if (window.TrendsView) window.TrendsView.wire();
  $('reloadBtn').addEventListener('click', load);
  setView('holdings');

  if (API.hasToken()) load();
  else openTokenSheet();
})();
