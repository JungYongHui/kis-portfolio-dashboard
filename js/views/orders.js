/**
 * 리밸런싱 실주문 뷰.
 *
 * ── 안전 설계 (trading-safety-review 스킬 / docs/api-contract.md "실주문 안전장치") ──
 *
 *  1. 흐름은 항상 `rebalancePlan`(읽기전용 dry-run) → 체크박스 선택 → **계획 재조회·대조** →
 *     커스텀 확인 모달 → `executeOrders` 순서다. 이 순서를 건너뛰는 코드 경로는 존재하지 않는다.
 *  2. `API.apiPost('executeOrders', ...)` 호출은 이 파일의 `executeConfirmed()` **단 하나**뿐이고,
 *     그 함수는 `#orderConfirmBtn`(확인 모달의 확인 버튼) click 핸들러에서만 불린다.
 *     그 외에는 어디에서도 참조되지 않으며 `global.OrdersView` 로도 공개하지 않는다.
 *  3. 추가 방어로 `pendingApproval` 토큰을 둔다. 확인 모달을 여는 `openConfirm()` 만 이 값을 채우고,
 *     `executeConfirmed()` 는 값이 없으면 즉시 반환한다. 또 실행 직전에 값을 비워 재진입/더블탭으로
 *     같은 주문이 두 번 나가는 것을 막는다(백엔드에 idempotency 키가 없으므로 프론트에서 막아야 한다).
 *  4. **네이티브 `confirm()`/`alert()` 를 쓰지 않는다.** 네이티브 대화상자는 자동화 테스트를 막고
 *     UX 도 어긋난다 — 확인은 기존 오버레이/시트 패턴을 재사용한 커스텀 모달로만 한다.
 *
 *  5. **승인한 값 == 전송 시점의 값**을 최대한 맞춘다(리뷰 F1). 서버(`executeOrders`)는 실행 시점에
 *     `getRebalancePlan()` 을 **새로 계산**하므로, 화면 스냅샷으로 승인하면 시세갱신/목표비중 변경
 *     때문에 승인값과 실제 주문값이 어긋날 수 있다. 그래서 "주문 실행"을 누르면 모달을 띄우기 **전에**
 *     `rebalancePlan` 을 다시 조회해 화면에 표시됐던 side/qty/amount 와 대조하고,
 *     - 달라진 게 있으면 → 경고와 함께 **최신 값으로** 모달을 렌더해 한 번 더 확인을 받는다.
 *     - 재조회 자체가 실패하면 → **주문을 진행하지 않는다.** 오래된 값으로 전송하지 않는다.
 *  6. 전송이 실패하면(리뷰 F2·F3) 승인 토큰은 이미 소비된 상태다. 모달을 닫지 않고 에러를 띄운 채
 *     확인 버튼을 숨겨, 재시도하려면 반드시 5번 흐름(재조회+재확인)을 처음부터 다시 타게 한다.
 *     네트워크 오류는 "요청이 서버에 도달해 실제로 주문이 나갔을 수도" 있으므로 감사로그를 즉시 재조회한다.
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
    planFetchedAt: null,   // state.plan 을 받아온 시각 (모달에 "언제 기준 값인지" 표시)
    selected: {},          // row(문자열 키) -> true
    limits: null,          // {maxOrderAmountPerItem, defaultMaxOrderAmountPerItem, currency, note}
    results: null,         // executeOrders 응답
    log: [],
    logError: null,
    loading: false,
    verifying: false,      // "주문 실행" 클릭 후 최신 계획을 재조회하는 중
    executing: false,
    sendFailed: false,     // 전송 실패 상태의 모달(확인 버튼을 다시 누를 수 없게 한다)
    unknownSend: null      // {at, rows} — 결과를 못 받은 전송(주문이 나갔을 수도 있음)
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

  /**
   * 승인 대상 1건의 "사용자가 화면에서 확인한 값" 지문.
   * 이 셋 중 하나라도 달라지면 승인값과 실제 주문값이 어긋나는 것이므로 재확인을 받는다.
   */
  function fingerprint(p) {
    return { row: Number(p.row), name: p.name, side: String(p.side || ''), qty: num(p.qty), amount: num(p.amount) };
  }

  function sameFingerprint(a, b) {
    return !!a && !!b && a.side === b.side && a.qty === b.qty && a.amount === b.amount;
  }

  function fpText(f) {
    return f ? (f.side + ' ' + qtyFmt(f.qty) + '주 · ' + won(f.amount) + '원') : '계획에 없음';
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

    btn.disabled = state.executing || state.verifying || items.length === 0;
    btn.textContent = state.executing
      ? '전송 중…'
      : state.verifying
        ? '최신 계획 확인 중…'
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

  function setExecNotice(msg) {
    var el = $('orderExecNotice');
    el.hidden = !msg;
    el.textContent = msg || '';
  }

  /**
   * "주문 실행" 버튼의 핸들러. **여기서 주문이 나가지 않는다.**
   *
   * 서버는 실행 시점에 계획을 새로 계산하므로(F1), 모달을 띄우기 전에 `rebalancePlan` 을 다시 받아
   * 화면에 표시됐던 값과 대조한다. 재조회에 실패하면 오래된 값으로 진행하지 않고 **막는다**.
   */
  async function requestConfirm() {
    if (state.executing || state.verifying) return;
    if (state.loading) { toast('계획을 불러오는 중입니다. 잠시 후 다시 눌러주세요.'); return; }

    var items = selectedItems();
    if (!items.length) { toast('선택된 항목이 없습니다.'); return; }

    // 사용자가 화면에서 보고 고른 값(스냅샷). 재조회 결과는 이것과 대조한다.
    var before = {};
    items.forEach(function (p) { before[String(p.row)] = fingerprint(p); });
    var keys = Object.keys(before);

    setExecNotice(null);
    state.verifying = true;
    state.loading = true;
    $('orderReloadBtn').disabled = true;
    renderSummary();

    var fresh;
    try {
      fresh = await API.apiGet('rebalancePlan');
    } catch (e) {
      // 최신 계획을 모르는 채로는 절대 전송하지 않는다.
      setExecNotice('최신 계획을 확인할 수 없어 주문을 진행하지 않습니다 — ' + e.message +
        ' 잠시 후 “계획 새로고침”으로 다시 시도해주세요.');
      toast('최신 계획을 확인할 수 없어 주문을 진행하지 않습니다.');
      return;
    } finally {
      state.verifying = false;
      state.loading = false;
      $('orderReloadBtn').disabled = false;
      renderSummary();
    }

    applyPlan(fresh);            // state.plan/planFetchedAt 갱신 + 사라진 row 선택 해제
    renderPlan();

    // 재조회 결과 기준으로 승인 대상과 변경점을 다시 만든다.
    var after = {};
    state.plan.forEach(function (p) {
      if (before[String(p.row)]) after[String(p.row)] = fingerprint(p);
    });

    var changes = {};            // row 키 -> {before, after|null}
    var changedCount = 0, removedCount = 0;
    keys.forEach(function (k) {
      if (sameFingerprint(before[k], after[k])) return;
      changes[k] = { before: before[k], after: after[k] || null };
      changedCount++;
      if (!after[k]) removedCount++;
    });

    var liveItems = state.plan.filter(function (p) { return after[String(p.row)]; });
    if (!liveItems.length) {
      setExecNotice('선택했던 항목이 최신 계획에서 모두 사라졌습니다 — 주문하지 않았습니다. 계획을 다시 확인해주세요.');
      toast('최신 계획에 해당 항목이 없어 주문을 진행하지 않습니다.');
      return;
    }

    openConfirm(liveItems, changes, changedCount, removedCount);
  }

  /** 확인 모달을 **최신 계획 값으로** 렌더한다. `requestConfirm()` 에서만 호출된다. */
  function openConfirm(items, changes, changedCount, removedCount) {
    pendingApproval = {
      rows: items.map(function (p) { return Number(p.row); }),
      count: items.length
    };

    var banner = $('orderConfirmChanged');
    if (changedCount) {
      banner.hidden = false;
      banner.innerHTML =
        '<b>계획이 갱신되었습니다 — 아래 값으로 다시 확인해주세요.</b><br>' +
        '방금 다시 조회한 계획에서 ' + changedCount + '건이 조금 전 화면에 표시됐던 값과 달라졌습니다' +
        (removedCount ? ' (그중 ' + removedCount + '건은 계획에서 빠져 주문 대상에서 제외했습니다)' : '') + '.';
    } else {
      banner.hidden = true;
      banner.innerHTML = '';
    }

    var t = totalsOf(items);
    $('orderConfirmList').innerHTML = items.map(function (p) {
      var ch = changes[String(p.row)];
      return '<div class="confirm-row' + (overLimit(p) ? ' is-over' : '') + (ch ? ' is-changed' : '') + '">' +
        '<span class="confirm-side ' + (p.side === '매수' ? 'buy' : 'sell') + '">' + esc(p.side) + '</span>' +
        '<span class="confirm-name">' + esc(p.name) + '</span>' +
        '<span class="confirm-qty">' + esc(qtyFmt(p.qty)) + '주</span>' +
        '<span class="confirm-amt">' + esc(won(p.amount)) + '원</span>' +
        '</div>' +
        (ch
          ? '<div class="confirm-prev">변경됨 — 조금 전 표시값: ' + esc(fpText(ch.before)) + '</div>'
          : '');
    }).join('');

    $('orderConfirmTotals').innerHTML =
      '<div class="order-summary-row"><span>총 ' + items.length + '건</span>' +
      '<b>매수 ' + esc(won(t.buy)) + '원 · 매도 ' + esc(won(t.sell)) + '원</b></div>';

    $('orderConfirmFresh').textContent =
      '위 값은 ' + when(state.planFetchedAt && state.planFetchedAt.toISOString()) + ' 에 다시 조회한 계획 기준입니다. ' +
      '서버는 전송 시점의 계획으로 한 번 더 계산해 주문합니다.';

    $('orderConfirmLimit').textContent = state.limits
      ? '종목당 상한 ' + won(state.limits.maxOrderAmountPerItem) + '원. 초과 항목은 전송되지 않고 차단 결과로만 기록됩니다.'
      : '주문 금액 상한을 확인하지 못했습니다. 서버 상한은 그대로 적용됩니다.';

    resetConfirmButtons();

    var err = $('orderConfirmError');
    err.hidden = true;
    err.innerHTML = '';

    $('orderConfirmOverlay').hidden = false;
    $('orderCancelBtn').focus();
  }

  /** 확인/취소 버튼을 "아직 전송 전" 상태로 되돌린다. */
  function resetConfirmButtons() {
    state.sendFailed = false;
    var ok = $('orderConfirmBtn');
    var cancel = $('orderCancelBtn');
    ok.hidden = false;
    ok.disabled = false;
    cancel.disabled = false;
    cancel.textContent = '취소';
  }

  function closeConfirm() {
    pendingApproval = null;      // 승인 토큰은 모달을 벗어나는 순간 무효화한다.
    $('orderConfirmOverlay').hidden = true;
    resetConfirmButtons();
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
      resetConfirmButtons();
      state.selected = {};
      state.unknownSend = null;
      renderLogWarn();
      renderResults();
      toast('주문 요청이 처리됐습니다. 결과를 확인하세요.');
      loadPlan(true);
      loadLog();
    } catch (e) {
      // 토큰이 없어 fetch 전에 실패한 경우를 빼면, 요청이 서버에 도달해 **주문이 실제로 나갔을 수도** 있다.
      // (백엔드는 이런 예외도 감사로그에 남긴다 — docs/api-contract.md "실주문 안전장치")
      var maybeSent = !(e && e.code === 'no_token');

      if (maybeSent) {
        state.unknownSend = { at: new Date(), rows: approval.rows.slice() };
        renderLogWarn();
        loadLog();               // 사용자가 확인해야 할 바로 그 정보를 즉시 갱신한다.
      }

      // 승인 토큰은 이미 소비됐다. 확인 버튼을 다시 누르면 아무 일도 안 일어나는 것처럼 보이므로
      // 버튼을 숨기고, 재시도는 "주문 실행"부터 다시(= 계획 재조회부터) 타도록 안내한다.
      state.sendFailed = true;
      $('orderConfirmBtn').hidden = true;
      $('orderCancelBtn').textContent = '닫기';

      var err = $('orderConfirmError');
      err.hidden = false;
      err.innerHTML = maybeSent
        ? '<b>네트워크 오류로 결과를 확인할 수 없습니다 — 주문이 실제로 전송됐을 수 있습니다.</b><br>' +
          '(' + esc(e.message) + ')<br>' +
          '아래 “주문 이력(감사로그)”을 꼭 확인하세요 — 방금 자동으로 다시 불러왔습니다. ' +
          '이력을 확인하기 전에는 재시도하지 마세요(중복 주문이 됩니다).<br>' +
          '재시도하려면 이 창을 닫고 “주문 실행”을 처음부터 다시 누르세요 — 최신 계획을 다시 확인합니다.'
        : '<b>전송하지 못했습니다 — 주문은 나가지 않았습니다.</b><br>' +
          '(' + esc(e.message) + ')<br>' +
          '이 창을 닫고 토큰을 확인한 뒤 “주문 실행”을 다시 누르세요.';

      toast(maybeSent
        ? '전송 결과를 확인할 수 없습니다 — 주문 이력을 확인하세요.'
        : '전송 실패: ' + e.message);
    } finally {
      state.executing = false;
      // 실패 상태에서는 확인 버튼을 되살리지 않는다(승인 토큰이 이미 소비돼 무의미한 클릭이 된다).
      if (!state.sendFailed) $('orderConfirmBtn').disabled = false;
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

  /**
   * 결과를 못 받은 전송이 있으면 감사로그 카드 위에 경고를 남긴다.
   * 모달을 닫은 뒤에도 "확인해야 한다"는 사실이 사라지지 않도록 뷰에 붙여 둔다.
   */
  function renderLogWarn() {
    var el = $('orderLogWarn');
    if (!state.unknownSend) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent =
      when(state.unknownSend.at.toISOString()) + ' 전송한 ' + state.unknownSend.rows.length +
      '건(row ' + state.unknownSend.rows.join(', ') + ')의 결과를 받지 못했습니다. ' +
      '주문이 실제로 전송됐을 수 있으니 아래 이력에서 해당 row 를 반드시 확인하세요.';
  }

  function renderLog() {
    var list = $('orderLogList');
    renderLogWarn();
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

  /** 새로 받은 계획을 state 에 반영한다(`loadPlan` 과 "주문 실행" 직전 재조회가 함께 쓴다). */
  function applyPlan(plan) {
    state.plan = plan || [];
    state.planError = null;
    state.planLoaded = true;
    state.planFetchedAt = new Date();
    // 계획에서 사라진 row 의 선택 상태는 버린다(존재하지 않는 row 를 승인하지 않기 위해).
    var live = {};
    state.plan.forEach(function (p) { live[String(p.row)] = true; });
    Object.keys(state.selected).forEach(function (k) {
      if (!live[k]) delete state.selected[k];
    });
  }

  async function loadPlan(silent) {
    if (state.loading) return;
    state.loading = true;
    $('orderReloadBtn').disabled = true;
    if (!silent) { state.planLoaded = false; renderPlan(); }
    setExecNotice(null);

    try {
      applyPlan(await API.apiGet('rebalancePlan'));
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
      setExecNotice(null);
      renderSummary();
    });

    $('orderSelectAllBtn').addEventListener('click', function () {
      state.plan.forEach(function (p) { state.selected[String(p.row)] = true; });
      setExecNotice(null);
      renderPlan();
    });

    $('orderClearBtn').addEventListener('click', function () {
      state.selected = {};
      setExecNotice(null);
      renderPlan();
    });

    $('orderReloadBtn').addEventListener('click', function () { loadPlan(false); });
    $('orderLogReloadBtn').addEventListener('click', loadLog);

    // "주문 실행" 은 **계획 재조회 + 확인 모달 열기까지만** 한다. 여기서 주문이 나가지 않는다.
    $('orderExecBtn').addEventListener('click', requestConfirm);

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
