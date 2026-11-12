(async () => {
  const me = await requireStaff("settlement.html");
  if (!me) return;
  const $ = (id) => document.getElementById(id);
  if (me.role === "branch_staff") {
    document.querySelector("main").replaceChildren(el("div", "정산은 관리자만 볼 수 있습니다.", "msg"));
    return;
  }
  const isHq = me.role === "hq_admin";
  const UNIT = { day: "일별", week: "주별", quarter: "분기별", year: "연별" };
  const STATUS = { completed: "완료", checked_out: "퇴근(완료 보고 전)" };
  const won = (n) => Number(n).toLocaleString("ko-KR");
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());

  let allRows = [];   // 조회한 전체
  let rows = [];      // 구직자를 골랐으면 그 사람 것만
  let lastQuery = null;

  // 구직자 찾기 (개인별 정산): 이름·전화번호로 검색하거나, 표의 [개인 정산서]로 한 명을 고름
  //  · 검색하면 합계·표·인쇄·엑셀이 모두 검색된 구직자 것만 나옴
  //  · [개인 정산서]로 고르면 정확히 그 한 명만 (동명이인 구분)
  let pickedId = "";
  const workerQuery = () => $("workerQ").value.trim().toLowerCase();
  const pickedWorker = () => pickedId;   // 한 명을 정확히 고른 상태
  function workerMatch() {   // 지금 조건에 맞는지 판단하는 함수 (조건 없으면 null)
    if (pickedId) return (r) => r.worker_id === pickedId;
    const q = workerQuery(), qd = digits(q);
    if (!q) return null;
    return (r) => r.worker_name.toLowerCase().includes(q) || (qd !== "" && digits(r.worker_phone).includes(qd));
  }
  // 의뢰인 확인 걸러보기 (정산 금액 계산에는 영향 없음)
  const CONF = { ok: "확인됨", problem: "문제 있음" };
  const confLabel = (r) => CONF[r.client_confirm] || "미확인";
  function confMatch() {
    const f = $("confF").value;
    if (!f) return null;
    return (r) => (f === "none" ? !r.client_confirm : r.client_confirm === f);
  }
  function rowOk(r) {   // 구직자 검색 + 의뢰인 확인 조건을 모두 만족하는지
    const m = workerMatch(), c = confMatch();
    return (!m || m(r)) && (!c || c(r));
  }
  const isFiltered = () => !!workerMatch() || !!confMatch();
  function applyWorker() {
    const m = workerMatch();
    rows = isFiltered() ? allRows.filter(rowOk) : allRows;
    $("workerClear").hidden = !m;
  }
  $("confF").addEventListener("change", () => { if (lastQuery) { applyWorker(); render(); } });
  $("workerQ").addEventListener("input", () => { pickedId = ""; if (lastQuery) { applyWorker(); render(); } });
  $("workerClear").addEventListener("click", () => { pickedId = ""; $("workerQ").value = ""; if (lastQuery) { applyWorker(); render(); } });
  const workerLabel = () => (pickedId && rows.length ? rows[0].worker_name + " 님" : "검색: " + $("workerQ").value.trim());

  // 구직자 개인별 표 정렬 상태 (머리글을 누르면 바뀜)
  const wSort = { i: -1, dir: 1 };

  // ───────── 기간 고르기 ─────────
  function preset(name) {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    const y = t.getFullYear(), m = t.getMonth();
    let a, b, unit;
    if (name === "today") { a = b = t; unit = "day"; }
    else if (name === "week") {
      a = new Date(t); a.setDate(t.getDate() - ((t.getDay() + 6) % 7));
      b = new Date(a); b.setDate(a.getDate() + 6); unit = "day";
    }
    else if (name === "month") { a = new Date(y, m, 1); b = new Date(y, m + 1, 0); unit = "week"; }
    else if (name === "lastmonth") { a = new Date(y, m - 1, 1); b = new Date(y, m, 0); unit = "week"; }
    else if (name === "quarter") { const q = Math.floor(m / 3); a = new Date(y, q * 3, 1); b = new Date(y, q * 3 + 3, 0); unit = "quarter"; }
    else { a = new Date(y, 0, 1); b = new Date(y, 11, 31); unit = "year"; }
    $("from").value = iso(a);
    $("to").value = iso(b);
    $("unit").value = unit;
  }
  for (const b of document.querySelectorAll("[data-p]")) b.addEventListener("click", () => { preset(b.dataset.p); run(); });
  preset("month");

  if (isHq) {
    const { data } = await db.from("branches").select("id,name").order("name");
    $("branchSel").hidden = false;
    $("branchSel").append(new Option("전체 지점", ""));
    for (const b of data || []) $("branchSel").append(new Option(b.name, b.id));
  }

  // ───────── 자료 가져오기 (한 번에 1000건씩 이어서) ─────────
  async function fetchRows(withBank) {
    const out = [];
    const page = 1000;
    for (let offset = 0; ; offset += page) {
      const { data, error } = await db.rpc("settlement_rows", {
        p_from: lastQuery.from, p_to: lastQuery.to, p_branch: lastQuery.branch,
        p_include_out: lastQuery.incOut, p_with_bank: withBank,
      }).range(offset, offset + page - 1);
      if (error) throw error;
      out.push(...data);
      if (data.length < page) break;
    }
    return out;
  }

  // ───────── 기간 묶기 ─────────
  function periodOf(dateStr, unit) {
    const [y, m, d] = dateStr.split("-").map(Number);
    if (unit === "day") return { key: dateStr, label: dateStr };
    if (unit === "week") {
      const dt = new Date(y, m - 1, d);
      dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));   // 월요일 시작
      const end = new Date(dt); end.setDate(dt.getDate() + 6);
      return { key: iso(dt), label: iso(dt) + " ~ " + iso(end) };
    }
    if (unit === "quarter") { const q = Math.floor((m - 1) / 3) + 1; return { key: y + "-Q" + q, label: y + "년 " + q + "분기" }; }
    return { key: String(y), label: y + "년" };
  }

  const ZERO = () => ({ count: 0, wage: 0, offered: 0, fee: 0, taxIncome: 0, taxLocal: 0, net: 0 });
  function add(acc, r) {
    acc.count += 1;
    acc.wage += r.wage;
    acc.offered += r.offered_wage;
    acc.fee += r.fee;
    acc.taxIncome += r.tax_income;
    acc.taxLocal += r.tax_local;
    acc.net += r.net;
  }

  function group(list, unit, keyFn) {
    const map = new Map();
    for (const r of list) {
      const p = periodOf(r.work_date, unit);
      const extra = keyFn ? keyFn(r) : null;
      const key = p.key + "|" + (extra ? extra.key : "");
      if (!map.has(key)) map.set(key, { period: p, extra, workers: new Set(), ...ZERO() });
      const g = map.get(key);
      add(g, r);
      g.workers.add(r.worker_id);
    }
    return [...map.values()].sort((a, b) =>
      a.period.key.localeCompare(b.period.key) || (a.extra ? a.extra.name.localeCompare(b.extra.name, "ko") : 0));
  }

  // ───────── 표 그리기 ─────────
  //  sort 를 주면 c.v 가 있는 칸의 머리글을 눌러 정렬할 수 있음 (sort: { i, dir }, onSort(칸 번호))
  function drawTable(tableEl, cols, data, totalRow, sort, onSort) {
    tableEl.replaceChildren();
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    cols.forEach((c, i) => {
      const th = el("th", c.h + (sort && sort.i === i ? (sort.dir > 0 ? " ▲" : " ▼") : ""));
      if (c.num) th.style.textAlign = "right";
      if (sort && c.v) { th.style.cursor = "pointer"; th.title = "눌러서 정렬"; th.addEventListener("click", () => onSort(i)); }
      hr.append(th);
    });
    thead.append(hr);
    const tbody = document.createElement("tbody");
    for (const r of data) {
      const tr = document.createElement("tr");
      for (const c of cols) {
        const td = c.node ? el("td") : el("td", String(c.f(r)));
        if (c.node) td.append(c.node(r));
        if (c.num) { td.style.textAlign = "right"; td.style.whiteSpace = "nowrap"; }
        tr.append(td);
      }
      tbody.append(tr);
    }
    if (totalRow) {
      const tr = document.createElement("tr");
      tr.style.fontWeight = "700";
      cols.forEach((c, i) => {
        const td = el("td", i === 0 ? "합계" : (totalRow[c.k] !== undefined ? String(c.fmt ? c.fmt(totalRow[c.k]) : totalRow[c.k]) : ""));
        if (c.num) td.style.textAlign = "right";
        tr.append(td);
      });
      tbody.append(tr);
    }
    tableEl.append(thead, tbody);
  }

  const moneyCols = [
    { h: "건수", k: "count", f: (r) => r.count, num: true },
    { h: "일당(확정 단가)", k: "wage", f: (r) => won(r.wage), num: true, fmt: won },
    { h: "소개수수료", k: "fee", f: (r) => won(r.fee), num: true, fmt: won },
    { h: "소득세", k: "taxIncome", f: (r) => won(r.taxIncome), num: true, fmt: won },
    { h: "지방소득세", k: "taxLocal", f: (r) => won(r.taxLocal), num: true, fmt: won },
    { h: "구직자 지급액", k: "net", f: (r) => won(r.net), num: true, fmt: won },
  ];

  function render() {
    const unit = lastQuery.unit;
    const total = ZERO();
    const people = new Set();
    for (const r of rows) { add(total, r); people.add(r.worker_id); }

    $("totalCard").hidden = $("sumCard").hidden = $("payCard").hidden = $("billCard").hidden = $("detailCard").hidden = rows.length === 0;
    $("branchCard").hidden = !isHq || rows.length === 0 || !!pickedWorker();
    $("workerCard").hidden = rows.length === 0 || !!pickedWorker();
    $("print").disabled = rows.length === 0;
    if (!rows.length) {
      $("status").textContent = allRows.length && isFiltered() ? "조건에 맞는 건이 없습니다." : "해당 기간에 정산할 건이 없습니다.";
      return;
    }
    const filtered = isFiltered();
    const problems = rows.filter((r) => r.client_confirm === "problem").length;
    $("status").textContent = rows.length + "건 · " + people.size + "명" + (filtered ? " (전체 " + allRows.length + "건 중 조건에 맞는 결과)" : "")
      + (problems ? " · 의뢰인 '문제 있음' " + problems + "건 포함" : "");
    $("totalTitle").textContent = workerMatch() ? workerLabel() + " 정산 합계" : filtered ? "조건에 맞는 건 합계" : "조회 기간 합계";

    // 구직자 개인별 합계 (조회 기간 전체). 머리글을 누르면 정렬
    if (!pickedWorker()) {
      const byWorker = new Map();
      for (const r of rows) {
        if (!byWorker.has(r.worker_id)) byWorker.set(r.worker_id, { id: r.worker_id, name: r.worker_name, phone: r.worker_phone, ...ZERO() });
        add(byWorker.get(r.worker_id), r);
      }
      const wcols = [
        { h: "구직자", f: (r) => r.name, v: (r) => r.name },
        { h: "연락처", f: (r) => fmtPhone(r.phone), v: (r) => digits(r.phone) },
        ...moneyCols.map((c) => ({ ...c, v: (r) => r[c.k] })),
        { h: "", node: (r) => {
          const b = el("button", "개인 정산서");
          b.type = "button";
          b.addEventListener("click", () => { pickedId = r.id; $("workerQ").value = r.name; applyWorker(); render(); window.scrollTo(0, 0); });
          return b;
        } },
      ];
      const list = [...byWorker.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
      if (wSort.i >= 0) {
        const v = wcols[wSort.i].v;
        list.sort((a, b) => (typeof v(a) === "number" ? v(a) - v(b) : String(v(a)).localeCompare(String(v(b)), "ko")) * wSort.dir);
      }
      $("workerCount").textContent = byWorker.size + "명";
      drawTable($("workerTable"), wcols, list, total, wSort, (i) => {
        wSort.dir = wSort.i === i ? -wSort.dir : (i >= 2 ? -1 : 1);   // 금액 칸은 처음 누르면 큰 금액부터
        wSort.i = i;
        render();
      });
    }

    const box = $("totals");
    box.replaceChildren();
    const grid = el("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px";
    for (const [label, value, strong] of [
      ["정산 건수", rows.length + "건", false],
      ["일당 합계", won(total.wage) + "원", false],
      ["소개수수료", won(total.fee) + "원", false],
      ["원천징수(소득세+지방소득세)", won(total.taxIncome + total.taxLocal) + "원", false],
      ["구직자 지급액", won(total.net) + "원", true],
    ]) {
      const c = el("div");
      c.style.cssText = "background:var(--soft);border-radius:12px;padding:12px 14px";
      const l = el("div", label, "muted");
      const v = el("div", value);
      v.style.cssText = "font-size:" + (strong ? "20px" : "17px") + ";font-weight:700;margin-top:4px;" + (strong ? "color:var(--brand)" : "");
      c.append(l, v);
      grid.append(c);
    }
    box.append(grid);

    // 기간별 요약
    $("sumTitle").textContent = UNIT[unit] + " 요약";
    const sum = group(rows, unit);
    drawTable($("sumTable"), [{ h: "기간", f: (r) => r.period.label }, { h: "인원", f: (r) => r.workers.size, num: true }, ...moneyCols], sum, total);

    // 구직자 지급 목록: 기간 × 구직자
    const pay = group(rows, unit, (r) => ({ key: r.worker_id, name: r.worker_name, phone: r.worker_phone }));
    drawTable($("payTable"), [
      { h: "기간", f: (r) => r.period.label },
      { h: "구직자", f: (r) => r.extra.name },
      { h: "연락처", f: (r) => fmtPhone(r.extra.phone) },
      ...moneyCols,
    ], pay, total);

    // 의뢰인 청구 목록: 기간 × 의뢰인
    const bill = group(rows, unit, (r) => ({ key: r.client_id, name: r.client_name }));
    drawTable($("billTable"), [
      { h: "기간", f: (r) => r.period.label },
      { h: "의뢰인", f: (r) => r.extra.name },
      { h: "건수", k: "count", f: (r) => r.count, num: true },
      { h: "제시 일당 합계", k: "offered", f: (r) => won(r.offered), num: true, fmt: won },
      { h: "확정 단가 합계", k: "wage", f: (r) => won(r.wage), num: true, fmt: won },
      { h: "소개수수료", k: "fee", f: (r) => won(r.fee), num: true, fmt: won },
    ], bill, total);

    // 지점별 요약 (본사)
    if (isHq) {
      const map = new Map();
      for (const r of rows) {
        if (!map.has(r.branch_id)) map.set(r.branch_id, { name: r.branch_name, ...ZERO() });
        add(map.get(r.branch_id), r);
      }
      drawTable($("branchTable"), [{ h: "지점", f: (r) => r.name }, ...moneyCols], [...map.values()], total);
    }

    // 상세 내역 (화면에는 앞 500건만)
    const shown = rows.slice(0, 500);
    $("detailNote").textContent = rows.length > 500 ? "앞 500건만 보입니다. 전체는 엑셀 파일에 들어 있습니다." : "";
    drawTable($("detailTable"), [
      { h: "일자", f: (r) => r.work_date },
      { h: "구직자", f: (r) => r.worker_name },
      { h: "직종", f: (r) => r.job_name || "" },
      { h: "의뢰인", f: (r) => r.client_name },
      { h: "상태", f: (r) => STATUS[r.status] || r.status },
      { h: "의뢰인 확인", f: (r) => confLabel(r) },
      { h: "일당", f: (r) => won(r.wage), num: true },
      { h: "소개수수료", f: (r) => won(r.fee), num: true },
      { h: "원천징수", f: (r) => (r.tax_applied ? won(r.tax_income + r.tax_local) : "-"), num: true },
      { h: "지급액", f: (r) => won(r.net), num: true },
    ], shown, null);
  }

  // ───────── 조회 ─────────
  async function run() {
    $("err").textContent = "";
    const from = $("from").value, to = $("to").value;
    if (!from || !to) { $("err").textContent = "기간을 입력해 주세요."; return; }
    lastQuery = { from, to, unit: $("unit").value, branch: $("branchSel").value || null, incOut: $("incOut").checked };
    $("run").disabled = true;
    $("status").textContent = "불러오는 중...";
    try {
      allRows = await fetchRows(false);
      if (pickedId && !allRows.some((r) => r.worker_id === pickedId)) pickedId = "";   // 새 기간에 없는 사람이면 선택 해제
      applyWorker();
      $("xlsx").disabled = false;
      render();
    } catch (e) {
      allRows = rows = [];
      $("xlsx").disabled = true;
      $("print").disabled = true;
      $("totalCard").hidden = $("sumCard").hidden = $("payCard").hidden = $("billCard").hidden = $("branchCard").hidden = $("workerCard").hidden = $("detailCard").hidden = true;
      $("status").textContent = "";
      console.error(e);
      $("err").textContent = /[가-힣]/.test(e.message || "") ? e.message : "정산 자료를 불러오지 못했습니다. (" + (e.message || e) + ")";
    }
    $("run").disabled = false;
  }
  $("run").addEventListener("click", run);

  // ───────── 인쇄 / PDF ─────────
  $("print").addEventListener("click", () => {
    if (!rows.length) return;
    const who = (workerMatch() ? " - " + workerLabel() : "") + (confMatch() ? " - 의뢰인 확인: " + $("confF").selectedOptions[0].text : "");
    printPage("정산서 " + lastQuery.from + " ~ " + lastQuery.to + " (" + UNIT[lastQuery.unit] + ")" + who);
  });

  // ───────── 엑셀 ─────────
  $("xlsx").addEventListener("click", async () => {
    if (!lastQuery || !rows.length) return;
    if (!confirm("구직자 계좌번호가 포함된 파일입니다. 내려받은 파일은 안전하게 보관하시고, 내려받은 기록이 남습니다.\n계속할까요?")) return;
    $("xlsx").disabled = true;
    $("err").textContent = "";
    try {
      await db.rpc("log_settlement_export", { p_from: lastQuery.from, p_to: lastQuery.to, p_with_bank: true });
      let full = await fetchRows(true);
      const wm = workerMatch();
      if (isFiltered()) full = full.filter(rowOk);
      const unit = lastQuery.unit;
      const total = ZERO();
      for (const r of full) add(total, r);

      const wb = XLSX.utils.book_new();
      const sheet = (name, data, widths) => {
        const ws = XLSX.utils.json_to_sheet(data);
        ws["!cols"] = widths.map((w) => ({ wch: w }));
        XLSX.utils.book_append_sheet(wb, ws, name);
      };

      sheet("요약", [
        ...group(full, unit).map((g) => ({
          "기간": g.period.label, "인원": g.workers.size, "건수": g.count, "일당(확정 단가)": g.wage,
          "소개수수료": g.fee, "소득세": g.taxIncome, "지방소득세": g.taxLocal, "구직자 지급액": g.net,
        })),
        { "기간": "합계", "건수": total.count, "일당(확정 단가)": total.wage, "소개수수료": total.fee,
          "소득세": total.taxIncome, "지방소득세": total.taxLocal, "구직자 지급액": total.net },
      ], [26, 8, 8, 16, 14, 12, 12, 16]);

      // 지급 목록: 기간 × 구직자 (+ 계좌)
      const bankOf = new Map();
      for (const r of full) if (r.account_number && !bankOf.has(r.worker_id)) bankOf.set(r.worker_id, r);
      sheet("지급 목록", group(full, unit, (r) => ({ key: r.worker_id, name: r.worker_name, phone: r.worker_phone })).map((g) => {
        const b = bankOf.get(g.extra.key);
        return {
          "기간": g.period.label, "구직자": g.extra.name, "연락처": fmtPhone(g.extra.phone), "건수": g.count,
          "일당 합계": g.wage, "소개수수료": g.fee, "지급 기준액(일당-수수료)": g.wage - g.fee,
          "소득세": g.taxIncome, "지방소득세": g.taxLocal, "지급액": g.net,
          "은행": b ? b.bank_name : "", "계좌번호": b ? String(b.account_number) : "", "예금주": b ? b.account_holder : "",
        };
      }), [26, 12, 15, 8, 14, 12, 20, 12, 12, 14, 12, 22, 12]);

      sheet("청구 목록", group(full, unit, (r) => ({ key: r.client_id, name: r.client_name })).map((g) => ({
        "기간": g.period.label, "의뢰인": g.extra.name, "건수": g.count,
        "제시 일당 합계": g.offered, "확정 단가 합계": g.wage, "소개수수료": g.fee,
      })), [26, 20, 8, 16, 16, 14]);

      if (isHq) {
        const map = new Map();
        for (const r of full) {
          if (!map.has(r.branch_id)) map.set(r.branch_id, { name: r.branch_name, ...ZERO() });
          add(map.get(r.branch_id), r);
        }
        sheet("지점별 요약", [...map.values()].map((g) => ({
          "지점": g.name, "건수": g.count, "일당(확정 단가)": g.wage, "소개수수료": g.fee,
          "소득세": g.taxIncome, "지방소득세": g.taxLocal, "구직자 지급액": g.net,
        })), [22, 8, 16, 14, 12, 12, 16]);
      }

      sheet("상세 내역", full.map((r) => ({
        "일자": r.work_date, "지점": r.branch_name, "구직자": r.worker_name, "연락처": fmtPhone(r.worker_phone),
        "직종": r.job_name || "", "의뢰인": r.client_name, "상태": STATUS[r.status] || r.status, "의뢰인 확인": confLabel(r),
        "일당(확정 단가)": r.wage, "제시 일당": r.offered_wage, "소개수수료": r.fee,
        "원천징수 적용": r.tax_applied ? "적용" : "미적용", "소득세": r.tax_income, "지방소득세": r.tax_local, "구직자 지급액": r.net,
      })), [12, 16, 12, 15, 12, 18, 18, 12, 14, 12, 12, 12, 10, 12, 14]);

      XLSX.writeFile(wb, "정산_" + (isFiltered() && full.length ? (pickedId ? full[0].worker_name : wm ? "검색결과" : "조건결과") + "_" : "") + UNIT[unit] + "_" + lastQuery.from + "_" + lastQuery.to + ".xlsx");
    } catch (e) {
      $("err").textContent = /[가-힣]/.test(e.message || "") ? e.message : "엑셀 파일을 만들지 못했습니다.";
    }
    $("xlsx").disabled = false;
  });

  await run();
})();
