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
    view: 'holdings',  // 'holdings' | 'trends' | 'orders'
    targetEdit: null,  // 목표비중 수정 중인 항목 {row, name, targetPct}
    targetSaving: false
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
    $('viewOrders').hidden = view !== 'orders';
    // 카테고리 칩 필터는 보유 현황 화면 전용이다.
    $('chipBar').hidden = view !== 'holdings';

    Array.prototype.forEach.call($('tabBar').querySelectorAll('.tab'), function (b) {
      b.setAttribute('aria-selected', String(b.dataset.view === view));
    });

    // 추이 뷰는 열릴 때 처음으로 history 를 부른다(보유 현황만 볼 사람에게 왕복을 강요하지 않는다).
    if (view === 'trends' && window.TrendsView) window.TrendsView.activate();
    // 주문 뷰도 마찬가지 — 열릴 때 계획/상한/이력을 처음 받아온다(읽기 전용 호출뿐).
    if (view === 'orders' && window.OrdersView) window.OrdersView.activate();
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

  /* ── 저장 결과 배너 ─────────────────────────────── */

  /**
   * 목표비중 저장 결과를 알리는 커스텀 배너.
   * 네이티브 alert() 를 쓰지 않는다 — 자동화 테스트를 막고 UX 도 어긋나기 때문.
   * `warning` 이 있어도 **저장은 이미 끝난 상태**이므로 문구에서 이를 분명히 한다.
   */
  function showBanner(opts) {
    var box = $('saveBanner');
    $('saveBannerTitle').textContent = opts.title || '';
    $('saveBannerText').textContent = opts.text || '';
    box.classList.toggle('is-warn', !!opts.warn);
    box.classList.toggle('is-error', !!opts.error);

    var undo = $('saveBannerUndoBtn');
    undo.onclick = null;
    if (opts.onUndo) {
      undo.hidden = false;
      undo.onclick = opts.onUndo;
    } else {
      undo.hidden = true;
    }
    box.hidden = false;
  }

  function hideBanner() {
    $('saveBanner').hidden = true;
    $('saveBannerUndoBtn').hidden = true;
    $('saveBannerUndoBtn').onclick = null;
  }

  /* ── 목표비중 수정 (종목 전용) ──────────────────── */

  /**
   * 카테고리 목표비중(A열)은 시트에서 `=SUM(E..)` 수식이라 서버가 저장을 거부한다.
   * 그래서 편집 가능한 입력으로 노출하지 않고, 종목(item) 목표만 이 시트로 고친다.
   * (docs/api-contract.md "목표비중 수정" 절)
   */
  function openTargetSheet(row, name, targetPct) {
    state.targetEdit = { row: Number(row), name: name, targetPct: num(targetPct) };
    $('targetDesc').textContent =
      name + ' — 현재 목표 ' + pct(targetPct, 2) + ' (전체 자산 대비)';
    $('targetInput').value = (num(targetPct) * 100).toFixed(2).replace(/\.?0+$/, '');
    $('targetError').hidden = true;
    $('targetError').textContent = '';
    $('targetOverlay').hidden = false;
    $('targetInput').focus();
    $('targetInput').select();
  }

  function closeTargetSheet() {
    state.targetEdit = null;
    $('targetOverlay').hidden = true;
  }

  function targetError(msg) {
    var el = $('targetError');
    el.hidden = false;
    el.textContent = msg;
  }

  /** 저장 요청. targetPct 는 계약상 분수 스케일(0~1)이므로 입력(%)을 100으로 나눈다. */
  async function saveTarget(row, name, percentValue) {
    var frac = percentValue / 100;
    var res = await API.apiPost('updateTargetAllocation', {
      scope: 'item',           // 'category' 는 수식 셀이라 서버가 거부한다 — 보내지 않는다.
      row: Number(row),
      targetPct: frac
    });

    showBanner({
      title: name + ' 목표비중을 ' + pct(res.targetPct, 2) + '(으)로 저장했습니다.',
      warn: !!res.warning,
      text: res.warning
        ? '저장은 이미 완료되었습니다. 다만 합계 경고가 있습니다 — ' + res.warning
        : '전체 종목 목표 합계 ' + pct(res.itemTotalSum, 2) + ' · 리밸런싱 계획이 새 값으로 다시 계산됩니다.',
      onUndo: (res.previousPct === null || res.previousPct === undefined) ? null : function () {
        hideBanner();
        saveTarget(row, name, num(res.previousPct) * 100)
          .then(function () { return load(); })
          .catch(function (e) {
            showBanner({ title: '되돌리기 실패', text: e.message, error: true });
          });
      }
    });

    // 목표가 바뀌면 리밸런싱 계획도 달라진다 — 주문 뷰가 이미 열려 있었다면 다시 받아오게 한다.
    if (window.OrdersView) window.OrdersView.invalidate();
    return res;
  }

  function wireTargetSheet() {
    $('targetCancelBtn').addEventListener('click', closeTargetSheet);

    $('targetOverlay').addEventListener('click', function (e) {
      if (e.target === this && !state.targetSaving) closeTargetSheet();
    });

    $('targetInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('targetSaveBtn').click();
    });

    $('targetSaveBtn').addEventListener('click', async function () {
      if (state.targetSaving || !state.targetEdit) return;
      var edit = state.targetEdit;
      var raw = $('targetInput').value.trim();
      if (raw === '') { targetError('값을 입력해주세요.'); return; }
      var v = Number(raw);
      if (!isFinite(v)) { targetError('숫자만 입력할 수 있습니다.'); return; }
      // 서버도 0~1(분수) 범위를 강제하지만, 왕복 전에 같은 규칙으로 먼저 걸러낸다.
      if (v < 0 || v > 100) { targetError('0% 이상 100% 이하만 입력할 수 있습니다.'); return; }

      state.targetSaving = true;
      this.disabled = true;
      $('targetCancelBtn').disabled = true;
      try {
        await saveTarget(edit.row, edit.name, v);
        closeTargetSheet();
        await load();
      } catch (e) {
        targetError('저장 실패: ' + e.message);
      } finally {
        state.targetSaving = false;
        this.disabled = false;
        $('targetCancelBtn').disabled = false;
      }
    });

    $('saveBannerCloseBtn').addEventListener('click', hideBanner);

    // 카드의 "목표 수정" 버튼은 매 렌더마다 새로 그려지므로 위임으로 잡는다.
    $('list').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.target-edit-btn') : null;
      if (!btn) return;
      openTargetSheet(btn.dataset.row, btn.dataset.name, btn.dataset.target);
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
        '<div class="card-foot">' +
          badgeHtml(item) +
          // 종목 목표비중만 편집 가능(카테고리는 시트 수식 → 서버가 거부).
          '<button type="button" class="link-btn target-edit-btn"' +
            ' data-row="' + esc(item.row) + '"' +
            ' data-name="' + esc(item.name) + '"' +
            ' data-target="' + esc(num(item.targetPct)) + '">목표비중 수정</button>' +
        '</div>' +
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
          // 카테고리 목표는 시트에서 `=SUM(종목 목표)` 수식이라 **읽기 전용**이다.
          // 편집 입력으로 노출하면 서버가 거부하는 요청을 유도하게 되므로 그리지 않는다.
          '<span class="cat-pct">목표 <b>' + esc(pct(cat.targetPct)) + '</b>' +
            '<span class="cat-ro" title="종목 목표비중의 합계로 자동 계산됩니다(수정 불가)">자동</span> · ' +
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
  wireTargetSheet();
  if (window.TrendsView) window.TrendsView.wire();
  if (window.OrdersView) window.OrdersView.wire();
  $('reloadBtn').addEventListener('click', load);
  setView('holdings');

  if (API.hasToken()) load();
  else openTokenSheet();
})();
