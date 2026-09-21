/**
 * 리밸런싱 실주문 뷰.
 *
 * ── 안전 설계 (trading-safety-review 스킬 / docs/api-contract.md "실주문 안전장치") ──
 *
 *  1. 흐름은 항상 `rebalancePlan`(읽기전용 dry-run) → 체크박스 선택 → 커스텀 확인 모달 →
 *     `executeOrders` 순서다. 이 순서를 건너뛰는 코드 경로는 존재하지 않는다.
 *  2. `API.apiPost('executeOrders', ...)` 호출은 이 파일의 `executeConfirmed()` **단 하나**뿐이고,
 *     그 함수는 `#orderConfirmBtn`(확인 모달의 확인 버튼) click 핸들러에서만 불린다.
 *     그 외에는 어디에서도 참조되지 않으며 `global.OrdersView` 로도 공개하지 않는다.
 *  3. 추가 방어로 `pendingApproval` 토큰을 둔다. 확인 모달을 여는 `openConfirm()` 만 이 값을 채우고,
 *     `executeConfirmed()` 는 값이 없으면 즉시 반환한다. 또 실행 직전에 값을 비워 재진입/더블탭으로
 *     같은 주문이 두 번 나가는 것을 막는다(백엔드에 idempotency 키가 없으므로 프론트에서 막아야 한다).
 *  4. **네이티브 `confirm()`/`alert()` 를 쓰지 않는다.** 네이티브 대화상자는 자동화 테스트를 막고
 *     UX 도 어긋난다 — 확인은 기존 오버레이/시트 패턴을 재사용한 커스텀 모달로만 한다.
 *
 * 금액 상한은 **서버가 강제한다**(`MAX_ORDER_AMOUNT_PER_ITEM`). 여기서 하는 상한 표시는
 * 사용자 안내일 뿐이며, 프론트 체크를 우회해도 서버가 KIS 호출 전에 차단한다.
 */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    plan: [],
    planLoaded: false,
    planError: null,
    selected: {},          // row(문자열 키) -> true
    limits: null,          // {maxOrderAmountPerItem, defaultMaxOrderAmountPerItem, currency, note}
    results: null,         // executeOrders 응답
    log: [],
    logError: null,
    loading: false,
    executing: false
  };

  /**
   * 확인 모달이 열릴 때만 채워지는 승인 토큰.
   * `executeConfirmed()` 가 이 값 없이는 아무 것도 하지 않는다 —
   * 모달을 거치지 않고 실행 함수에 도달하는 경로를 코드 레벨에서 한 번 더 막는 장치.
   */
  var pendingApproval = null;

  /* ── 포맷터 (app.js 와 같은 규칙) ───────────────────────── */

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function won(v) {
    if (v === null || v === undefined || v === '' || !isFinite(Number(v))) return '–';
    return Math.round(Number(v)).toLocaleString('ko-KR');
  }

  function qtyFmt(v) {
    if (v === null || v === undefined || v === '' || !isFinite(Number(v))) return '–';
    return Number(v).toLocaleString('ko-KR', { maximumFractionDigits: 4 });
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function when(iso) {
    if (!iso) return '–';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('ko-KR', { hour12: false });
  }

  function toast(msg) {
    if (global.Dashboard && global.Dashboard.toast) global.Dashboard.toast(msg);
  }

  /* ── 파생값 ─────────────────────────────────────────────── */

  function cap() {
    return state.limits ? num(state.limits.maxOrderAmountPerItem) : 0;
  }

  /** 서버 상한 초과 여부. 상한을 아직 모르면(조회 실패) 초과로 단정하지 않는다. */
  function overLimit(item) {
    var c = cap();
    return c > 0 && num(item.amount) > c;
  }

  function selectedItems() {
    return state.plan.filter(function (p) { return state.selected[String(p.row)]; });
  }

  function totalsOf(items) {
    var buy = 0, sell = 0;
    items.forEach(function (p) {
      if (p.side === '매수') buy += num(p.amount);
      else sell += num(p.amount);
    });
    return { buy: buy, sell: sell, net: buy - sell };
  }

  /* ── 계획 렌더 ──────────────────────────────────────────── */

  function renderLimitNote() {
    var el = $('orderLimitNote');
    if (!state.limits) {
      el.textContent = '주문 금액 상한을 불러오지 못했습니다 — 상한은 서버에서 그대로 강제됩니다.';
      el.classList.add('is-warn');
      return;
    }
    el.classList.remove('is-warn');
    el.innerHTML =
      '종목 1건당 <b>최대 ' + esc(won(state.limits.maxOrderAmountPerItem)) + '원</b>까지만 자동 승인됩니다. ' +
      '이 금액을 넘는 항목은 서버가 증권사 주문 API를 호출하기 전에 차단합니다(상한 변경은 앱에서 불가).';
  }

  function planRowHtml(p) {
    var key = String(p.row);
    var isBuy = p.side === '매수';
    var over = overLimit(p);
    return '' +
      '<label class="order-row' + (over ? ' is-over' : '') + '">' +
        '<input type="checkbox" class="order-check" data-row="' + esc(key) + '"' +
          (state.selected[key] ? ' checked' : '') + '>' +
        '<span class="order-row-body">' +
          '<span class="order-row-top">' +
            '<span class="order-row-name">' + esc(p.name) + '</span>' +
            '<span class="badge ' + (isBuy ? 'buy' : 'sell') + '">' + esc(p.side) + '</span>' +
          '</span>' +
          '<span class="order-row-meta">' +
            '<span>' + esc(qtyFmt(p.qty)) + '주 × ' + esc(won(p.price)) + '원</span>' +
            '<span class="order-row-amt">약 ' + esc(won(p.amount)) + '원</span>' +
          '</span>' +
          '<span class="order-row-meta order-row-faint">' +
            '<span>row ' + esc(p.row) + ' · ' + esc(p.code) + ' · ' + esc(p.market) + '</span>' +
            '<span>계좌 ' + esc(p.account) + '</span>' +
          '</span>' +
          (over
            ? '<span class="order-row-warn">상한 초과 — 선택해도 서버가 차단합니다(주문되지 않음).</span>'
            : '') +
        '</span>' +
      '</label>';
  }

  function renderPlan() {
    var list = $('orderPlanList');

    if (state.planError) {
      list.innerHTML = '<div class="empty">계획을 불러오지 못했습니다: ' + esc(state.planError) + '</div>';
    } else if (!state.planLoaded) {
      list.innerHTML = '<div class="empty">불러오는 중…</div>';
    } else if (!state.plan.length) {
      list.innerHTML = '<div class="empty">리밸런싱이 필요한 항목이 없습니다.</div>';
    } else {
      list.innerHTML = state.plan.map(planRowHtml).join('');
    }

    renderSummary();
  }

  function renderSummary() {
    var items = selectedItems();
    var box = $('orderSummary');
    var btn = $('orderExecBtn');

    btn.disabled = state.executing || items.length === 0;
    btn.textContent = state.executing
      ? '전송 중…'
      : (items.length ? '주문 실행 (' + items.length + '건)' : '주문 실행');

    if (!items.length) { box.hidden = true; box.innerHTML = ''; return; }

    var t = totalsOf(items);
    var overCount = items.filter(overLimit).length;
    box.hidden = false;
    box.innerHTML =
      '<div class="order-summary-row"><span>선택</span><b>' + items.length + '건</b></div>' +
      '<div class="order-summary-row"><span>매수 합계</span><b>' + esc(won(t.buy)) + '원</b></div>' +
      '<div class="order-summary-row"><span>매도 합계</span><b>' + esc(won(t.sell)) + '원</b></div>' +
      (overCount
        ? '<div class="order-summary-row is-warn"><span>상한 초과</span><b>' + overCount + '건 (차단 예정)</b></div>'
        : '');
  }

  /* ── 확인 모달 ──────────────────────────────────────────── */

  function openConfirm() {
    var items = selectedItems();
    if (!items.length) { toast('선택된 항목이 없습니다.'); return; }

    pendingApproval = {
      rows: items.map(function (p) { return Number(p.row); }),
      count: items.length
    };

    var t = totalsOf(items);
    $('orderConfirmList').innerHTML = items.map(function (p) {
      return '<div class="confirm-row' + (overLimit(p) ? ' is-over' : '') + '">' +
        '<span class="confirm-side ' + (p.side === '매수' ? 'buy' : 'sell') + '">' + esc(p.side) + '</span>' +
        '<span class="confirm-name">' + esc(p.name) + '</span>' +
        '<span class="confirm-qty">' + esc(qtyFmt(p.qty)) + '주</span>' +
        '<span class="confirm-amt">' + esc(won(p.amount)) + '원</span>' +
        '</div>';
    }).join('');

    $('orderConfirmTotals').innerHTML =
      '<div class="order-summary-row"><span>총 ' + items.length + '건</span>' +
      '<b>매수 ' + esc(won(t.buy)) + '원 · 매도 ' + esc(won(t.sell)) + '원</b></div>';

    $('orderConfirmLimit').textContent = state.limits
      ? '종목당 상한 ' + won(state.limits.maxOrderAmountPerItem) + '원. 초과 항목은 전송되지 않고 차단 결과로만 기록됩니다.'
      : '주문 금액 상한을 확인하지 못했습니다. 서버 상한은 그대로 적용됩니다.';

    var err = $('orderConfirmError');
    err.hidden = true;
    err.textContent = '';

    $('orderConfirmOverlay').hidden = false;
    $('orderCancelBtn').focus();
  }

  function closeConfirm() {
    pendingApproval = null;      // 승인 토큰은 모달을 벗어나는 순간 무효화한다.
    $('orderConfirmOverlay').hidden = true;
  }

  /**
   * 실주문 전송 — **확인 모달의 확인 버튼에서만 호출된다.**
   * 이 함수 밖에서는 `executeOrders` 를 호출하는 코드가 존재하지 않는다.
   */
  async function executeConfirmed() {
    if (state.executing) return;
    var approval = pendingApproval;
    // 확인 모달을 거치지 않았거나 이미 소비된 승인이면 아무 것도 하지 않는다.
    if (!approval || !approval.rows || !approval.rows.length) { closeConfirm(); return; }

    pendingApproval = null;      // 더블탭/재진입으로 같은 주문이 두 번 나가지 않게 즉시 소비.
    state.executing = true;
    $('orderConfirmBtn').disabled = true;
    $('orderCancelBtn').disabled = true;
    renderSummary();

    try {
      // approvedRows 는 계약상 **반드시 배열**(라우터가 .map(Number) 호출).
      var results = await API.apiPost('executeOrders', { approvedRows: approval.rows });
      state.results = results || [];
      $('orderConfirmOverlay').hidden = true;
      state.selected = {};
      renderResults();
      toast('주문 요청이 처리됐습니다. 결과를 확인하세요.');
      loadPlan(true);
      loadLog();
    } catch (e) {
      var err = $('orderConfirmError');
      err.hidden = false;
      err.textContent = '전송 실패: ' + e.message;
    } finally {
      state.executing = false;
      $('orderConfirmBtn').disabled = false;
      $('orderCancelBtn').disabled = false;
      renderPlan();
    }
  }

  /* ── 결과 ───────────────────────────────────────────────── */

  /**
   * 결과 1건의 상태 분류. 백엔드는 차단도 `rt_cd:'9'` 로 내려주므로 성공/차단/실패를 나눠 보여준다.
   * `request` 는 **차단 케이스에서 null** 이다(계획에 없는 row) — 절대 바로 접근하지 않는다.
   */
  function classify(r) {
    var res = r && r.response;
    var code = res && res.rt_cd !== undefined && res.rt_cd !== null ? String(res.rt_cd) : '';
    var msg = (res && (res.msg1 || res.msg_cd)) || '';
    if (code === '0') return { kind: 'ok', label: '성공', msg: msg };
    if (code === '9') return { kind: 'blocked', label: '차단', msg: msg || '서버에서 차단되었습니다.' };
    return { kind: 'fail', label: '실패', msg: msg || ('응답 코드 ' + (code || '알 수 없음')) };
  }

  function renderResults() {
    var card = $('orderResultCard');
    var list = $('orderResultList');
    if (!state.results) { card.hidden = true; list.innerHTML = ''; return; }

    card.hidden = false;
    if (!state.results.length) {
      list.innerHTML = '<div class="empty">결과가 비어 있습니다.</div>';
      return;
    }

    var counts = { ok: 0, blocked: 0, fail: 0 };
    var rows = state.results.map(function (r) {
      var c = classify(r);
      counts[c.kind]++;
      var req = r && r.request;    // null 가드 — 차단 케이스는 null 이다.
      var detail = req
        ? esc(req.side) + ' ' + esc(qtyFmt(req.qty)) + '주 · ' + esc(won(req.amount)) + '원'
        : '계획에 없는 row라 주문 정보가 없습니다.';
      return '<div class="result-row">' +
        '<span class="result-tag ' + c.kind + '">' + esc(c.label) + '</span>' +
        '<span class="result-body">' +
          '<span class="result-name">' + esc((r && r.name) || ('row ' + ((r && r.row) || '?'))) + '</span>' +
          '<span class="result-detail">' + detail + '</span>' +
          (c.msg ? '<span class="result-msg">' + esc(c.msg) + '</span>' : '') +
          (r && r.auditLogError
            ? '<span class="result-msg is-warn">감사로그 기록 실패: ' + esc(r.auditLogError) + '</span>'
            : '') +
        '</span>' +
      '</div>';
    }).join('');

    list.innerHTML =
      '<div class="result-counts">' +
        '<span class="result-tag ok">성공 ' + counts.ok + '</span>' +
        '<span class="result-tag fail">실패 ' + counts.fail + '</span>' +
        '<span class="result-tag blocked">차단 ' + counts.blocked + '</span>' +
      '</div>' + rows;
  }

  /* ── 감사로그 ───────────────────────────────────────────── */

  function renderLog() {
    var list = $('orderLogList');
    if (state.logError) {
      list.innerHTML = '<div class="empty">이력을 불러오지 못했습니다: ' + esc(state.logError) + '</div>';
      return;
    }
    if (!state.log.length) {
      list.innerHTML = '<div class="empty">기록된 주문 이력이 없습니다.</div>';
      return;
    }
    list.innerHTML = state.log.map(function (e) {
      var code = String(e.rtCd === null || e.rtCd === undefined ? '' : e.rtCd);
      var kind = code === '0' ? 'ok' : (code === '9' ? 'blocked' : 'fail');
      var label = code === '0' ? '성공' : (code === '9' ? '차단' : '실패');
      return '<div class="result-row">' +
        '<span class="result-tag ' + kind + '">' + esc(label) + '</span>' +
        '<span class="result-body">' +
          '<span class="result-name">' + esc(e.name || ('row ' + (e.row || '?'))) + '</span>' +
          '<span class="result-detail">' + esc(when(e.at)) + ' · ' +
            esc(e.side || '–') + ' ' + esc(qtyFmt(e.qty)) + '주 · ' + esc(won(e.amount)) + '원</span>' +
          (e.message ? '<span class="result-msg">' + esc(e.message) + '</span>' : '') +
        '</span>' +
      '</div>';
    }).join('');
  }

  /* ── 로딩 ───────────────────────────────────────────────── */

  async function loadLimits() {
    try {
      state.limits = await API.apiGet('orderLimits');
    } catch (e) {
      state.limits = null;
    }
    renderLimitNote();
    renderPlan();
  }

  async function loadPlan(silent) {
    if (state.loading) return;
    state.loading = true;
    $('orderReloadBtn').disabled = true;
    if (!silent) { state.planLoaded = false; renderPlan(); }

    try {
      var plan = await API.apiGet('rebalancePlan');
      state.plan = plan || [];
      state.planError = null;
      state.planLoaded = true;
      // 계획에서 사라진 row 의 선택 상태는 버린다(존재하지 않는 row 를 승인하지 않기 위해).
      var live = {};
      state.plan.forEach(function (p) { live[String(p.row)] = true; });
      Object.keys(state.selected).forEach(function (k) {
        if (!live[k]) delete state.selected[k];
      });
    } catch (e) {
      state.planError = e.message;
      state.planLoaded = true;
      state.plan = [];
    } finally {
      state.loading = false;
      $('orderReloadBtn').disabled = false;
      renderPlan();
    }
  }

  async function loadLog() {
    try {
      state.log = (await API.apiGet('orderLog', { limit: 20 })) || [];
      state.logError = null;
    } catch (e) {
      state.log = [];
      state.logError = e.message;
    }
    renderLog();
  }

  /* ── 배선 ───────────────────────────────────────────────── */

  var activated = false;

  function activate() {
    if (activated) return;
    activated = true;
    loadLimits();
    loadPlan(false);
    loadLog();
  }

  /** 목표비중이 바뀌면 계획이 달라지므로 app.js 가 이걸 호출해 다시 받아오게 한다. */
  function invalidate() {
    if (!activated) return;
    loadPlan(true);
  }

  function wire() {
    $('orderPlanList').addEventListener('change', function (e) {
      var cb = e.target.closest ? e.target.closest('.order-check') : null;
      if (!cb) return;
      var key = cb.dataset.row;
      if (cb.checked) state.selected[key] = true;
      else delete state.selected[key];
      renderSummary();
    });

    $('orderSelectAllBtn').addEventListener('click', function () {
      state.plan.forEach(function (p) { state.selected[String(p.row)] = true; });
      renderPlan();
    });

    $('orderClearBtn').addEventListener('click', function () {
      state.selected = {};
      renderPlan();
    });

    $('orderReloadBtn').addEventListener('click', function () { loadPlan(false); });
    $('orderLogReloadBtn').addEventListener('click', loadLog);

    // "주문 실행" 은 **확인 모달을 여는 것까지만** 한다. 여기서 주문이 나가지 않는다.
    $('orderExecBtn').addEventListener('click', openConfirm);

    // 실제 전송은 확인 모달의 확인 버튼에서만.
    $('orderConfirmBtn').addEventListener('click', executeConfirmed);
    $('orderCancelBtn').addEventListener('click', closeConfirm);

    // 오버레이 배경 클릭 / ESC 는 "취소"로 취급한다(확인으로 해석될 여지를 주지 않는다).
    $('orderConfirmOverlay').addEventListener('click', function (e) {
      if (e.target === this && !state.executing) closeConfirm();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('orderConfirmOverlay').hidden && !state.executing) closeConfirm();
    });
  }

  // executeConfirmed 는 의도적으로 공개하지 않는다 — 외부에서 주문을 트리거할 수 없어야 한다.
  global.OrdersView = {
    wire: wire,
    activate: activate,
    invalidate: invalidate,
    _state: state
  };
})(window);
