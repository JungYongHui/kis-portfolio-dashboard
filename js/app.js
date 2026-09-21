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
    itemByRow: {},     // row -> portfolio 항목(+catName) — 상세 모달이 참조
    priceByRow: null,  // row -> priceSources 항목(시세 신선도). 첫 상세 모달에서 지연 로드
    filter: 'all',
    loading: false,
    view: 'holdings',  // 'holdings' | 'trends' | 'orders'
    targetEdit: null,  // 목표비중 수정 중인 항목 {scope, row, name, targetPct}
    targetSaving: false,
    detailRow: null,   // 상세 모달에 떠 있는 종목 row
    cashSaving: false
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

  /** 부호 붙은 금액. '+1,234' / '-1,234' */
  function signedWon(v) {
    if (v === null || v === undefined || v === '' || !isFinite(Number(v))) return '–';
    var n = Math.round(Number(v));
    return (n >= 0 ? '+' : '') + n.toLocaleString('ko-KR');
  }

  /**
   * ISO 시각 → '3분 전' 같은 상대 표기.
   * 시세 신선도는 "언제 갱신됐는지"가 핵심이라 절대시각보다 경과시간이 먼저 읽혀야 한다.
   * 파싱 불가/미래 시각이면 null 을 돌려주고 호출부가 절대시각만 보여준다.
   */
  function agoText(iso) {
    if (!iso) return null;
    var t = Date.parse(iso);
    if (!isFinite(t)) return null;
    var sec = Math.floor((Date.now() - t) / 1000);
    if (sec < 0) return null;
    if (sec < 60) return '방금 전';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + '분 전';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + '시간 전';
    return Math.floor(hr / 24) + '일 전';
  }

  /** ISO 시각 → 'M월 D일 HH:MM' (로컬). */
  function whenText(iso) {
    if (!iso) return '';
    var t = new Date(iso);
    if (!isFinite(t.getTime())) return String(iso);
    return (t.getMonth() + 1) + '월 ' + t.getDate() + '일 ' +
      String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
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

    // 카테고리 저장(비례 재분배) 결과의 종목별 이전/이후 목표% — 기본은 접어둔다.
    var detail = $('saveBannerDetail');
    var detailBtn = $('saveBannerDetailBtn');
    var items = (opts.items || []).filter(function (it) { return it && it.name; });
    if (items.length) {
      detail.innerHTML = items.map(function (it) {
        return '<div class="redist-row">' +
          '<span class="redist-name">' + esc(it.name) + '</span>' +
          '<span class="redist-val"><span class="redist-prev">' + esc(pct(it.previousPct, 2)) + ' → </span>' +
          esc(pct(it.newPct, 2)) + '</span>' +
          '</div>';
      }).join('');
      detailBtn.hidden = false;
      detailBtn.setAttribute('aria-expanded', 'false');
      detail.hidden = true;
    } else {
      detail.innerHTML = '';
      detail.hidden = true;
      detailBtn.hidden = true;
      detailBtn.setAttribute('aria-expanded', 'false');
    }

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
    $('saveBannerDetailBtn').hidden = true;
    $('saveBannerDetail').hidden = true;
    $('saveBannerDetail').innerHTML = '';
  }

  /* ── 목표비중 수정 (종목 / 카테고리) ────────────── */

  /**
   * 두 가지 scope 를 같은 시트로 처리한다.
   *  - `item`     : 종목 E열에 직접 쓴다.
   *  - `category` : 카테고리 목표(A열)는 `=SUM(E..)` 수식이라 직접 못 쓴다. 서버가 소속 종목의
   *                 목표%를 현재 비율 그대로 **비례 재분배**해서 합이 새 값이 되게 한다
   *                 (docs/api-contract.md "scope:'category' — 비례 재분배 방식" 절).
   *                 그래서 "다른 종목 숫자도 같이 바뀐다"는 걸 입력 전에 미리 알린다.
   */
  function openTargetSheet(scope, row, name, targetPct) {
    scope = scope === 'category' ? 'category' : 'item';
    state.targetEdit = { scope: scope, row: Number(row), name: name, targetPct: num(targetPct) };

    $('targetTitle').textContent = scope === 'category' ? '카테고리 목표비중 수정' : '목표비중 수정';
    $('targetDesc').textContent = scope === 'category'
      ? name + ' 카테고리 — 현재 목표 ' + pct(targetPct, 2) + ' (소속 종목 목표의 합계)'
      : name + ' — 현재 목표 ' + pct(targetPct, 2) + ' (전체 자산 대비)';
    $('targetHint').textContent = scope === 'category'
      ? '카테고리 목표는 소속 종목 목표비중의 합계입니다. 저장하면 종목들의 목표비중이 지금 비율 그대로 ' +
        '비례 조정되어 합계가 입력값이 됩니다(종목 간 상대 비율은 그대로). 저장 후 어떤 종목이 얼마로 ' +
        '바뀌었는지 보여드립니다.'
      : '전체 자산 대비 비중입니다(카테고리 내 비중이 아님). 합계가 100%를 벗어나도 저장은 되며 ' +
        '경고만 표시됩니다. 저장 즉시 다음 리밸런싱 계획이 새 값으로 다시 계산됩니다.';

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
  async function saveTarget(scope, row, name, percentValue) {
    scope = scope === 'category' ? 'category' : 'item';
    var frac = percentValue / 100;
    var res = await API.apiPost('updateTargetAllocation', {
      scope: scope,
      row: Number(row),        // category 는 계약상 **카테고리 anchorRow**(첫 종목 row)
      targetPct: frac
    });

    // 카테고리 저장이면 서버가 재배분 결과(items)를 돌려준다 — 이름이 있는 행만 센다(시트 여백 제외).
    var items = scope === 'category'
      ? (res.items || []).filter(function (it) { return it && it.name; })
      : [];

    var okText = scope === 'category'
      ? '카테고리 내 종목 목표 합계 ' + pct(res.itemSum, 2) + ' · 전체 합계 ' + pct(res.itemTotalSum, 2) +
        ' · 리밸런싱 계획이 새 값으로 다시 계산됩니다.'
      : '전체 종목 목표 합계 ' + pct(res.itemTotalSum, 2) + ' · 리밸런싱 계획이 새 값으로 다시 계산됩니다.';

    showBanner({
      title: (scope === 'category' ? name + ' 카테고리' : name) +
        ' 목표비중을 ' + pct(res.targetPct, 2) + '(으)로 저장했습니다.' +
        (items.length ? ' — 종목 ' + items.length + '개 재배분됨' : ''),
      warn: !!res.warning,
      text: res.warning
        ? '저장은 이미 완료되었습니다. 다만 합계 경고가 있습니다 — ' + res.warning
        : okText,
      items: items,
      onUndo: (res.previousPct === null || res.previousPct === undefined) ? null : function () {
        hideBanner();
        saveTarget(scope, row, name, num(res.previousPct) * 100)
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
        await saveTarget(edit.scope, edit.row, edit.name, v);
        closeTargetSheet();
        closeDetailSheet();   // 상세 모달에서 열었을 수 있다 — 저장 후 배너가 가려지지 않게 닫는다.
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

    $('saveBannerDetailBtn').addEventListener('click', function () {
      var detail = $('saveBannerDetail');
      detail.hidden = !detail.hidden;
      this.setAttribute('aria-expanded', String(!detail.hidden));
    });
  }

  /* ── 보유현황 리스트 상호작용 ───────────────────── */

  /**
   * 카드/카테고리 헤더는 매 렌더마다 새로 그려지므로 위임으로 잡는다.
   * "목표비중 수정" 링크를 먼저 확인하고 빠져나가 카드 클릭(상세 모달)과 겹치지 않게 한다.
   */
  function wireListInteractions() {
    $('list').addEventListener('click', function (e) {
      if (!e.target.closest) return;

      var btn = e.target.closest('.target-edit-btn');
      if (btn) {
        // 카드 안의 버튼이므로 카드 클릭(상세 모달)로 번지지 않게 여기서 끝낸다.
        e.stopPropagation();
        openTargetSheet(btn.dataset.scope, btn.dataset.row, btn.dataset.name, btn.dataset.target);
        return;
      }

      var card = e.target.closest('.card');
      if (card && card.dataset.row) openItemSheet(Number(card.dataset.row));
    });

    // 카드는 <article> 이라 기본 키보드 동작이 없다 — Enter/Space 를 직접 처리한다.
    $('list').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      if (!e.target.closest) return;
      if (e.target.closest('.target-edit-btn')) return;   // 버튼은 브라우저 기본 동작에 맡긴다
      var card = e.target.closest('.card');
      if (!card || !card.dataset.row) return;
      e.preventDefault();
      openItemSheet(Number(card.dataset.row));
    });
  }

  /* ── 종목 상세 모달 ─────────────────────────────── */

  /**
   * 시세 신선도(GET priceSources)는 상세 모달에서만 쓰므로 **처음 열 때 한 번** 받아 캐시한다.
   * 보유현황만 보는 사람에게 왕복을 강요하지 않기 위함(추이/주문 뷰의 지연 로드와 같은 원칙).
   * load() 가 새 포트폴리오를 받으면 캐시를 버린다.
   */
  async function ensurePriceSources() {
    if (state.priceByRow) return state.priceByRow;
    var list = await API.apiGet('priceSources');
    var map = {};
    (list || []).forEach(function (p) { map[p.row] = p; });
    state.priceByRow = map;
    return map;
  }

  function marketLabel(market) {
    if (market === 'KR') return '국내';
    if (!market) return '';
    return '해외(' + market + ')';
  }

  function detailRowHtml(label, value, cls) {
    return '<div class="detail-row' + (cls && cls.row ? ' ' + cls.row : '') + '">' +
      '<dt>' + esc(label) + '</dt>' +
      '<dd' + (cls && cls.value ? ' class="' + cls.value + '"' : '') + '>' + value + '</dd>' +
      '</div>';
  }

  /** 리밸런싱 설명. 배지는 카드와 같은 소스(rebalancePlan 우선)를 쓴다. */
  function rebalNoteHtml(item) {
    if (!item.hasCode) return '<p class="detail-rebal-note">종목코드가 없어 자동 리밸런싱 대상이 아닙니다.</p>';
    var plan = state.planByRow[item.row];
    if (plan) {
      return '<p class="detail-rebal-note">' +
        '목표 비중을 맞추려면 <b>' + esc(plan.side) + ' ' + esc(qtyFmt(plan.qty)) + '주</b>' +
        ' (약 ' + esc(won(plan.amount)) + '원, 단가 ' + esc(won(plan.price)) + '원)가 필요합니다.' +
        '</p>';
    }
    var rq = num(item.rebalQty);
    if (!rq) return '<p class="detail-rebal-note">목표 비중과의 차이가 1주 미만이라 조정이 필요하지 않습니다.</p>';
    return '<p class="detail-rebal-note">목표 대비 차액 약 ' + esc(won(Math.abs(num(item.rebalAmount)))) + '원' +
      ' (' + (rq > 0 ? '매수' : '매도') + ' ' + esc(qtyFmt(Math.abs(rq))) + '주 상당)입니다.</p>';
  }

  function openItemSheet(row) {
    var item = state.itemByRow[row];
    if (!item) return;

    // 현금(row 7, hasCode:false)은 종목 상세 대신 계좌별 현금 모달을 띄운다.
    if (!item.hasCode && (item.cashBreakdown || item.name === '현금')) { openCashSheet(item); return; }

    state.detailRow = Number(row);

    var pnlAmt = num(item.value) - num(item.invested);
    var up = pnlAmt >= 0;

    $('detailTitle').textContent = item.name;
    $('detailSub').textContent = item.catName || '';
    $('detailValue').textContent = won(item.value) + '원';
    $('detailPnl').textContent = signedWon(pnlAmt) + '원 (' + signedPct(item.pnlPct, 2) + ')';
    $('detailPnl').className = 'detail-hero-pnl ' + (up ? 'up' : 'down');

    $('detailGrid').innerHTML =
      detailRowHtml('보유수량', esc(qtyFmt(item.qty)) + '주') +
      detailRowHtml('평균단가', esc(won(item.avgPrice)) + '원') +
      detailRowHtml('현재가', esc(won(item.curPrice)) + '원') +
      detailRowHtml('투자원금', esc(won(item.invested)) + '원') +
      detailRowHtml('평가금액', esc(won(item.value)) + '원') +
      detailRowHtml('평가손익', esc(signedWon(pnlAmt)) + '원 · ' + esc(signedPct(item.pnlPct, 2)),
        { value: up ? 'up' : 'down' });

    $('detailBar').innerHTML = barInnerHtml(num(item.targetPct) * 100, num(item.curPct) * 100);
    $('detailRebal').innerHTML = badgeHtml(item) + rebalNoteHtml(item);

    var btn = $('detailTargetBtn');
    btn.hidden = false;
    btn.dataset.row = item.row;
    btn.dataset.name = item.name;
    btn.dataset.target = num(item.targetPct);

    $('detailFresh').textContent = item.hasCode ? '시세 갱신 시각을 불러오는 중…' : '';
    $('detailOverlay').hidden = false;
    $('detailCloseBtn').focus();

    if (!item.hasCode) return;
    // 신선도는 부가 정보 — 실패해도 모달 내용은 그대로 둔다.
    ensurePriceSources().then(function (map) {
      if (state.detailRow !== Number(row)) return;   // 그 사이 다른 종목을 열었다
      var src = map[row];
      if (!src) { $('detailFresh').textContent = '시세 갱신 이력이 없는 종목입니다.'; return; }
      var sub = [src.code, marketLabel(src.market), item.catName].filter(Boolean).join(' · ');
      $('detailSub').textContent = sub;
      var ago = agoText(src.lastSuccessAt);
      $('detailFresh').textContent = src.lastSuccessAt
        ? '마지막 시세 갱신: ' + (ago ? ago + ' (' + whenText(src.lastSuccessAt) + ')' : whenText(src.lastSuccessAt)) +
          ' · 마지막 성공가 ' + won(src.lastSuccessPrice) + '원'
        : '마지막 시세 갱신 기록이 없습니다.';
    }).catch(function (e) {
      if (state.detailRow !== Number(row)) return;
      $('detailFresh').textContent = '시세 갱신 시각을 불러오지 못했습니다: ' + e.message;
    });
  }

  function closeDetailSheet() {
    state.detailRow = null;
    $('detailOverlay').hidden = true;
  }

  function wireDetailSheet() {
    $('detailCloseBtn').addEventListener('click', closeDetailSheet);
    $('detailCloseX').addEventListener('click', closeDetailSheet);
    $('detailOverlay').addEventListener('click', function (e) {
      if (e.target === this) closeDetailSheet();
    });
    $('detailTargetBtn').addEventListener('click', function () {
      openTargetSheet('item', this.dataset.row, this.dataset.name, this.dataset.target);
    });
  }

  /* ── 현금 상세 모달 ─────────────────────────────── */

  var CASH_ACCOUNTS = [
    { key: '위탁종합', label: '위탁종합', note: '증권 위탁계좌 예수금' },
    { key: 'ISA', label: 'ISA', note: 'ISA 계좌 예수금' },
    { key: 'CMA', label: 'CMA', note: '직접 입력값' }
  ];

  function renderCash(cb) {
    cb = cb || {};
    var total = cb.total;
    if (total === undefined || total === null) {
      total = CASH_ACCOUNTS.reduce(function (a, acc) { return a + num(cb[acc.key]); }, 0);
    }
    $('cashTotal').textContent = won(total) + '원';

    $('cashGrid').innerHTML =
      CASH_ACCOUNTS.map(function (acc) {
        return detailRowHtml(acc.label, esc(won(cb[acc.key])) + '원');
      }).join('') +
      detailRowHtml('합계', esc(won(total)) + '원', { row: 'is-total' });

    // updatedAt 은 계약상 nullable(CASH_BREAKDOWN 프로퍼티가 비어 있으면 아예 없다).
    $('cashUpdatedAt').textContent = cb.updatedAt
      ? '마지막 갱신: ' + cb.updatedAt
      : '갱신 시각 기록이 없습니다(아직 예수금을 한 번도 조회하지 않았을 수 있습니다).';
  }

  function cashError(msg) {
    var el = $('cashError');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = msg;
  }

  function openCashSheet(item) {
    state.detailRow = item ? Number(item.row) : null;
    cashError('');
    // portfolio 응답에 이미 들어 있는 cashBreakdown 으로 즉시 그리고, 서버 값으로 한 번 더 맞춘다.
    renderCash((item && item.cashBreakdown) || {});
    $('cashSub').textContent = '계좌별 잔액' + (item && item.curPct !== undefined ? ' · 현재 비중 ' + pct(item.curPct) : '');
    $('cashOverlay').hidden = false;
    $('cashCloseBtn').focus();

    API.apiGet('cashBreakdown').then(function (cb) {
      if ($('cashOverlay').hidden) return;
      renderCash(cb);
      var cma = cb && cb.CMA;
      if (cma !== undefined && cma !== null && $('cashCmaInput').value === '') {
        $('cashCmaInput').value = Math.round(num(cma));
      }
    }).catch(function (e) {
      if ($('cashOverlay').hidden) return;
      cashError('최신 현금 내역을 불러오지 못했습니다(화면 값은 마지막 조회 기준): ' + e.message);
    });
  }

  function closeCashSheet() {
    state.detailRow = null;
    $('cashOverlay').hidden = true;
    $('cashCmaInput').value = '';
    cashError('');
  }

  function wireCashSheet() {
    $('cashCloseBtn').addEventListener('click', closeCashSheet);
    $('cashCloseX').addEventListener('click', closeCashSheet);
    $('cashOverlay').addEventListener('click', function (e) {
      if (e.target === this && !state.cashSaving) closeCashSheet();
    });

    $('cashCmaSaveBtn').addEventListener('click', async function () {
      if (state.cashSaving) return;
      var raw = $('cashCmaInput').value.trim();
      if (raw === '') { cashError('CMA 금액을 입력해주세요.'); return; }
      var v = Number(raw);
      if (!isFinite(v)) { cashError('숫자만 입력할 수 있습니다.'); return; }
      if (v < 0) { cashError('0원 이상만 입력할 수 있습니다.'); return; }

      state.cashSaving = true;
      this.disabled = true;
      cashError('');
      try {
        var cb = await API.apiPost('setManualCma', { value: v });
        if (cb && typeof cb === 'object') renderCash(cb);
        toast('CMA 잔액을 저장했습니다.');
        await load();   // 현금이 바뀌면 총자산·안전자산 비중도 바뀐다
      } catch (e) {
        cashError('저장 실패: ' + e.message);
      } finally {
        state.cashSaving = false;
        this.disabled = false;
      }
    });
  }

  /** ESC 로 상세/현금 모달 닫기(주문 확인 모달은 orders.js 가 자체 처리). */
  function wireEscape() {
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      // 위에 떠 있는 것부터 닫는다(목표비중 시트는 상세 모달 위에서 열릴 수 있다).
      if (!$('targetOverlay').hidden) { if (!state.targetSaving) closeTargetSheet(); return; }
      if (!$('cashOverlay').hidden) { if (!state.cashSaving) closeCashSheet(); return; }
      if (!$('detailOverlay').hidden) closeDetailSheet();
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

  /** 비중 바. 카드와 상세 모달이 같은 마크업을 쓴다(값이 달라 보이면 안 되기 때문). */
  function barInnerHtml(targetPct, curPct) {
    // 두 값 중 큰 쪽에 여유를 둬 목표 마커가 트랙 밖으로 나가지 않게 한다.
    var barMax = Math.max(targetPct, curPct, 10) * 1.3;
    var fillW = Math.max(0, Math.min(100, (curPct / barMax) * 100));
    var markerX = Math.max(0, Math.min(100, (targetPct / barMax) * 100));

    return '' +
      '<div class="bar-track">' +
        '<div class="bar-fill" style="width:' + fillW.toFixed(1) + '%"></div>' +
        '<div class="bar-target" style="left:' + markerX.toFixed(1) + '%"></div>' +
      '</div>' +
      '<div class="bar-labels">' +
        '<span>현재 ' + curPct.toFixed(1) + '%</span>' +
        '<span>목표 ' + targetPct.toFixed(1) + '%</span>' +
      '</div>';
  }

  function cardHtml(item) {
    var targetPct = num(item.targetPct) * 100;
    var curPct = num(item.curPct) * 100;
    var pnlAmt = num(item.value) - num(item.invested);
    var pnlUp = num(item.pnlPct) >= 0;

    // 카드 전체가 상세 모달 트리거다. <article> 이라 role/tabindex 를 직접 준다.
    return '' +
      '<article class="card is-tappable" role="button" tabindex="0"' +
        ' data-row="' + esc(item.row) + '"' +
        ' aria-label="' + esc(item.name) + ' 상세 보기">' +
        '<div class="card-top">' +
          '<div class="card-id">' +
            '<div class="card-name">' + esc(item.name) + '</div>' +
            '<div class="card-sub">' + esc(qtyFmt(item.qty)) + '주 · 평단 ' + esc(won(item.avgPrice)) + '원</div>' +
          '</div>' +
          '<div class="card-num">' +
            '<div class="card-value">' + esc(won(item.value)) + '원</div>' +
            '<div class="card-pnl ' + (pnlUp ? 'up' : 'down') + '">' + esc(signedPct(item.pnlPct)) +
              ' (' + esc(signedWon(pnlAmt)) + '원)</div>' +
          '</div>' +
        '</div>' +
        '<div class="card-meta">' +
          '<span>현재가 <b>' + esc(won(item.curPrice)) + '원</b></span>' +
          '<span>투자원금 <b>' + esc(won(item.invested)) + '원</b></span>' +
        '</div>' +
        '<div class="bar-wrap">' + barInnerHtml(targetPct, curPct) + '</div>' +
        '<div class="card-foot">' +
          badgeHtml(item) +
          '<button type="button" class="link-btn target-edit-btn"' +
            ' data-scope="item"' +
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

      // 카테고리 anchorRow = 그 카테고리의 첫 행(계약상 scope:'category' 의 row).
      // 빈 행도 카테고리 rows 에 포함되므로 필터 전 items 기준으로 최솟값을 잡는다.
      var rows = (cat.items || []).map(function (it) { return Number(it.row); })
        .filter(function (r) { return isFinite(r); });
      var anchorRow = rows.length ? Math.min.apply(null, rows) : null;

      // 카테고리 손익 = 소속 종목(빈 행 제외) 평가금액/투자원금 합. 종목 카드와 같은 계산식(value-invested).
      var catInvested = items.reduce(function (a, it) { return a + num(it.invested); }, 0);
      var catValue = items.reduce(function (a, it) { return a + num(it.value); }, 0);
      var catPnlAmt = catValue - catInvested;
      var catPnlPct = catInvested ? catPnlAmt / catInvested : 0;
      var catPnlUp = catPnlAmt >= 0;

      html += '<section class="cat-section">' +
        '<div class="cat-header">' +
          '<span class="cat-name">' + esc(cat.name) + '</span>' +
          // 카테고리 목표(A열)는 `=SUM(종목 목표)` 수식이라 직접 쓸 수 없다. 대신 scope:'category'
          // 요청이 소속 종목 목표를 비례 재분배해 합을 맞춘다 — 그래서 여기도 편집 가능하다.
          '<span class="cat-pct">목표 <b>' + esc(pct(cat.targetPct)) + '</b>' +
            '<span class="cat-ro" title="소속 종목 목표비중의 합계입니다. 수정하면 종목들이 비례 재분배됩니다.">합계</span> · ' +
            '현재 <b>' + esc(pct(cat.currentPct)) + '</b></span>' +
          '<div class="cat-pnl ' + (catPnlUp ? 'up' : 'down') + '">수익률 ' +
            esc(signedPct(catPnlPct, 2)) + ' (' + esc(signedWon(catPnlAmt)) + '원)</div>' +
          (anchorRow === null ? '' :
            '<button type="button" class="link-btn target-edit-btn cat-edit-btn"' +
              ' data-scope="category"' +
              ' data-row="' + esc(anchorRow) + '"' +
              ' data-name="' + esc(cat.name) + '"' +
              ' data-target="' + esc(num(cat.targetPct)) + '">목표비중 수정</button>') +
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

      // 상세 모달이 참조할 row 인덱스. 카테고리명은 항목에 없어서 여기서 붙여둔다.
      var byRow = {};
      (portfolio.categories || []).forEach(function (cat) {
        (cat.items || []).forEach(function (it) {
          if (!it || !it.name) return;
          byRow[it.row] = Object.assign({}, it, { catName: cat.name });
        });
      });
      state.itemByRow = byRow;
      state.priceByRow = null;   // 시세 신선도 캐시는 갱신마다 버린다

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
  wireListInteractions();
  wireDetailSheet();
  wireCashSheet();
  wireEscape();
  if (window.TrendsView) window.TrendsView.wire();
  if (window.OrdersView) window.OrdersView.wire();
  $('reloadBtn').addEventListener('click', load);
  setView('holdings');

  if (API.hasToken()) load();
  else openTokenSheet();
})();
