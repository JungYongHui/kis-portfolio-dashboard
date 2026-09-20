/**
 * 차트 엔진 — 집계 / 정규화 / 투영 + SVG 렌더러.
 *
 * 빌드리스: 외부 차트 라이브러리 없이 순수 SVG DOM으로 그린다.
 *
 * ── dataviz 스킬 적용 요약 ────────────────────────────────────────────
 * 팔레트: reference/palette.md 의 categorical 8슬롯을 그대로 사용하되,
 * 이 앱의 실제 서피스(light #ffffff / dark #181b21)로 validate_palette.js 를
 * 재실행해 6개 체크를 모두 통과시킨 값이다(css/style.css 의 --series-* 참조).
 *   - light 8슬롯: 명도밴드/채도/CVD(worst adj ΔE 9.1)/일반시야(19.6) PASS,
 *     contrast 3슬롯이 3:1 미만 → WARN. 이 WARN 은 "relief rule"(가시 라벨 또는
 *     표 보기 제공) 대상이므로 모든 차트에 범례 + "표로 보기" 토글을 필수로 넣었다.
 *   - dark 8슬롯: 6개 체크 전부 PASS.
 * 색은 순위가 아니라 "대상(엔티티)"에 고정 배정한다 — 선택을 해제해도 남은
 * 시리즈의 색이 바뀌지 않는다(recolor-on-filter 안티패턴 회피).
 * 축은 항상 하나다 — 스케일이 다른 대상을 겹칠 땐 절대금액 대신 100 기준
 * 정규화(%)로 전환한다(dual-axis 금지).
 * 마크 규격: 선 2px round, 끝점 마커 r=4 + 2px 서피스 링, 그리드는 실선 hairline,
 * 점선은 "추정/투영"이라는 의미에만 쓴다(그리드에는 절대 쓰지 않는다).
 */
(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  /* ── 슬롯 배정 ───────────────────────────────────────────
   * 엔티티 → 고정 슬롯. 색은 엔티티를 따라가고 순위를 따라가지 않는다.
   * 슬롯 9번째부터는 새 색을 만들어내지 않고 배정 불가로 처리한다(토큰 상한 8).
   */
  var MAX_SLOTS = 8;

  function SlotRegistry() {
    this.map = {};
    this.next = 1;
  }
  SlotRegistry.prototype.assign = function (key) {
    if (this.map[key]) return this.map[key];
    if (this.next > MAX_SLOTS) return 0;       // 0 = 슬롯 없음
    this.map[key] = this.next++;
    return this.map[key];
  };
  SlotRegistry.prototype.get = function (key) { return this.map[key] || 0; };
  SlotRegistry.prototype.colorOf = function (key) {
    var s = this.get(key);
    return s ? 'var(--series-' + s + ')' : 'var(--viz-muted)';
  };

  /* ── 데이터 변환 ─────────────────────────────────────────── */

  function dayStr(v) {
    return String(v === null || v === undefined ? '' : v).slice(0, 10);
  }

  /**
   * history 원본 정규화.
   * staging 응답에서 (a) 날짜 내림차순, (b) 같은 날짜 중복 행이 실제로 관측됐다.
   * → 날짜 오름차순 정렬 + 날짜별 1행(입력 순서상 먼저 나온 행 = 최신 기록분)으로 접는다.
   */
  function normalizeHistory(rows) {
    var seen = {};
    (rows || []).forEach(function (r) {
      if (!r || !r.date) return;
      var d = dayStr(r.date);
      if (!d) return;
      if (seen[d]) return;                       // 먼저 나온 행 유지
      var copy = {};
      Object.keys(r).forEach(function (k) { copy[k] = r[k]; });
      copy.date = d;
      copy.estimated = !!r.estimated;
      seen[d] = copy;
    });
    return Object.keys(seen).sort().map(function (d) { return seen[d]; });
  }

  function periodKey(date, unit) {
    if (unit === 'year') return date.slice(0, 4);
    if (unit === 'month') return date.slice(0, 7);
    if (unit === 'week') {
      var dt = new Date(date + 'T00:00:00Z');
      if (isNaN(dt.getTime())) return date;
      var dow = dt.getUTCDay() || 7;             // 월=1 … 일=7
      dt.setUTCDate(dt.getUTCDate() - dow + 1);  // 그 주 월요일
      return dt.toISOString().slice(0, 10);
    }
    return date;
  }

  /**
   * 집계. 서버 왕복 없이 클라이언트에서만 수행한다(원본은 항상 raw daily).
   * 구간 대표값은 "구간 마지막 값"(종가 기준).
   * estimated 는 구간 안에 하나라도 true 면 true — 추정 구간을 숨기지 않기 위해서다.
   */
  function aggregate(dailyRows, unit) {
    var out = [];
    var at = {};
    (dailyRows || []).forEach(function (r) {
      var k = periodKey(r.date, unit || 'day');
      var merged = {};
      Object.keys(r).forEach(function (f) { merged[f] = r[f]; });
      merged.periodKey = k;
      if (at[k] === undefined) {
        at[k] = out.length;
        out.push(merged);
      } else {
        merged.estimated = !!(out[at[k]].estimated || r.estimated);
        out[at[k]] = merged;                     // 뒤에 온 행 = 구간 마지막
      }
    });
    return out;
  }

  var RANGE_DAYS = { '1w': 7, '1m': 30, '3m': 91, '6m': 183, '1y': 365, all: 0 };

  /**
   * 기간 슬라이스. 기준점은 "오늘"이 아니라 "데이터의 마지막 날짜"다 —
   * 스냅샷이 며칠 밀려 있을 때 1주 선택이 빈 화면이 되는 걸 막기 위해서다.
   * (화면에는 데이터 최신일을 따로 표기해 기준을 숨기지 않는다.)
   */
  function sliceRange(rows, range) {
    var days = RANGE_DAYS[range] || 0;
    if (!days || !rows || !rows.length) return (rows || []).slice();
    var last = new Date(rows[rows.length - 1].date + 'T00:00:00Z');
    if (isNaN(last.getTime())) return rows.slice();
    var cut = new Date(last.getTime() - days * 86400000).toISOString().slice(0, 10);
    return rows.filter(function (r) { return r.date >= cut; });
  }

  /** 구간 시작점을 100으로 정규화. 0/음수 시작값은 정규화 불가 → null 반환. */
  function rebase(series) {
    if (!series || !series.length) return [];
    var base = null;
    for (var i = 0; i < series.length; i++) {
      var v = Number(series[i].value);
      if (isFinite(v) && v > 0) { base = v; break; }
    }
    if (base === null) return series.map(function (p) {
      return { date: p.date, value: null, estimated: p.estimated };
    });
    return series.map(function (p) {
      var v = Number(p.value);
      return {
        date: p.date,
        value: isFinite(v) ? (v / base) * 100 : null,
        estimated: p.estimated
      };
    });
  }

  /** 복리 성장 곡선. months 개월치 값 배열(1개월 후 … months개월 후). */
  function projectGrowth(baseValue, annualRatePct, months) {
    var monthlyRate = Math.pow(1 + Number(annualRatePct) / 100, 1 / 12) - 1;
    var base = Number(baseValue) || 0;
    var n = Math.max(0, Math.round(months));
    return Array.from({ length: n }, function (_, i) {
      return base * Math.pow(1 + monthlyRate, i + 1);
    });
  }

  /** YYYY-MM-DD 에 개월 더하기(말일 보정). */
  function addMonths(date, n) {
    var dt = new Date(date + 'T00:00:00Z');
    if (isNaN(dt.getTime())) return date;
    var d = dt.getUTCDate();
    dt.setUTCDate(1);
    dt.setUTCMonth(dt.getUTCMonth() + n);
    var lastDay = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
    dt.setUTCDate(Math.min(d, lastDay));
    return dt.toISOString().slice(0, 10);
  }

  /* ── 포맷 ───────────────────────────────────────────────── */

  /** 축/툴팁용 금액 축약. 1.2억 / 3,400만 형태. */
  function compactWon(v) {
    var n = Number(v);
    if (!isFinite(n)) return '–';
    var abs = Math.abs(n);
    if (abs >= 1e8) return (n / 1e8).toFixed(abs >= 1e9 ? 0 : 1) + '억';
    if (abs >= 1e4) return Math.round(n / 1e4).toLocaleString('ko-KR') + '만';
    return Math.round(n).toLocaleString('ko-KR');
  }

  function fullWon(v) {
    var n = Number(v);
    return isFinite(n) ? Math.round(n).toLocaleString('ko-KR') + '원' : '–';
  }

  function idxFmt(v) {
    var n = Number(v);
    return isFinite(n) ? n.toFixed(1) : '–';
  }

  /** 축 눈금을 깔끔한 수로 떨어뜨린다. */
  function niceTicks(min, max, count) {
    if (!isFinite(min) || !isFinite(max)) return [0];
    if (min === max) { min -= 1; max += 1; }
    var span = max - min;
    var raw = span / Math.max(1, count);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    var start = Math.ceil(min / step) * step;
    var ticks = [];
    for (var t = start; t <= max + step * 0.001 && ticks.length < 12; t += step) {
      ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t);
    }
    return ticks.length ? ticks : [min, max];
  }

  function shortDate(d, unit) {
    if (!d) return '';
    if (unit === 'year') return d.slice(0, 4);
    if (unit === 'month') return d.slice(2, 7);
    return d.slice(5).replace('-', '/');
  }

  /* ── SVG 유틸 ───────────────────────────────────────────── */

  function el(name, attrs) {
    var n = document.createElementNS(SVG_NS, name);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  /* ── 선형 추이 차트 ──────────────────────────────────────
   * opts = {
   *   series: [{ id, name, color, points:[{date,value,estimated}], dash:bool, muted:bool }],
   *   unit, mode: 'abs'|'pct', height
   * }
   * 반환: { redraw() } — 컨테이너 리사이즈 시 호출.
   */
  function renderLineChart(container, opts) {
    var o = opts || {};
    var series = (o.series || []).filter(function (s) { return s.points && s.points.length; });
    clear(container);
    container.classList.add('viz-plot');

    if (!series.length) {
      var empty = document.createElement('div');
      empty.className = 'viz-empty';
      empty.textContent = o.emptyMessage || '표시할 데이터가 없습니다.';
      container.appendChild(empty);
      return { redraw: function () {} };
    }

    var tip = document.createElement('div');
    tip.className = 'viz-tip';
    tip.hidden = true;

    var fmtValue = o.mode === 'pct'
      ? function (v) { return idxFmt(v); }
      : function (v) { return fullWon(v); };
    var fmtAxis = o.mode === 'pct'
      ? function (v) { return idxFmt(v); }
      : function (v) { return compactWon(v); };

    // x는 시간 선형 스케일 — 시리즈마다 날짜 집합이 달라도(벤치마크/투영) 같은 축에 얹힌다.
    var allDates = {};
    series.forEach(function (s) {
      s.points.forEach(function (p) { if (p.value !== null && isFinite(p.value)) allDates[p.date] = 1; });
    });
    var dates = Object.keys(allDates).sort();
    if (!dates.length) {
      var e2 = document.createElement('div');
      e2.className = 'viz-empty';
      e2.textContent = o.emptyMessage || '표시할 데이터가 없습니다.';
      container.appendChild(e2);
      return { redraw: function () {} };
    }
    var tOf = function (d) { return new Date(d + 'T00:00:00Z').getTime(); };
    var t0 = tOf(dates[0]);
    var t1 = tOf(dates[dates.length - 1]);
    if (!(t1 > t0)) t1 = t0 + 86400000;

    var vmin = Infinity, vmax = -Infinity;
    series.forEach(function (s) {
      s.points.forEach(function (p) {
        var v = Number(p.value);
        if (!isFinite(v)) return;
        if (v < vmin) vmin = v;
        if (v > vmax) vmax = v;
      });
    });
    if (!isFinite(vmin)) { vmin = 0; vmax = 1; }
    if (vmin === vmax) { vmin -= Math.abs(vmin) * 0.05 + 1; vmax += Math.abs(vmax) * 0.05 + 1; }
    var pad = (vmax - vmin) * 0.08;
    vmin -= pad; vmax += pad;
    if (o.mode === 'abs' && vmin < 0) vmin = 0;

    var svg = el('svg', { class: 'viz-svg', role: 'img', tabindex: '0' });
    var desc = el('title');
    desc.textContent = (o.title || '추이 차트') + ' — ' +
      series.map(function (s) { return s.name; }).join(', ');
    svg.appendChild(desc);
    container.appendChild(svg);
    container.appendChild(tip);

    var hover = { g: null, line: null, dots: [] };
    var geom = null;

    function draw() {
      clear(svg);
      svg.appendChild(desc);

      var W = Math.max(280, container.clientWidth || 320);
      // 높이에 x축 밴드를 포함시킨다 — 축 라벨이 잘려 카드 안에 스크롤이 생기는 걸 막는다.
      var plotH = o.height || 210;
      var M = { t: 10, r: 14, b: 26, l: o.mode === 'pct' ? 38 : 50 };
      var H = plotH + M.t + M.b;
      var iw = W - M.l - M.r;
      var ih = plotH;

      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('width', W);
      svg.setAttribute('height', H);

      var X = function (d) { return M.l + ((tOf(d) - t0) / (t1 - t0)) * iw; };
      var Y = function (v) { return M.t + ih - ((v - vmin) / (vmax - vmin)) * ih; };
      geom = { X: X, Y: Y, M: M, iw: iw, ih: ih, W: W, H: H };

      // 그리드 — 실선 hairline, 서피스에서 한 단계만 떨어진 회색(점선 금지)
      var gGrid = el('g', {});
      niceTicks(vmin, vmax, 4).forEach(function (t) {
        var y = Y(t);
        if (y < M.t - 1 || y > M.t + ih + 1) return;
        gGrid.appendChild(el('line', {
          x1: M.l, x2: M.l + iw, y1: y, y2: y,
          class: 'viz-grid'
        }));
        var lab = el('text', { x: M.l - 6, y: y + 3.5, class: 'viz-axis-label', 'text-anchor': 'end' });
        lab.textContent = fmtAxis(t);
        gGrid.appendChild(lab);
      });
      svg.appendChild(gGrid);

      // 기준선 100 (정규화 모드) — 그리드보다 한 단계 진하게
      if (o.mode === 'pct' && 100 >= vmin && 100 <= vmax) {
        svg.appendChild(el('line', {
          x1: M.l, x2: M.l + iw, y1: Y(100), y2: Y(100), class: 'viz-baseline'
        }));
      }

      // x축 라벨 — 최대 4개만(모바일 폭에서 겹치지 않게)
      var gx = el('g', {});
      var picks = [];
      var n = dates.length;
      var want = Math.min(4, n);
      for (var i = 0; i < want; i++) picks.push(dates[Math.round(i * (n - 1) / Math.max(1, want - 1))]);
      picks.filter(function (v, i, a) { return a.indexOf(v) === i; }).forEach(function (d, i, arr) {
        var tx = el('text', {
          x: X(d), y: M.t + ih + 17, class: 'viz-axis-label',
          'text-anchor': i === 0 ? 'start' : (i === arr.length - 1 ? 'end' : 'middle')
        });
        tx.textContent = shortDate(d, o.unit);
        gx.appendChild(tx);
      });
      svg.appendChild(gx);

      // 시리즈
      series.forEach(function (s) {
        var pts = s.points.filter(function (p) { return p.value !== null && isFinite(p.value); });
        if (!pts.length) return;

        // 실측/추정 경계에서 선을 끊어 그린다 — 추정 구간은 점선 + 옅게.
        var runs = [];
        var cur = null;
        pts.forEach(function (p) {
          var est = !!p.estimated;
          if (!cur || cur.est !== est) {
            // 끊김 없이 이어 보이도록 직전 점을 새 run 의 시작점으로 한 번 더 넣는다.
            var seed = cur ? [cur.pts[cur.pts.length - 1]] : [];
            cur = { est: est, pts: seed.concat([p]) };
            runs.push(cur);
          } else {
            cur.pts.push(p);
          }
        });

        var g = el('g', { class: 'viz-series' + (s.muted ? ' is-muted' : '') });
        runs.forEach(function (run) {
          var d = run.pts.map(function (p, i) {
            return (i ? 'L' : 'M') + X(p.date).toFixed(1) + ' ' + Y(p.value).toFixed(1);
          }).join(' ');
          var path = el('path', { d: d, class: 'viz-line', fill: 'none' });
          path.style.stroke = s.color;
          if (s.dash || run.est) path.setAttribute('stroke-dasharray', s.dash ? '5 4' : '4 3');
          if (run.est) path.setAttribute('opacity', '0.55');
          g.appendChild(path);
        });

        // 끝점 마커: 2px 서피스 링을 두른 r=4 점
        var last = pts[pts.length - 1];
        var ring = el('circle', { cx: X(last.date), cy: Y(last.value), r: 4, class: 'viz-end-dot' });
        ring.style.fill = s.color;
        g.appendChild(ring);

        // 직접 라벨은 시리즈가 4개 이하일 때만 — 그 이상은 겹쳐서 노이즈가 된다(범례+툴팁이 대신).
        if (series.length <= 4) {
          var lx = X(last.date);
          var lbl = el('text', {
            x: Math.min(lx + 7, M.l + iw),
            y: Y(last.value) - 7,
            class: 'viz-end-label',
            'text-anchor': lx + 7 > M.l + iw - 30 ? 'end' : 'start'
          });
          lbl.textContent = o.mode === 'pct' ? idxFmt(last.value) : compactWon(last.value);
          g.appendChild(lbl);
        }

        svg.appendChild(g);
      });

      // 호버 레이어 — 크로스헤어가 X를 찾아준다(2px 선을 겨냥할 필요 없음)
      hover.g = el('g', { class: 'viz-hover', visibility: 'hidden' });
      hover.line = el('line', { y1: M.t, y2: M.t + ih, class: 'viz-crosshair' });
      hover.g.appendChild(hover.line);
      hover.dots = series.map(function (s) {
        var c = el('circle', { r: 4, class: 'viz-hover-dot' });
        c.style.fill = s.color;
        hover.g.appendChild(c);
        return c;
      });
      svg.appendChild(hover.g);

      var overlay = el('rect', {
        x: M.l, y: M.t, width: Math.max(1, iw), height: ih,
        fill: 'transparent', class: 'viz-overlay'
      });
      svg.appendChild(overlay);
    }

    function valueAt(s, date) {
      for (var i = 0; i < s.points.length; i++) {
        if (s.points[i].date === date) return s.points[i];
      }
      return null;
    }

    var activeIdx = -1;

    function showAt(idx) {
      if (!geom || idx < 0 || idx >= dates.length) return;
      activeIdx = idx;
      var d = dates[idx];
      var x = geom.X(d);
      hover.g.setAttribute('visibility', 'visible');
      hover.line.setAttribute('x1', x);
      hover.line.setAttribute('x2', x);

      clear(tip);
      var head = document.createElement('div');
      head.className = 'viz-tip-date';
      head.textContent = d;
      tip.appendChild(head);

      series.forEach(function (s, i) {
        var p = valueAt(s, d);
        var dot = hover.dots[i];
        if (!p || p.value === null || !isFinite(p.value)) {
          dot.setAttribute('visibility', 'hidden');
          return;
        }
        dot.setAttribute('visibility', 'visible');
        dot.setAttribute('cx', x);
        dot.setAttribute('cy', geom.Y(p.value));

        var row = document.createElement('div');
        row.className = 'viz-tip-row';
        var key = document.createElement('span');
        key.className = 'viz-tip-key';
        key.style.background = s.color;
        // 값이 앞, 이름이 뒤 — 읽는 사람은 시리즈를 이미 알고 숫자를 원한다.
        var val = document.createElement('b');
        val.textContent = fmtValue(p.value) + (p.estimated ? ' (추정)' : '');
        var nm = document.createElement('span');
        nm.className = 'viz-tip-name';
        nm.textContent = s.name;                    // 이름은 API 문자열 — textContent 로만 삽입
        row.appendChild(key); row.appendChild(val); row.appendChild(nm);
        tip.appendChild(row);
      });

      tip.hidden = false;
      var cw = container.clientWidth || geom.W;
      var tw = tip.offsetWidth || 150;
      tip.style.left = Math.max(4, Math.min(cw - tw - 4, x - tw / 2)) + 'px';
    }

    function hide() {
      if (hover.g) hover.g.setAttribute('visibility', 'hidden');
      tip.hidden = true;
      activeIdx = -1;
    }

    function nearestIdx(px) {
      if (!geom) return -1;
      var best = -1, bestD = Infinity;
      dates.forEach(function (d, i) {
        var dist = Math.abs(geom.X(d) - px);
        if (dist < bestD) { bestD = dist; best = i; }
      });
      return best;
    }

    function onMove(e) {
      var rect = svg.getBoundingClientRect();
      var scale = rect.width ? (geom.W / rect.width) : 1;
      var px = (e.clientX - rect.left) * scale;
      showAt(nearestIdx(px));
    }

    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerdown', onMove);
    svg.addEventListener('pointerleave', hide);
    // 키보드에서도 호버와 같은 정보를 준다.
    svg.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        var base = activeIdx < 0 ? (e.key === 'ArrowRight' ? -1 : dates.length) : activeIdx;
        showAt(Math.max(0, Math.min(dates.length - 1, base + (e.key === 'ArrowRight' ? 1 : -1))));
      } else if (e.key === 'Escape') { hide(); }
    });
    svg.addEventListener('blur', hide);

    draw();
    return { redraw: function () { hide(); draw(); } };
  }

  /* ── 배분 도넛 (목표 vs 현재) ─────────────────────────────
   * 바깥 링 = 현재 비중, 안쪽 링 = 목표 비중. 같은 카테고리는 같은 색(엔티티 고정).
   * 세그먼트 사이는 2px 서피스 간격 — 테두리를 그려서 나누지 않는다.
   */
  function renderDonut(container, segments) {
    clear(container);
    var segs = (segments || []).filter(function (s) {
      return (Number(s.current) > 0) || (Number(s.target) > 0);
    });
    if (!segs.length) {
      var empty = document.createElement('div');
      empty.className = 'viz-empty';
      empty.textContent = '배분 데이터가 없습니다.';
      container.appendChild(empty);
      return;
    }

    var SIZE = 168, C = SIZE / 2;
    var svg = el('svg', {
      class: 'viz-donut', viewBox: '0 0 ' + SIZE + ' ' + SIZE, width: SIZE, height: SIZE, role: 'img'
    });
    var t = el('title');
    t.textContent = '카테고리별 목표 대비 현재 비중';
    svg.appendChild(t);

    function ring(values, radius, width, cls) {
      var total = values.reduce(function (a, b) { return a + Math.max(0, b.v); }, 0);
      if (total <= 0) return;
      var gapRad = 2 / radius;                  // 2px 서피스 간격
      var angle = -Math.PI / 2;                 // 12시 방향 시작
      values.forEach(function (item) {
        var frac = Math.max(0, item.v) / total;
        if (frac <= 0) return;
        var sweep = frac * Math.PI * 2;
        var a0 = angle + gapRad / 2;
        var a1 = angle + sweep - gapRad / 2;
        angle += sweep;
        if (a1 <= a0) return;
        var large = (a1 - a0) > Math.PI ? 1 : 0;
        var d = 'M ' + (C + radius * Math.cos(a0)).toFixed(2) + ' ' + (C + radius * Math.sin(a0)).toFixed(2) +
          ' A ' + radius + ' ' + radius + ' 0 ' + large + ' 1 ' +
          (C + radius * Math.cos(a1)).toFixed(2) + ' ' + (C + radius * Math.sin(a1)).toFixed(2);
        var p = el('path', { d: d, fill: 'none', 'stroke-width': width, 'stroke-linecap': 'butt', class: cls });
        p.style.stroke = item.color;
        if (cls === 'viz-ring-target') p.setAttribute('opacity', '0.45');
        svg.appendChild(p);
      });
    }

    ring(segs.map(function (s) { return { v: Number(s.current) || 0, color: s.color }; }), 70, 14, 'viz-ring-current');
    ring(segs.map(function (s) { return { v: Number(s.target) || 0, color: s.color }; }), 50, 10, 'viz-ring-target');

    // 중앙: 가장 크게 벗어난 카테고리 하나만 — 숫자 나열은 아래 표가 맡는다.
    var worst = null;
    segs.forEach(function (s) {
      var diff = (Number(s.current) || 0) - (Number(s.target) || 0);
      if (!worst || Math.abs(diff) > Math.abs(worst.diff)) worst = { name: s.name, diff: diff };
    });
    if (worst) {
      var l1 = el('text', { x: C, y: C - 4, class: 'viz-donut-center-label', 'text-anchor': 'middle' });
      l1.textContent = '최대 이탈';
      var l2 = el('text', { x: C, y: C + 13, class: 'viz-donut-center-value', 'text-anchor': 'middle' });
      l2.textContent = worst.name;
      var l3 = el('text', { x: C, y: C + 28, class: 'viz-donut-center-label', 'text-anchor': 'middle' });
      l3.textContent = (worst.diff >= 0 ? '+' : '') + (worst.diff * 100).toFixed(1) + '%p';
      svg.appendChild(l1); svg.appendChild(l2); svg.appendChild(l3);
    }

    container.appendChild(svg);
  }

  global.Charts = {
    SlotRegistry: SlotRegistry,
    MAX_SLOTS: MAX_SLOTS,
    normalizeHistory: normalizeHistory,
    aggregate: aggregate,
    sliceRange: sliceRange,
    rebase: rebase,
    projectGrowth: projectGrowth,
    addMonths: addMonths,
    compactWon: compactWon,
    fullWon: fullWon,
    idxFmt: idxFmt,
    shortDate: shortDate,
    renderLineChart: renderLineChart,
    renderDonut: renderDonut,
    RANGE_DAYS: RANGE_DAYS
  };
})(window);
