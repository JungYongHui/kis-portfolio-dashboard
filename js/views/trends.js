/**
 * 추이 분석 뷰 — 대상 다중선택 × 기간 × 집계단위, 벤치마크 비교, what-if 투영, 배분 도넛.
 *
 * 데이터 원칙(docs/api-contract.md + dashboard-frontend-build 스킬):
 *  - 서버에서 받는 건 항상 raw daily(`history`, `benchmarkHistory`)뿐이다.
 *    주/월/년 집계, 100 기준 정규화, 복리 투영은 전부 여기(클라이언트)에서 한다 —
 *    뷰 옵션을 바꿀 때 서버 왕복이 없어야 즉시 반응한다.
 *  - 비율 필드(targetPct/currentPct/curPct)는 분수(0.153 = 15.3%)다. 표시할 때만 ×100.
 *  - estimated:true 구간은 점선 + 옅은 색으로 실측과 구분한다(숨기지 않는다).
 *
 * benchmarkHistory 는 백엔드에서 아직 구현 중일 수 있다(계약 문서상 Phase 4, 미구현).
 * 호출은 계약 shape([{date,symbol,close,estimated?}])에 맞춰 두되, 실패해도 추이 화면
 * 전체가 깨지지 않도록 try/catch 로 감싸고 부드러운 폴백 메시지만 띄운다.
 */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var C = global.Charts;

  var TOTAL_KEY = '__total__';
  /** 빈 값이 "0원"으로 둔갑하지 않게 — 값 없음은 NaN 으로 떨어뜨린다(charts.num 과 같은 규칙). */
  function num(v) {
    if (v === null || v === undefined || v === '') return NaN;
    return Number(v);
  }
  // 기준선이 5개 이상이면 선보다 잡음이 많아진다 — 그 이상은 선을 접고 아래 숫자 요약만 남긴다.
  var MAX_REF_LINES = 4;

  var CATEGORY_ORDER = ['안전자산', '배당자산', '투자자산', '미국'];

  var state = {
    portfolio: null,
    history: [],            // 정규화된 raw daily(+ 종목별 이력이 item#<row> 키로 병합된 상태)
    historyError: null,
    historyLoaded: false,
    itemRows: [],           // itemHistory 원본 [{date,row,code,value,estimated}]
    itemError: null,        // itemHistory 전용 — history 와 독립적으로 실패할 수 있다
    itemLoaded: false,
    itemLatestDate: '',     // 종목별 이력이 커버하는 마지막 날짜(카테고리보다 짧을 수 있다)
    itemSkippedDates: [],
    loading: false,

    selected: {},           // entityKey -> true
    range: '1y',
    unit: 'day',
    mode: 'abs',            // 'abs' | 'pct'

    benchmark: '',          // '' = 사용 안 함
    benchmarkRows: null,
    benchmarkNote: '',

    projBase: TOTAL_KEY,
    projMonths: 36,
    projRateUnit: 'annual',  // 'annual' | 'monthly'
    scenarios: [
      { id: 'cons', name: '보수', rate: 3 },
      { id: 'base', name: '목표', rate: 7 },
      { id: 'opt', name: '낙관', rate: 12 }
    ],

    showTrendTable: false,
    showAllocTable: false
  };

  // 색은 엔티티에 고정 배정 — 선택을 지워도 남은 시리즈 색이 바뀌지 않는다.
  var slots = new C.SlotRegistry();
  var charts = { trend: null, proj: null };
  var forceRedraw = function () {};   // wire() 에서 실제 구현으로 교체

  /* ── 엔티티 ─────────────────────────────────────────────── */

  /** 선택 가능한 대상 목록. field = history 행에서 읽을 키(없으면 추이 불가). */
  function entities() {
    var out = [{ key: TOTAL_KEY, name: '전체자산', field: 'total', kind: 'total' }];
    var cats = (state.portfolio && state.portfolio.categories) || [];
    var ordered = CATEGORY_ORDER.filter(function (n) {
      return cats.some(function (c) { return c.name === n; });
    }).concat(cats.map(function (c) { return c.name; }).filter(function (n) {
      return CATEGORY_ORDER.indexOf(n) === -1;
    }));
    ordered.forEach(function (name) {
      out.push({ key: 'cat:' + name, name: name, field: name, kind: 'category' });
    });
    cats.forEach(function (cat) {
      (cat.items || []).forEach(function (it) {
        if (!it.name) return;
        // field 는 종목명이 아니라 row 네임스페이스 키 — 종목명이 카테고리명과 겹치거나
        // 같은 이름이 두 카테고리에 있어도 서로를 덮지 않는다(charts.mergeItemHistory 참조).
        out.push({
          key: 'item:' + cat.name + ':' + it.row,
          name: it.name, field: C.itemField(it.row), estField: C.itemEstField(it.row),
          kind: 'item', row: it.row,
          value: Number(it.value) || 0,
          invested: num(it.invested),          // 평단가×수량 — 매매가 있을 때만 바뀌는 상수
          category: cat.name
        });
      });
    });
    return out;
  }

  /** history 행에 해당 필드가 실제로 존재하는가(= 추이 선을 그릴 수 있는가). */
  function fieldAvailable(field) {
    return state.history.some(function (r) {
      return Object.prototype.hasOwnProperty.call(r, field) && isFinite(Number(r[field]));
    });
  }

  /**
   * 이 행에서 이 엔티티가 추정치인가.
   * 종목은 자기 플래그(est#<row>)를 쓴다 — 같은 날짜라도 카테고리는 실측인데 종목만
   * 백필 추정인 경우가 실제로 있다(staging 2026-08-26). 플래그가 없으면 행 공용값.
   */
  function estimatedOf(row, ent) {
    if (ent && ent.estField && Object.prototype.hasOwnProperty.call(row, ent.estField)) {
      return !!row[ent.estField];
    }
    return !!row.estimated;
  }

  /** 엔티티 하나의 시계열 포인트. */
  function pointsOf(rows, ent) {
    return rows.map(function (r) {
      var v = Number(r[ent.field]);
      return { date: r.date, value: isFinite(v) ? v : null, estimated: estimatedOf(r, ent) };
    });
  }

  function currentValueOf(ent) {
    if (!state.portfolio) return 0;
    if (ent.kind === 'total') return Number(state.portfolio.total) || 0;
    if (ent.kind === 'item') return ent.value || 0;
    var cat = (state.portfolio.categories || []).filter(function (c) { return c.name === ent.name; })[0];
    if (!cat) return 0;
    return (cat.items || []).reduce(function (a, it) { return a + (Number(it.value) || 0); }, 0);
  }

  /**
   * 투자원금(평단가 × 수량 합계). 매수/매도 때만 바뀌므로 **일별 이력이 없다** —
   * 시계열 선이 아니라 현재 시점 상수(가로 기준선)로만 쓴다.
   * 값이 없으면(현금성 항목 등) NaN 을 돌려 기준선을 아예 그리지 않는다 — 0원 선을 그리면 거짓말이 된다.
   */
  function investedOf(ent) {
    if (!state.portfolio) return NaN;
    if (ent.kind === 'total') return num(state.portfolio.invested);
    if (ent.kind === 'item') return num(ent.invested);
    var cat = (state.portfolio.categories || []).filter(function (c) { return c.name === ent.name; })[0];
    if (!cat) return NaN;
    var any = false;
    var sum = (cat.items || []).reduce(function (a, it) {
      var v = num(it.invested);
      if (!isFinite(v)) return a;
      any = true;
      return a + v;
    }, 0);
    return any ? sum : NaN;
  }

  /* ── 시리즈 구성 ─────────────────────────────────────────── */

  function baseRows() {
    return C.aggregate(C.sliceRange(state.history, state.range), state.unit);
  }

  function trendSeries() {
    var rows = baseRows();
    var list = [];
    entities().forEach(function (ent) {
      if (!state.selected[ent.key]) return;
      if (!fieldAvailable(ent.field)) return;
      var pts = pointsOf(rows, ent);
      if (state.mode === 'pct') pts = C.rebase(pts);
      var slot = slots.assign(ent.key);
      list.push({
        id: ent.key,
        name: ent.name,
        color: slot ? 'var(--series-' + slot + ')' : 'var(--viz-muted)',
        points: pts,
        entity: ent
      });
    });

    // 벤치마크는 카테고리 슬롯을 쓰지 않는다 — 비교 기준(맥락)이지 보유 대상이 아니다.
    // 뮤트 색 + 점선으로 "내 자산이 아님"을 형태로도 구분한다.
    if (state.benchmark && state.benchmarkRows && state.benchmarkRows.length) {
      var brows = C.aggregate(C.sliceRange(state.benchmarkRows, state.range), state.unit);
      var bpts = brows.map(function (r) {
        var v = Number(r.close);
        return { date: r.date, value: isFinite(v) ? v : null, estimated: !!r.estimated };
      });
      // 스케일이 다르므로 반드시 정규화 축 위에서만 겹친다(dual-axis 금지).
      bpts = C.rebase(bpts);
      list.push({
        id: 'bm', name: state.benchmark + ' (벤치마크)',
        color: 'var(--viz-muted)', points: bpts, dash: true, muted: true
      });
    }
    return list;
  }

  /**
   * 그려진 시리즈별 "투자원금 ↔ 현재 평가금액" 비교.
   * 벤치마크(entity 없음)는 내 보유가 아니므로 제외한다.
   * 격차는 차트의 두 선 사이 간격과 반드시 같은 값이어야 하므로 여기서 한 번만 계산해
   * 기준선과 텍스트 요약이 같은 숫자를 쓰게 한다(API 의 totalPnl 과도 일치 확인됨).
   */
  function costBasisRows(series) {
    var out = [];
    series.forEach(function (s) {
      if (!s.entity) return;
      var inv = investedOf(s.entity);
      if (!isFinite(inv) || inv <= 0) return;
      var cur = currentValueOf(s.entity);
      out.push({
        id: s.id, name: s.name, color: s.color,
        invested: inv, value: cur, diff: cur - inv, pct: (cur - inv) / inv
      });
    });
    return out;
  }

  function projectionSeries() {
    var ents = entities();
    var ent = ents.filter(function (e) { return e.key === state.projBase; })[0] || ents[0];
    var base = currentValueOf(ent);

    var rows = baseRows();
    var actual = [];
    if (fieldAvailable(ent.field)) {
      actual = pointsOf(rows, ent).filter(function (p) { return p.value !== null; });
    }

    var startDate = actual.length ? actual[actual.length - 1].date
      : new Date().toISOString().slice(0, 10);
    // 투영 시작값은 실제 추이의 마지막 값과 이어져야 선이 끊겨 보이지 않는다.
    var startValue = actual.length ? actual[actual.length - 1].value : base;

    var list = [];
    if (actual.length) {
      list.push({
        id: 'actual', name: '실제 추이',
        color: 'var(--viz-muted)', points: actual, muted: true
      });
    }

    state.scenarios.forEach(function (sc, i) {
      var annual = state.projRateUnit === 'monthly'
        ? (Math.pow(1 + Number(sc.rate) / 100, 12) - 1) * 100
        : Number(sc.rate);
      if (!isFinite(annual)) return;
      var vals = C.projectGrowth(startValue, annual, state.projMonths);
      var pts = [{ date: startDate, value: startValue }].concat(vals.map(function (v, j) {
        return { date: C.addMonths(startDate, j + 1), value: v };
      }));
      list.push({
        id: sc.id,
        name: sc.name + ' ' + (Number(sc.rate) >= 0 ? '+' : '') + Number(sc.rate) + '%/' +
          (state.projRateUnit === 'monthly' ? '월' : '년'),
        color: 'var(--proj-' + (i + 1) + ')',
        points: pts,
        dash: true
      });
    });
    return { series: list, entity: ent, startValue: startValue, startDate: startDate };
  }

  /* ── 컨트롤 렌더링 ───────────────────────────────────────── */

  function makeToggleGroup(host, options, value, onPick, groupLabel) {
    host.innerHTML = '';
    host.setAttribute('role', 'group');
    if (groupLabel) host.setAttribute('aria-label', groupLabel);
    options.forEach(function (opt) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn';
      b.textContent = opt.label;
      b.setAttribute('aria-pressed', String(opt.value === value));
      if (opt.disabled) { b.disabled = true; b.title = opt.title || ''; }
      b.addEventListener('click', function () { onPick(opt.value); });
      host.appendChild(b);
    });
  }

  function renderTargetPicker() {
    var host = $('targetPicker');
    host.innerHTML = '';
    var ents = entities();
    var groups = [
      { label: '전체 / 카테고리', list: ents.filter(function (e) { return e.kind !== 'item'; }) },
      { label: '개별 종목', list: ents.filter(function (e) { return e.kind === 'item'; }) }
    ];
    // 체크박스 id 고유 시퀀스. ent.key(예: 'cat:안전자산')를 /[^\w]/g로 정규화하면
    // \w가 한글을 매치하지 못해 한글 부분이 전부 '_'로 뭉개진다 — "안전자산"/"배당자산"/
    // "투자자산"처럼 글자 수가 같은 카테고리 이름은 전부 동일한 id로 충돌했고, 그 결과
    // label[for=id]가 문서상 첫 번째로 렌더링된 요소(안전자산)로만 매핑돼 버렸다
    // ("뭘 클릭해도 안전자산만 눌린다" 버그의 원인). 숫자 시퀀스는 언어와 무관하게 항상 고유하다.
    var chipSeq = 0;

    groups.forEach(function (grp) {
      if (!grp.list.length) return;
      var wrap = document.createElement('div');
      wrap.className = 'pick-group';
      var h = document.createElement('div');
      h.className = 'pick-group-title';
      h.textContent = grp.label;
      wrap.appendChild(h);

      var box = document.createElement('div');
      box.className = 'pick-chips';
      grp.list.forEach(function (ent) {
        var available = fieldAvailable(ent.field);
        var id = 'pick_' + (chipSeq++);
        var lab = document.createElement('label');
        lab.className = 'pick-chip' + (available ? '' : ' is-unavailable');
        lab.htmlFor = id;
        if (!available) {
          lab.title = ent.kind === 'item'
            ? (state.itemLoaded
              ? '이 종목은 종목별 이력(itemHistory)에 일별 데이터가 없습니다' +
                '(현금처럼 종목코드가 없는 항목 등). 투영 차트의 기준값으로는 사용할 수 있습니다.'
              : '종목별 이력을 불러오는 중입니다.')
            : 'history 응답에 이 대상의 일별 컬럼이 없어 추이를 그릴 수 없습니다. ' +
              '투영 차트의 기준값으로는 사용할 수 있습니다.';
        }

        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = id;
        cb.checked = !!state.selected[ent.key];
        cb.disabled = !available;
        cb.addEventListener('change', function () {
          if (cb.checked) {
            var count = Object.keys(state.selected).filter(function (k) { return state.selected[k]; }).length;
            if (count >= C.MAX_SLOTS) {
              cb.checked = false;
              global.Dashboard.toast('한 번에 최대 ' + C.MAX_SLOTS + '개까지 겹쳐 볼 수 있습니다.');
              return;
            }
            state.selected[ent.key] = true;
            slots.assign(ent.key);
          } else {
            delete state.selected[ent.key];   // 슬롯은 반납하지 않는다 — 색이 엔티티에 붙어 있어야 한다.
          }
          renderTargetPicker();
          renderTrend();
        });

        var swatchSlot = slots.get(ent.key);
        var sw = document.createElement('span');
        sw.className = 'pick-swatch';
        if (swatchSlot) sw.style.background = 'var(--series-' + swatchSlot + ')';

        var nm = document.createElement('span');
        nm.className = 'pick-name';
        nm.textContent = ent.name;

        lab.appendChild(cb); lab.appendChild(sw); lab.appendChild(nm);
        box.appendChild(lab);
      });
      wrap.appendChild(box);

      if (grp.label === '개별 종목' && grp.list.length) {
        var avail = grp.list.filter(function (e) { return fieldAvailable(e.field); }).length;
        var text = '';
        if (state.itemError) {
          text = '종목별 이력을 불러오지 못했습니다: ' + state.itemError +
            ' — 전체/카테고리 추이는 그대로 표시됩니다. 종목은 아래 투영 차트의 기준값으로만 선택할 수 있습니다.';
        } else if (!state.itemLoaded) {
          text = '종목별 일별 이력을 불러오는 중…';
        } else if (!avail) {
          text = '종목별 일별 이력이 아직 없습니다(백필/일간 스냅샷 이후 표시됩니다). ' +
            '아래 투영 차트의 기준값으로는 선택할 수 있습니다.';
        } else if (avail < grp.list.length) {
          text = grp.list.length + '개 중 ' + avail + '개 종목에 일별 이력이 있습니다. ' +
            '나머지(종목코드가 없는 현금성 항목 등)는 투영 기준값으로만 선택할 수 있습니다.';
        }
        if (state.itemLatestDate && state.history.length &&
            state.itemLatestDate < state.history[state.history.length - 1].date) {
          text += (text ? ' ' : '') + '종목별 이력은 ' + state.itemLatestDate + '까지 반영돼 있습니다.';
        }
        if (text) {
          var note = document.createElement('p');
          note.className = 'viz-note';
          note.textContent = text;
          wrap.appendChild(note);
        }
      }
      host.appendChild(wrap);
    });
  }

  function renderControls() {
    makeToggleGroup($('rangeSeg'), [
      { label: '1주', value: '1w' }, { label: '1개월', value: '1m' }, { label: '3개월', value: '3m' },
      { label: '6개월', value: '6m' }, { label: '1년', value: '1y' }, { label: '전체', value: 'all' }
    ], state.range, function (v) { state.range = v; renderControls(); renderTrend(); renderProjection(); }, '기간');

    makeToggleGroup($('unitSeg'), [
      { label: '일간', value: 'day' }, { label: '주간', value: 'week' },
      { label: '월간', value: 'month' }, { label: '연간', value: 'year' }
    ], state.unit, function (v) { state.unit = v; renderControls(); renderTrend(); renderProjection(); }, '집계 단위');

    var bmOn = !!state.benchmark;
    makeToggleGroup($('modeSeg'), [
      {
        label: '절대금액', value: 'abs', disabled: bmOn,
        title: bmOn ? '벤치마크와 겹칠 때는 스케일이 달라 수익률(100 기준)로만 비교합니다.' : ''
      },
      { label: '수익률(%)', value: 'pct' }
    ], state.mode, function (v) { state.mode = v; renderControls(); renderTrend(); }, '표시 방식');

    $('benchmarkSelect').value = state.benchmark;

    $('projMonths').value = String(state.projMonths);
    makeToggleGroup($('rateUnitSeg'), [
      { label: '연 %', value: 'annual' }, { label: '월 %', value: 'monthly' }
    ], state.projRateUnit, function (v) {
      state.projRateUnit = v; renderControls(); renderProjection();
    }, '수익률 단위');
  }

  function renderProjBaseOptions() {
    var sel = $('projBase');
    var prev = state.projBase;
    sel.innerHTML = '';
    entities().forEach(function (ent) {
      var o = document.createElement('option');
      o.value = ent.key;
      o.textContent = ent.kind === 'item' ? '  · ' + ent.name : ent.name;
      sel.appendChild(o);
    });
    sel.value = prev;
    if (!sel.value) { sel.value = TOTAL_KEY; state.projBase = TOTAL_KEY; }
  }

  function renderScenarioInputs() {
    var host = $('scenarioInputs');
    host.innerHTML = '';
    state.scenarios.forEach(function (sc, i) {
      var f = document.createElement('label');
      f.className = 'scenario-field';
      var key = document.createElement('span');
      key.className = 'scenario-key';
      key.style.background = 'var(--proj-' + (i + 1) + ')';
      var nm = document.createElement('span');
      nm.className = 'scenario-name';
      nm.textContent = sc.name;
      var inp = document.createElement('input');
      inp.type = 'number';
      inp.step = '0.1';
      inp.value = String(sc.rate);
      inp.inputMode = 'decimal';
      inp.setAttribute('aria-label', sc.name + ' 시나리오 가정 수익률');
      // 입력이 바뀌면 즉시 재계산 — 서버 왕복 없음.
      inp.addEventListener('input', function () {
        var v = parseFloat(inp.value);
        sc.rate = isFinite(v) ? v : 0;
        renderProjection();
      });
      var unit = document.createElement('span');
      unit.className = 'scenario-unit';
      unit.textContent = '%';
      f.appendChild(key); f.appendChild(nm); f.appendChild(inp); f.appendChild(unit);
      host.appendChild(f);
    });
  }

  /* ── 범례 / 표 ───────────────────────────────────────────── */

  function renderLegend(host, series) {
    host.innerHTML = '';
    // 시리즈가 2개 이상이면 범례는 항상 제공한다(색만으로 식별하게 두지 않는다).
    if (series.length < 2) { host.hidden = true; return; }
    host.hidden = false;
    series.forEach(function (s) {
      var item = document.createElement('span');
      item.className = 'viz-legend-item';
      var key = document.createElement('span');
      key.className = 'viz-legend-key' + (s.dash ? ' is-dash' : '');
      key.style.background = s.color;
      var nm = document.createElement('span');
      nm.textContent = s.name;              // API 문자열 — textContent 로만
      item.appendChild(key); item.appendChild(nm);
      host.appendChild(item);
    });
  }

  /** 투자원금 대비 손익 한 줄씩 — 차트의 격차를 색 없이도 읽을 수 있게 하는 relief. */
  function renderPnlSummary(host, rows, linesShown) {
    host.innerHTML = '';
    if (!rows.length) { host.hidden = true; return; }
    host.hidden = false;
    rows.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'viz-pnl-row';
      if (linesShown) {
        var key = document.createElement('span');
        key.className = 'viz-pnl-key';
        key.style.color = r.color;              // 점선 키 — 차트의 기준선과 같은 형태·색
        row.appendChild(key);
      }
      var nm = document.createElement('span');
      nm.className = 'viz-pnl-name';
      nm.textContent = r.name;                  // API 문자열 — textContent 로만
      var txt = document.createElement('span');
      txt.textContent = '투자원금 ' + C.fullWon(r.invested) + ' 대비';
      var val = document.createElement('b');
      val.className = 'viz-pnl-val ' + (r.diff >= 0 ? 'up' : 'down');
      val.textContent = (r.diff >= 0 ? '+' : '') + C.fullWon(r.diff) +
        ' (' + (r.pct >= 0 ? '+' : '') + (r.pct * 100).toFixed(2) + '%)';
      row.appendChild(nm); row.appendChild(txt); row.appendChild(val);
      host.appendChild(row);
    });
  }

  /** 표 보기 — light 모드 팔레트의 contrast WARN 에 대한 relief(모든 값이 색 없이 읽힌다). */
  function renderTable(host, series, fmt) {
    host.innerHTML = '';
    if (!series.length) return;
    var dates = {};
    series.forEach(function (s) { s.points.forEach(function (p) { if (p.value !== null) dates[p.date] = 1; }); });
    var keys = Object.keys(dates).sort();

    var table = document.createElement('table');
    table.className = 'viz-table';
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    ['날짜'].concat(series.map(function (s) { return s.name; })).forEach(function (h) {
      var th = document.createElement('th');
      th.textContent = h;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    keys.forEach(function (d) {
      var tr = document.createElement('tr');
      var td0 = document.createElement('th');
      td0.scope = 'row';
      td0.textContent = d;
      tr.appendChild(td0);
      series.forEach(function (s) {
        var p = s.points.filter(function (x) { return x.date === d; })[0];
        var td = document.createElement('td');
        td.textContent = (p && p.value !== null && isFinite(p.value))
          ? fmt(p.value) + (p.estimated ? ' (추정)' : '')
          : '–';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    host.appendChild(table);
  }

  /* ── 차트 렌더 ───────────────────────────────────────────── */

  function renderTrend() {
    var series = trendSeries();
    var note = $('trendNote');
    var msgs = [];

    // 투자원금은 화폐 단위 상수다 — 100 기준 정규화(%) 축에는 얹을 수 없어 숨긴다.
    // (% 모드의 손익 기준은 이미 그려져 있는 100 기준선이 맡는다.)
    var basis = costBasisRows(series);
    var showRefLines = state.mode === 'abs' && basis.length <= MAX_REF_LINES;
    var refLines = showRefLines ? basis.map(function (r) {
      return {
        id: r.id + '@invested', value: r.invested, color: r.color,
        // 라벨에 금액을 넣지 않는다 — 축약(1.0억)은 손익 규모(수만~수십만원)를 가려 오히려 오독을 부른다.
        // 정확한 금액은 바로 아래 손익 요약 줄이 원 단위로 책임진다.
        label: r.name + ' 원금'
      };
    }) : [];

    if (basis.length) {
      if (state.mode === 'pct') {
        msgs.push('수익률(%) 모드에서는 투자원금 기준선을 숨깁니다(화폐 단위라 100 기준 축에 얹을 수 없습니다) — ' +
          '기준은 100 선이고, 원금 대비 손익은 아래 숫자로 보여 줍니다.');
      } else if (!showRefLines) {
        msgs.push('선택한 대상이 ' + basis.length + '개라 원금 기준선은 생략했습니다' +
          '(' + MAX_REF_LINES + '개 이하일 때 표시) — 원금 대비 손익은 아래 숫자로 보여 줍니다.');
      } else {
        msgs.push('촘촘한 점선은 각 대상의 투자원금(평단가×수량)이며 매매가 있을 때만 바뀝니다 — ' +
          '추이선과의 간격이 평가손익입니다.');
      }
    }

    if (state.historyError) msgs.push('추이 데이터를 불러오지 못했습니다: ' + state.historyError);
    if (state.benchmarkNote) msgs.push(state.benchmarkNote);
    if (state.history.length) {
      msgs.push('데이터 최신일 ' + state.history[state.history.length - 1].date +
        ' 기준 · 기간은 이 날짜에서 거슬러 계산합니다.');
    }
    var hasEstimated = state.history.some(function (r) {
      if (r.estimated) return true;
      return Object.keys(r).some(function (k) { return k.indexOf('est#') === 0 && r[k]; });
    });
    if (hasEstimated) msgs.push('점선·옅은 구간은 백필 추정치(estimated)입니다.');
    if (state.itemSkippedDates.length) {
      msgs.push('종목별 이력 중 ' + state.itemSkippedDates.length +
        '일치는 전체 이력에 없는 날짜라 제외했습니다.');
    }
    note.textContent = msgs.join(' ');
    note.hidden = !msgs.length;

    charts.trend = C.renderLineChart($('trendChart'), {
      series: series,
      refLines: refLines,
      mode: state.mode,
      unit: state.unit,
      title: '자산 추이',
      emptyMessage: state.historyLoaded
        ? '대상을 하나 이상 선택하세요.'
        : '추이 데이터를 불러오는 중…'
    });

    renderLegend($('trendLegend'), series);
    renderPnlSummary($('trendPnl'), basis, showRefLines);
    $('trendTableWrap').hidden = !state.showTrendTable;
    if (state.showTrendTable) {
      renderTable($('trendTable'), series, state.mode === 'pct' ? C.idxFmt : C.fullWon);
    }
  }

  function renderProjection() {
    var r = projectionSeries();
    charts.proj = C.renderLineChart($('projChart'), {
      series: r.series,
      mode: 'abs',
      unit: 'month',
      title: '예상 수익률 투영',
      emptyMessage: '기준 대상을 선택하세요.'
    });
    renderLegend($('projLegend'), r.series);

    var summary = $('projSummary');
    summary.innerHTML = '';
    var head = document.createElement('p');
    head.className = 'viz-note';
    head.textContent = r.entity.name + ' 기준 ' + C.fullWon(r.startValue) + ' → ' +
      state.projMonths + '개월 후 (점선은 가정치이며 실제 수익을 보장하지 않습니다)';
    summary.appendChild(head);

    var ul = document.createElement('div');
    ul.className = 'proj-result';
    state.scenarios.forEach(function (sc, i) {
      var annual = state.projRateUnit === 'monthly'
        ? (Math.pow(1 + Number(sc.rate) / 100, 12) - 1) * 100
        : Number(sc.rate);
      var vals = C.projectGrowth(r.startValue, annual, state.projMonths);
      var end = vals.length ? vals[vals.length - 1] : r.startValue;
      var row = document.createElement('div');
      row.className = 'proj-result-row';
      var key = document.createElement('span');
      key.className = 'scenario-key';
      key.style.background = 'var(--proj-' + (i + 1) + ')';
      var nm = document.createElement('span');
      nm.className = 'proj-result-name';
      nm.textContent = sc.name;
      var val = document.createElement('b');
      val.textContent = C.fullWon(end);
      var diff = document.createElement('span');
      diff.className = 'proj-result-diff';
      var gain = end - r.startValue;
      diff.textContent = (gain >= 0 ? '+' : '') + C.compactWon(gain);
      row.appendChild(key); row.appendChild(nm); row.appendChild(val); row.appendChild(diff);
      ul.appendChild(row);
    });
    summary.appendChild(ul);
  }

  function renderAllocation() {
    var cats = (state.portfolio && state.portfolio.categories) || [];
    var segs = cats.map(function (cat) {
      var slot = slots.assign('cat:' + cat.name);
      return {
        name: cat.name,
        target: Number(cat.targetPct) || 0,      // 분수 그대로(계산은 분수로)
        current: Number(cat.currentPct) || 0,
        color: slot ? 'var(--series-' + slot + ')' : 'var(--viz-muted)'
      };
    });

    C.renderDonut($('allocDonut'), segs);

    var legend = $('allocLegend');
    legend.innerHTML = '';
    segs.forEach(function (s) {
      var item = document.createElement('span');
      item.className = 'viz-legend-item';
      var key = document.createElement('span');
      key.className = 'viz-legend-key';
      key.style.background = s.color;
      var nm = document.createElement('span');
      nm.textContent = s.name;
      item.appendChild(key); item.appendChild(nm);
      legend.appendChild(item);
    });

    $('allocTableWrap').hidden = !state.showAllocTable;
    if (!state.showAllocTable) return;

    var host = $('allocTable');
    host.innerHTML = '';
    var table = document.createElement('table');
    table.className = 'viz-table';
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    ['카테고리', '목표', '현재', '차이'].forEach(function (h) {
      var th = document.createElement('th');
      th.textContent = h;
      hr.appendChild(th);
    });
    thead.appendChild(hr); table.appendChild(thead);
    var tb = document.createElement('tbody');
    segs.forEach(function (s) {
      var tr = document.createElement('tr');
      var th = document.createElement('th');
      th.scope = 'row'; th.textContent = s.name;
      tr.appendChild(th);
      [s.target * 100, s.current * 100, (s.current - s.target) * 100].forEach(function (v, i) {
        var td = document.createElement('td');
        td.textContent = (i === 2 && v >= 0 ? '+' : '') + v.toFixed(1) + (i === 2 ? '%p' : '%');
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    host.appendChild(table);
  }

  /* ── 데이터 로딩 ─────────────────────────────────────────── */

  /**
   * 벤치마크 드롭다운을 GET `benchmarks` 로 채운다.
   * 정적 폴백 옵션은 계약상 허용 심볼(SP500)이어야 한다 — 임의 문자열을 보내면
   * benchmarkHistory 가 에러가 아니라 **빈 배열**을 돌려줘서 조용히 실패한다.
   */
  async function loadBenchmarkList() {
    try {
      var list = await global.API.apiGet('benchmarks');
      if (!Array.isArray(list) || !list.length) return;
      var sel = $('benchmarkSelect');
      var prev = sel.value;
      sel.innerHTML = '';
      var none = document.createElement('option');
      none.value = '';
      none.textContent = '사용 안 함';
      sel.appendChild(none);
      list.forEach(function (b) {
        if (!b || !b.symbol) return;
        var o = document.createElement('option');
        o.value = b.symbol;
        // desc 를 그대로 노출한다 — "지수"가 아니라 원화 ETF 프록시임을 숨기지 않는다.
        o.textContent = b.desc || b.name || b.symbol;
        o.title = (b.name || '') + (b.code ? ' (' + b.code + ')' : '');
        sel.appendChild(o);
      });
      sel.value = prev;
      if (sel.value !== prev) { sel.value = ''; state.benchmark = ''; }
    } catch (e) {
      /* 정적 폴백 옵션을 그대로 둔다 — 화면은 깨지지 않는다. */
    }
  }

  async function loadBenchmark() {
    state.benchmarkRows = null;
    state.benchmarkNote = '';
    if (!state.benchmark) return;
    try {
      // 계약 shape: [{date, symbol, close, estimated?}]
      var rows = await global.API.apiGet('benchmarkHistory', {
        symbol: state.benchmark,
        range: state.range
      });
      var norm = C.normalizeHistory(rows).filter(function (r) { return isFinite(Number(r.close)); });
      if (!norm.length) throw new Error('empty');
      state.benchmarkRows = norm;
    } catch (e) {
      // 백엔드가 아직 benchmarkHistory 를 배포하지 않았을 수 있다(계약상 Phase 4).
      // 전체 화면은 그대로 두고 이 줄만 빠진다.
      state.benchmarkRows = null;
      state.benchmarkNote = '벤치마크 데이터 일시적으로 이용 불가 — 추이는 그대로 표시됩니다.';
    }
  }

  async function loadHistory(force) {
    if (state.loading) return;
    if (state.historyLoaded && !force) return;
    state.loading = true;
    $('trendChart').classList.add('is-refetching');   // 스켈레톤 대신 이전 렌더를 흐리게 유지
    try {
      // 두 요청은 서로 독립이다 — itemHistory 가 죽어도 카테고리 추이는 그대로 뜨고,
      // 반대도 마찬가지다. 그래서 각각 따로 잡는다(allSettled 대신 개별 catch).
      var histP = global.API.apiGet('history').then(function (r) {
        state.history = C.normalizeHistory(r);
        state.historyError = null;
      }, function (e) {
        state.history = [];
        state.historyError = e.message || String(e);
      });
      var itemP = global.API.apiGet('itemHistory').then(function (r) {
        state.itemRows = Array.isArray(r) ? r : [];
        state.itemError = null;
      }, function (e) {
        state.itemRows = [];
        state.itemError = e.message || String(e);
      });
      await histP;
      await itemP;

      state.itemLatestDate = '';
      state.itemSkippedDates = [];
      if (!state.itemError && state.history.length) {
        // 병합은 항상 방금 normalize 한 새 행 배열에 대해서만 한다(중복 병합 불가).
        var m = C.mergeItemHistory(state.history, state.itemRows);
        state.itemLatestDate = m.latestDate;
        state.itemSkippedDates = m.skippedDates;
      }
      state.historyLoaded = true;
      state.itemLoaded = true;
    } catch (e) {
      // 위에서 개별 처리하므로 여기에 오는 건 예상 밖의 예외뿐 — 화면은 살려 둔다.
      state.historyError = state.historyError || e.message || String(e);
      state.historyLoaded = true;
      state.itemLoaded = true;
    } finally {
      state.loading = false;
      $('trendChart').classList.remove('is-refetching');
    }
    renderTargetPicker();
    renderTrend();
    renderProjection();
  }

  /* ── 공개 API ───────────────────────────────────────────── */

  function setPortfolio(p) {
    state.portfolio = p;
    // 색 슬롯을 엔티티에 먼저 고정 배정한다(전체자산 → 카테고리 순).
    slots.assign(TOTAL_KEY);
    CATEGORY_ORDER.forEach(function (n) { slots.assign('cat:' + n); });
    if (!Object.keys(state.selected).length) state.selected[TOTAL_KEY] = true;
    renderProjBaseOptions();
    renderTargetPicker();
    renderAllocation();
    renderTrend();
    renderProjection();
  }

  /** 탭이 열릴 때: 숨겨져 있는 동안은 clientWidth 가 0이라 최소 폭으로 그려져 있다. 반드시 다시 그린다. */
  var benchmarkListLoaded = false;
  function activate() {
    loadHistory(false);
    if (!benchmarkListLoaded) { benchmarkListLoaded = true; loadBenchmarkList(); }
    forceRedraw();
  }

  function wire() {
    $('benchmarkSelect').addEventListener('change', async function () {
      state.benchmark = this.value;
      if (state.benchmark) state.mode = 'pct';   // 스케일이 다른 대상과 한 축에 겹치므로
      renderControls();
      renderTrend();
      await loadBenchmark();
      renderControls();
      renderTrend();
    });

    $('projBase').addEventListener('change', function () {
      state.projBase = this.value;
      renderProjection();
    });

    $('projMonths').addEventListener('change', function () {
      state.projMonths = parseInt(this.value, 10) || 36;
      renderProjection();
    });

    $('trendTableBtn').addEventListener('click', function () {
      state.showTrendTable = !state.showTrendTable;
      this.setAttribute('aria-expanded', String(state.showTrendTable));
      this.textContent = state.showTrendTable ? '표 닫기' : '표로 보기';
      renderTrend();
    });

    $('allocTableBtn').addEventListener('click', function () {
      state.showAllocTable = !state.showAllocTable;
      this.setAttribute('aria-expanded', String(state.showAllocTable));
      this.textContent = state.showAllocTable ? '표 닫기' : '표로 보기';
      renderAllocation();
    });

    $('trendReloadBtn').addEventListener('click', function () { loadHistory(true); });

    renderControls();
    renderScenarioInputs();

    // 폭이 바뀌면 다시 그린다.
    // ResizeObserver 만 믿지 않는다 — 콜백이 오지 않는 실행 컨텍스트가 실제로 있었다.
    // resize 이벤트를 항상 함께 걸고, 폭이 실제로 달라졌을 때만 그려 재진입을 막는다.
    var lastW = 0;
    var redrawTimer = null;
    var redraw = function (force) {
      var w = $('trendChart').clientWidth || 0;
      if (!force && w === lastW) return;
      lastW = w;
      if (charts.trend) charts.trend.redraw();
      if (charts.proj) charts.proj.redraw();
    };
    var scheduleRedraw = function () {
      clearTimeout(redrawTimer);
      redrawTimer = setTimeout(function () { redraw(false); }, 120);
    };
    global.addEventListener('resize', scheduleRedraw);
    global.addEventListener('orientationchange', scheduleRedraw);
    if (global.ResizeObserver) {
      try { new ResizeObserver(scheduleRedraw).observe($('trendChart')); } catch (e) { /* no-op */ }
    }
    forceRedraw = function () { lastW = 0; redraw(true); };
  }

  global.TrendsView = {
    wire: wire,
    setPortfolio: setPortfolio,
    activate: activate,
    _state: state
  };
})(window);
