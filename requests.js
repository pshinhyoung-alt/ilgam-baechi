(async () => {
  const me = await requireStaff("requests.html");
  if (!me) return;
  const isAdmin = me.role !== "branch_staff";
  const isHq = me.role === "hq_admin";
  const canWage = !!me.can_edit_wage;
  const STATUS = { received: "접수", assigning: "배치중", confirmed: "확정", in_progress: "진행중", done: "완료", hold: "보류" };

  let jobTypes = [], branches = [], clients = [], rows = [], shown = [], editing = null, wageTouched = false, syncWage = true, counts = {}, workerNames = {}, convertFrom = null;
  let clientOnlyId = new URLSearchParams(location.search).get("client") || "";   // 의뢰인 화면에서 넘어온 경우 그 의뢰인 것만
  let settings = { min_hourly_wage: 0, default_radius_m: 300, default_fee_rate: 10, max_fee_rate: null, income_tax_rate: 3, local_tax_rate: 10 };
  const $ = (id) => document.getElementById(id);

  const views = [["all", "전체"], ["open", "진행 중 인력의뢰"], ["hold", "보류"], ["done", "완료"]];
  if (isAdmin) views.push(["trash", "휴지통"]);
  for (const [v, label] of views) $("view").append(new Option(label, v));

  const won = (n) => Number(n).toLocaleString("ko-KR") + "원";
  const hhmm = (t) => t.slice(0, 5);

  // 시·분을 따로 고르는 시간 입력 (분은 10분 단위)
  function timeField(boxId) {
    const h = document.createElement("select");
    const m = document.createElement("select");
    h.required = m.required = true;
    h.append(new Option("시", ""));
    for (let i = 0; i < 24; i++) h.append(new Option(String(i).padStart(2, "0") + "시", String(i).padStart(2, "0")));
    m.append(new Option("분", ""));
    for (let i = 0; i < 60; i += 10) m.append(new Option(String(i).padStart(2, "0") + "분", String(i).padStart(2, "0")));
    $(boxId).append(h, m);
    return {
      get: () => (h.value && m.value ? h.value + ":" + m.value : ""),
      set: (t) => {
        const [hh, mm] = t ? t.split(":") : ["", ""];
        // 예전에 10분 단위가 아닌 값으로 저장된 기록이 있어도 잃지 않도록 선택지에 추가
        if (mm && ![...m.options].some((o) => o.value === mm)) m.append(new Option(mm + "분", mm));
        h.value = hh;
        m.value = mm;
      },
      onChange: (fn) => { h.addEventListener("change", fn); m.addEventListener("change", fn); },
    };
  }
  const startT = timeField("startBox");
  const endT = timeField("endBox");

  function workHours(start, end) {
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    let m = eh * 60 + em - (sh * 60 + sm);
    if (m <= 0) m += 1440;
    return m / 60;
  }
  // 시간당 환산액이 최저임금보다 낮으면 문구를 돌려줌 (휴게시간은 반영하지 않은 단순 계산)
  function wageWarning(wage, start, end) {
    if (!wage || !start || !end || !settings.min_hourly_wage) return "";
    const hourly = Math.round(wage / workHours(start, end));
    return hourly < settings.min_hourly_wage
      ? "시간당 약 " + hourly.toLocaleString("ko-KR") + "원 — 최저임금(" + settings.min_hourly_wage.toLocaleString("ko-KR") + "원)보다 낮습니다."
      : "";
  }

  // 머리글을 눌러 정렬: 작업 일시, 의뢰인, 직종, 필요 인원, 현장, 제시 단가, 확정 단가, 출근 반경, 상태
  const nameMaps = { client: {}, job: {} };
  const sorter = setupSort(document.querySelector("main table"), [
    (r) => r.work_date + " " + r.start_time, (r) => nameMaps.client[r.client_id] || "", (r) => nameMaps.job[r.job_type_id] || "",
    (r) => r.headcount, (r) => r.address, (r) => r.offered_wage, (r) => r.wage, (r) => r.radius_m,
    (r) => (r.deleted_at ? "휴지통" : STATUS[r.status]), null,
  ], () => render());

  $("print").addEventListener("click", () => {
    const q = $("q").value.trim();
    const notes = [$("view").selectedOptions[0].text];
    if ($("jobF").value) notes.push($("jobF").selectedOptions[0].text);
    if ($("df").value || $("dt").value) notes.push(($("df").value || "") + "~" + ($("dt").value || ""));
    if ($("lackF").checked) notes.push("인원 부족만");
    if (clientOnlyId) notes.push($("clientBarName").textContent);
    if (q) notes.push("검색: " + q);
    printPage("인력의뢰 목록 - " + notes.join(", "));
  });

  async function loadBase() {
    const [jt, br, cl, st] = await Promise.all([
      db.from("job_types").select("*").order("sort_order"),
      db.from("branches").select("id,name").order("name"),
      db.from("clients").select("id,name,branch_id,deleted_at").order("name"),
      db.from("app_settings").select("*").maybeSingle(),
    ]);
    jobTypes = jt.data || [];
    branches = br.data || [];
    clients = cl.data || [];
    for (const j of jobTypes) if (j.active !== false) $("jobF").append(new Option(j.name, j.id));
    if (st.data) settings = st.data;
    if (isHq) {
      $("branchRow").hidden = false;
      for (const b of branches) $("branch").append(new Option(b.name, b.id));
    }
  }

  async function load() {
    const { data, error } = await db.from("job_requests").select("*")
      .order("work_date", { ascending: false }).order("start_time", { ascending: false });
    if (error) { $("empty").textContent = "목록을 불러오지 못했습니다."; return; }
    rows = data;
    // 인력의뢰별 배치된 인원 수
    // (검색용으로 배치된 구직자 이름도 함께. 이름을 못 가져오면 인원 수만 사용)
    let { data: asg, error: asgErr } = await db.from("assignments").select("request_id, workers(name)").not("status", "in", "(cancelled,declined)");
    if (asgErr) ({ data: asg } = await db.from("assignments").select("request_id").not("status", "in", "(cancelled,declined)"));
    counts = {};
    workerNames = {};
    for (const a of asg || []) {
      counts[a.request_id] = (counts[a.request_id] || 0) + 1;
      if (a.workers && a.workers.name) (workerNames[a.request_id] = workerNames[a.request_id] || []).push(a.workers.name);
    }
    render();
  }

  function render() {
    const q = $("q").value.trim().toLowerCase();
    const view = $("view").value;
    const jf = $("jobF").value, df = $("df").value, dt = $("dt").value, lack = $("lackF").checked;
    $("clientBar").hidden = !clientOnlyId;
    if (clientOnlyId) $("clientBarName").textContent = (clients.find((c) => c.id === clientOnlyId) || {}).name || "선택한 의뢰인";
    const clientName = nameMaps.client = Object.fromEntries(clients.map((c) => [c.id, c.name]));
    const jobName = nameMaps.job = Object.fromEntries(jobTypes.map((j) => [j.id, j.name]));
    const list = sorter(rows.filter((r) => {
      if (view === "trash" ? !r.deleted_at : r.deleted_at) return false;
      if (view === "open" && ["done", "hold"].includes(r.status)) return false;
      if (view === "hold" && r.status !== "hold") return false;
      if (view === "done" && r.status !== "done") return false;
      if (clientOnlyId && r.client_id !== clientOnlyId) return false;
      if (jf && r.job_type_id !== jf) return false;
      if (df && r.work_date < df) return false;
      if (dt && r.work_date > dt) return false;
      if (lack && (["done", "hold"].includes(r.status) || (counts[r.id] || 0) >= r.headcount)) return false;
      if (!q) return true;
      return [clientName[r.client_id], r.address, jobName[r.job_type_id], r.requirements, (workerNames[r.id] || []).join(" ")]
        .join("\n").toLowerCase().includes(q);
    }));

    shown = list;
    const tbody = $("rows");
    tbody.replaceChildren();
    $("empty").textContent = list.length ? "" : "표시할 인력의뢰가 없습니다.";
    for (const r of list) {
      const tr = document.createElement("tr");
      const wageTd = el("td", won(r.wage));
      const warn = wageWarning(r.wage, r.start_time, r.end_time);
      if (warn) wageTd.append(el("div", "최저임금 미만 가능", "tag warn"));
      if (r.wage !== r.offered_wage) wageTd.append(el("div", "제시 일당과 다름", "tag"));
      if (r.fee_enabled) wageTd.append(el("div", "수수료 " + r.fee_rate + "%", "tag"));
      if (r.tax_enabled) wageTd.append(el("div", "원천징수 3.3%", "tag"));
      const jobTd = el("td", jobName[r.job_type_id] || "(삭제된 직종)");
      if (r.cert_pref === "require") jobTd.append(el("div", "자격증 필수", "tag warn"));
      else if (r.cert_pref === "prefer") jobTd.append(el("div", "자격증 우선", "tag"));
      if (r.min_topik) jobTd.append(el("div", "한국어 TOPIK " + r.min_topik + "급↑", "tag"));
      const addrTd = el("td", r.address);
      if (r.lat == null) addrTd.append(el("div", "좌표 없음", "tag warn"));
      const stTd = el("td", r.deleted_at ? "휴지통" : STATUS[r.status]);
      stTd.style.minWidth = "120px";
      if (r.status === "hold" && r.hold_reason) stTd.append(el("div", "사유: " + r.hold_reason, "muted"));
      tr.append(
        el("td", r.work_date + " " + hhmm(r.start_time) + "~" + hhmm(r.end_time)),
        el("td", clientName[r.client_id] || "-"),
        jobTd,
        el("td", (counts[r.id] || 0) + "/" + r.headcount + "명"),
        addrTd, el("td", won(r.offered_wage)), wageTd, el("td", r.radius_m + "m"), stTd, actions(r));
      tbody.append(tr);
    }
  }

  // 지금 화면에 보이는 목록(검색·보기 적용)을 엑셀로
  $("xlsx").addEventListener("click", () => {
    if (!shown.length) { alert("내려받을 인력의뢰가 없습니다."); return; }
    const clientName = Object.fromEntries(clients.map((c) => [c.id, c.name]));
    const jobName = Object.fromEntries(jobTypes.map((j) => [j.id, j.name]));
    saveXlsx("인력의뢰", "인력의뢰",
      ["작업일", "시작", "종료", "의뢰인", "직종", "필요 인원", "배치 인원", "현장 주소", "제시 단가", "확정 단가", "출근 반경(m)", "상태", "보류 사유"],
      shown.map((r) => [
        r.work_date, hhmm(r.start_time), hhmm(r.end_time), clientName[r.client_id] || "", jobName[r.job_type_id] || "(삭제된 직종)",
        r.headcount, counts[r.id] || 0, r.address, r.offered_wage, r.wage, r.radius_m,
        r.deleted_at ? "휴지통" : STATUS[r.status], r.status === "hold" ? r.hold_reason || "" : "",
      ]));
  });

  function btn(label, cls, fn) {
    const b = el("button", label, cls);
    b.addEventListener("click", async () => { b.disabled = true; await fn(); b.disabled = false; });
    return b;
  }

  async function run(promise, failMsg) {
    const { error } = await promise;
    if (error) { alert(/[가-힣]/.test(error.message) ? error.message : failMsg); return; }
    await load();
  }

  function actions(r) {
    const box = el("div", undefined, "acts");
    if (r.deleted_at) {
      box.append(
        btn("복구", "", () => run(db.from("job_requests").update({ deleted_at: null }).eq("id", r.id), "복구하지 못했습니다.")),
        btn("완전 삭제", "danger", async () => {
          if (!confirm("이 인력의뢰를 완전히 삭제합니다. 단가 이력도 함께 사라지며 되돌릴 수 없습니다. 계속할까요?")) return;
          await run(db.from("job_requests").delete().eq("id", r.id), "삭제하지 못했습니다. 배치 기록이 있는 인력의뢰는 완전히 삭제할 수 없습니다.");
        }));
    } else {
      box.append(
        btn("배치", "primary", async () => AssignUI.open(r, {
          me,
          clientName: (clients.find((c) => c.id === r.client_id) || {}).name || "-",
          jobName: (jobTypes.find((j) => j.id === r.job_type_id) || {}).name || "(삭제된 직종)",
          trainReq: !!(jobTypes.find((j) => j.id === r.job_type_id) || {}).training_required,
          settings,
          onChange: load,
        })),
        btn("수정", "", async () => openForm(r)),
        btn("단가 이력", "", () => showHistory(r)));
      if (isAdmin) {
        if (r.status === "hold") {
          box.append(
            btn("재개", "", () => run(db.from("job_requests").update({ status: r.hold_prev_status || "received" }).eq("id", r.id), "재개하지 못했습니다.")),
            btn("사유 수정", "", async () => {
              const reason = prompt("보류 사유를 입력하세요.", r.hold_reason || "");
              if (reason === null || !reason.trim() || reason.trim() === r.hold_reason) return;
              await run(db.from("job_requests").update({ hold_reason: reason.trim() }).eq("id", r.id), "사유를 바꾸지 못했습니다.");
            }));
        } else {
          box.append(btn("보류", "", async () => {
            const reason = prompt("보류 사유를 입력하세요.");
            if (!reason || !reason.trim()) return;
            await run(db.from("job_requests").update({ status: "hold", hold_reason: reason.trim() }).eq("id", r.id), "보류하지 못했습니다.");
          }));
        }
        box.append(btn("삭제", "danger", async () => {
          if (!confirm("이 인력의뢰를 휴지통으로 보냅니다. 휴지통에서 복구할 수 있습니다.")) return;
          await run(db.from("job_requests").update({ deleted_at: new Date().toISOString() }).eq("id", r.id), "삭제하지 못했습니다.");
        }));
      }
    }
    const td = el("td");
    td.append(box);
    return td;
  }

  async function showHistory(r) {
    const { data, error } = await db.from("wage_history").select("*").eq("request_id", r.id).order("at", { ascending: false });
    const tb = $("hrows");
    tb.replaceChildren();
    if (error || !data.length) {
      const tr = document.createElement("tr");
      tr.append(el("td", error ? "이력을 불러오지 못했습니다." : "이력이 없습니다."));
      tb.append(tr);
    }
    for (const h of data || []) {
      const tr = document.createElement("tr");
      const d = new Date(h.at);
      const pad = (n) => String(n).padStart(2, "0");
      const noWrap = (td) => { td.style.whiteSpace = "nowrap"; return td; };
      tr.append(
        noWrap(el("td", d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()))),
        noWrap(el("td", h.actor_name || "-")),
        noWrap(el("td", h.kind === "offered" ? "제시 일당" : "확정 단가")),
        noWrap(el("td", (h.old_wage == null ? "" : won(h.old_wage) + " → ") + won(h.new_wage))),
        el("td", h.reason || ""));
      tb.append(tr);
    }
    $("hdlg").showModal();
  }

  function fillClients(branchId) {
    const sel = $("client");
    sel.replaceChildren(new Option("선택하세요", ""));
    for (const c of clients) if (!c.deleted_at && c.branch_id === branchId) sel.append(new Option(c.name, c.id));
  }

  function updateWarn() {
    const w = Number($("wage").value || $("offered").value);
    $("wageWarn").textContent = wageWarning(w, startT.get(), endT.get());
  }

  // 소개수수료: 현재 입력된(또는 적용될) 수수료율. 권한이 없으면 기존 값/기본값
  function currentFeeRate() {
    if (!canWage) return Number(editing ? editing.fee_rate : settings.default_fee_rate);
    return Number($("feeRate").value);
  }

  // 소개수수료 금액(1인 기준)
  function currentFeeAmount() {
    if (!$("feeOn").checked) return 0;
    const wage = Number($("wage").value || $("offered").value) || 0;
    return Math.round((wage * currentFeeRate()) / 100);
  }

  // 사업소득세 원천징수 3.3%: 소개수수료를 뺀 금액을 기준으로 계산 (서버의 tax_calc 와 같은 방식)
  function updateTax() {
    const on = $("taxOn").checked;
    $("taxBox").hidden = !on;
    if (!on) return;
    const wage = Number($("wage").value || $("offered").value) || 0;
    if (!wage) { $("taxPreview").textContent = ""; return; }
    const base = wage - currentFeeAmount();
    const t = calcTax(base, settings);
    $("taxPreview").textContent = "1인 기준 원천징수(예상) " + won(t.total) + " = 소득세 " + won(t.income) + " + 지방소득세 " + won(t.local)
      + " — 기준액 " + won(base) + " (일당 − 소개수수료)";
  }

  function updateNet() {
    const box = $("netPreview");
    const feeOn = $("feeOn").checked, taxOn = $("taxOn").checked;
    const wage = Number($("wage").value || $("offered").value) || 0;
    if ((!feeOn && !taxOn) || !wage) { box.textContent = ""; return; }
    const fee = currentFeeAmount();
    const tax = taxOn ? calcTax(wage - fee, settings).total : 0;
    box.textContent = "1인 기준 구직자 지급 예정액 " + won(wage - fee - tax) + " (일당 " + won(wage)
      + (fee ? " − 수수료 " + won(fee) : "") + (tax ? " − 원천징수 " + won(tax) : "") + ")";
  }

  // 수수료·원천징수·지급 예정액 표시를 한꺼번에 갱신
  function updateFee() {
    updateFeeBox();
    updateTax();
    updateNet();
  }

    function updateFeeBox() {
    const on = $("feeOn").checked;
    $("feeBox").hidden = !on;
    if (!on) return;
    const rate = currentFeeRate();
    const wage = Number($("wage").value || $("offered").value) || 0;
    $("feeNote").textContent = canWage
      ? "기본 " + settings.default_fee_rate + "% 입니다. 거리 등에 따라 바꿀 수 있고, 구직자별 조정은 배치 창에서 합니다."
      : "기본 " + settings.default_fee_rate + "% 가 적용됩니다. 바꾸려면 단가·수수료 수정 권한이 필요합니다.";
    if (wage && rate >= 0 && rate <= 100) {
      const fee = Math.round((wage * rate) / 100);
      $("feePreview").textContent = "1인 기준 소개수수료 " + won(fee);
    } else {
      $("feePreview").textContent = "";
    }
    const max = settings.max_fee_rate;
    $("feeWarn").textContent = max != null && rate > Number(max)
      ? "수수료율이 설정된 상한(" + max + "%)을 넘습니다. 법정 기준을 확인하세요."
      : "";
  }

  // 확정 단가 칸 아래 안내 문구. 입력 상태에 따라 바뀜
  function updateWageNote() {
    let text;
    if (!canWage) {
      text = "단가 수정 권한이 없어 제시 일당이 확정 단가로 자동 입력됩니다.";
    } else {
      const same = $("wage").value === $("offered").value;
      text = same
        ? "확정 단가가 제시 일당과 같습니다. 다르게 정하려면 직접 입력하세요."
        : "확정 단가가 제시 일당과 다르게 입력되어 있습니다.";
      if (editing) text += " 바꾸면 사유를 물어보고, 누가·언제·얼마로 바꿨는지 기록합니다.";
    }
    $("wageNote").textContent = text;
  }

  function openForm(r) {
    convertFrom = null;   // 접수함에서 넘어온 경우는 열고 난 뒤에 따로 표시
    editing = r || null;
    wageTouched = false;
    // 확정 단가가 제시 일당과 같은 상태였다면, 제시 일당을 바꿀 때 확정 단가도 함께 바뀜
    syncWage = !r || r.wage === r.offered_wage;
    const branchId = r ? r.branch_id : (me.branch_id || branches[0]?.id);
    if (isHq) $("branch").value = branchId;
    fillClients(branchId);
    $("dlgTitle").textContent = r ? "인력의뢰 수정" : "인력의뢰 접수";
    $("client").value = r ? r.client_id : "";
    $("date").value = r ? r.work_date : "";
    startT.set(r ? hhmm(r.start_time) : "");
    endT.set(r ? hhmm(r.end_time) : "");
    $("address").value = r ? r.address : "";
    $("lat").value = r && r.lat != null ? r.lat : "";
    $("lng").value = r && r.lng != null ? r.lng : "";
    $("geoNote").textContent = "";
    $("headcount").value = r ? r.headcount : 1;
    $("req").value = r ? r.requirements || "" : "";
    $("certPref").value = r ? r.cert_pref || "none" : "none";
    $("minTopik").value = r && r.min_topik ? r.min_topik : "";
    $("offered").value = r ? r.offered_wage : "";
    $("wage").value = r ? r.wage : "";
    $("radius").value = r ? r.radius_m : settings.default_radius_m;
    $("feeOn").checked = r ? !!r.fee_enabled : false;
    $("feeRate").value = r ? r.fee_rate : settings.default_fee_rate;
    $("feeRate").disabled = !canWage;
    $("taxOn").checked = r ? !!r.tax_enabled : false;


    const jobSel = $("job");
    jobSel.replaceChildren(new Option("선택하세요", ""));
    for (const j of jobTypes) if (j.active || (r && r.job_type_id === j.id)) jobSel.append(new Option(j.name, j.id));
    jobSel.value = r ? r.job_type_id : "";

    // 단가 칸은 단가 수정 권한이 있는 계정만 고칠 수 있음
    $("wage").disabled = !canWage;
    $("offered").disabled = !!r && !canWage;
    updateWageNote();
    $("err").textContent = "";
    updateWarn();
    updateFee();
    $("dlg").showModal();
  }

  $("add").addEventListener("click", () => openForm(null));
  $("cancel").addEventListener("click", () => $("dlg").close());
  $("hclose").addEventListener("click", () => $("hdlg").close());
  $("q").addEventListener("input", render);
  $("view").addEventListener("change", render);
  for (const id of ["jobF", "df", "dt", "lackF"]) $(id).addEventListener("change", render);
  for (const b of document.querySelectorAll("[data-p]")) b.addEventListener("click", () => {
    [$("df").value, $("dt").value] = datePreset(b.dataset.p);
    render();
  });
  $("dClear").addEventListener("click", () => { $("df").value = $("dt").value = ""; render(); });
  $("clientBarX").addEventListener("click", () => { clientOnlyId = ""; history.replaceState(null, "", location.pathname); render(); });
  $("branch").addEventListener("change", () => fillClients($("branch").value));
  $("wage").addEventListener("input", () => { wageTouched = true; updateWarn(); updateWageNote(); updateFee(); });
  $("feeOn").addEventListener("change", () => {
    // 새로 체크하면 기본 수수료율부터 시작
    if ($("feeOn").checked && canWage && !editing) $("feeRate").value = settings.default_fee_rate;
    updateFee();
  });
  $("feeRate").addEventListener("input", updateFee);
  $("taxOn").addEventListener("change", updateFee);

  startT.onChange(updateWarn);
  endT.onChange(updateWarn);

  // ───────── 현장 좌표 ─────────
  function mapLink(lat, lng) {
    const a = document.createElement("a");
    a.href = "https://map.kakao.com/link/map/" + encodeURIComponent("현장") + "," + lat + "," + lng;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "지도에서 확인";
    return a;
  }

  function loadKakao(key) {
    return new Promise((resolve, reject) => {
      if (window.kakao && kakao.maps && kakao.maps.services) return resolve();
      const s = document.createElement("script");
      s.src = "https://dapi.kakao.com/v2/maps/sdk.js?appkey=" + encodeURIComponent(key) + "&libraries=services&autoload=false";
      s.onload = () => kakao.maps.load(resolve);
      s.onerror = () => reject(new Error("load"));
      document.head.append(s);
    });
  }

  $("geo").addEventListener("click", async () => {
    const note = $("geoNote");
    const address = $("address").value.trim();
    if (!address) { note.textContent = "현장 주소를 먼저 입력해 주세요."; return; }
    const key = window.APP_CONFIG.KAKAO_JS_KEY;
    if (!key) { note.textContent = "카카오 지도 키가 아직 설정되지 않았습니다. 아래 [내 현재 위치로 입력]을 쓰거나 좌표를 직접 입력해 주세요."; return; }
    note.textContent = "찾는 중...";
    try {
      await loadKakao(key);
      const found = await new Promise((resolve, reject) => {
        new kakao.maps.services.Geocoder().addressSearch(address, (res, status) => {
          if (status === kakao.maps.services.Status.OK && res[0]) resolve({ lat: Number(res[0].y), lng: Number(res[0].x) });
          else reject(new Error("notfound"));
        });
      });
      $("lat").value = found.lat.toFixed(6);
      $("lng").value = found.lng.toFixed(6);
      note.textContent = "좌표를 찾았습니다. 주소가 맞는지 확인해 주세요. ";
      note.append(mapLink(found.lat, found.lng));
    } catch (e) {
      note.textContent = e.message === "notfound"
        ? "주소로 좌표를 찾지 못했습니다. 주소를 더 자세히 쓰거나 좌표를 직접 입력해 주세요."
        : "지도 서비스를 불러오지 못했습니다. 키와 등록한 사이트 주소를 확인해 주세요.";
    }
  });

  $("geoHere").addEventListener("click", () => {
    const note = $("geoNote");
    if (!navigator.geolocation) { note.textContent = "이 브라우저는 위치 기능을 지원하지 않습니다."; return; }
    note.textContent = "위치를 확인하는 중...";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        $("lat").value = pos.coords.latitude.toFixed(6);
        $("lng").value = pos.coords.longitude.toFixed(6);
        note.textContent = "현재 위치(오차 약 " + Math.round(pos.coords.accuracy) + "m)로 입력했습니다. 현장에서 누른 것이 아니라면 현장 좌표가 아니니 지우거나 고쳐 주세요. ";
        note.append(mapLink(pos.coords.latitude, pos.coords.longitude));
      },
      () => { note.textContent = "위치를 가져오지 못했습니다. 브라우저의 위치 권한을 허용해 주세요."; },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });

  $("f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const radius = Number($("radius").value);
    if (!(radius >= 50 && radius <= 2000)) { $("err").textContent = "출근 반경은 50~2000m 사이로 입력해 주세요."; return; }
    const latStr = $("lat").value.trim(), lngStr = $("lng").value.trim();
    if ((latStr === "") !== (lngStr === "")) { $("err").textContent = "위도와 경도를 모두 입력하거나 모두 비워 주세요."; return; }
    const taxOn = $("taxOn").checked;
    const feeOn = $("feeOn").checked;
    const feeRate = currentFeeRate();
    if (feeOn && !(feeRate >= 0 && feeRate <= 100)) { $("err").textContent = "소개수수료율은 0~100 사이로 입력해 주세요."; return; }
    let lat = null, lng = null;
    if (latStr !== "") {
      lat = Number(latStr);
      lng = Number(lngStr);
      if (!(lat >= 32 && lat <= 39.5 && lng >= 123 && lng <= 133)) {
        $("err").textContent = "좌표가 대한민국 안이 아닙니다. 위도(37 안팎)와 경도(127 안팎)가 서로 바뀌지 않았는지 확인해 주세요.";
        return;
      }
    }
    const payload = {
      client_id: $("client").value,
      job_type_id: $("job").value,
      work_date: $("date").value,
      start_time: startT.get(),
      end_time: endT.get(),
      address: $("address").value.trim(),
      headcount: Number($("headcount").value),
      requirements: $("req").value.trim() || null,
      cert_pref: $("certPref").value,
      min_topik: $("minTopik").value ? Number($("minTopik").value) : null,
      radius_m: radius,
      lat,
      lng,
      fee_enabled: feeOn,
      fee_rate: feeOn ? feeRate : settings.default_fee_rate,
      tax_enabled: taxOn,
    };
    const offered = Number($("offered").value);
    const wageVal = $("wage").value ? Number($("wage").value) : offered;

    if (!editing) {
      payload.branch_id = isHq ? $("branch").value : me.branch_id;
      payload.offered_wage = offered;
      if (canWage && wageVal !== offered) payload.wage = wageVal;
    } else {
      if (isHq) payload.branch_id = $("branch").value;
      if (canWage) {
        const offeredChanged = offered !== editing.offered_wage;
        const wageChanged = wageVal !== editing.wage;
        if (offeredChanged || wageChanged) {
          const lines = [];
          if (offeredChanged) lines.push("의뢰인 제시 일당 " + won(editing.offered_wage) + " → " + won(offered));
          if (wageChanged) lines.push("확정 단가 " + won(editing.wage) + " → " + won(wageVal));
          const reason = prompt(lines.join("\n") + "\n\n바꾸는 사유를 입력하세요.");
          if (!reason || !reason.trim()) return;
          if (offeredChanged) payload.offered_wage = offered;
          if (wageChanged) payload.wage = wageVal;
          payload.wage_reason = reason.trim();
        }
      }
    }

    $("save").disabled = true;
    let newId = null;
    let error;
    if (editing) {
      ({ error } = await db.from("job_requests").update(payload).eq("id", editing.id));
    } else {
      const res = await db.from("job_requests").insert(payload).select("id").single();
      error = res.error;
      if (!error) newId = res.data.id;
    }
    $("save").disabled = false;
    if (error) {
      $("err").textContent = /[가-힣]/.test(error.message) ? error.message : "저장하지 못했습니다. 입력 내용을 확인해 주세요.";
      return;
    }
    $("dlg").close();
    // 접수함에서 시작한 경우: 접수를 '전환완료'로 표시
    if (convertFrom && newId) {
      await db.rpc("mark_inquiry_converted", { p_inquiry: convertFrom.id, p_client: payload.client_id, p_request: newId, p_worker: null });
      convertFrom = null;
    }
    await load();
  });

  // 접수함에서 [인력의뢰 만들기]로 넘어온 경우: 의뢰인을 찾거나 만들고, 입력 창을 접수 내용으로 미리 채움
  async function startFromInquiry(id) {
    history.replaceState(null, "", "requests.html");
    const { data: q } = await db.from("inquiries").select("*").eq("id", id).maybeSingle();
    if (!q || q.type !== "인력요청") { alert("접수를 찾을 수 없거나 인력 요청 접수가 아닙니다."); return; }
    if (q.status === "전환완료" && !confirm("이미 전환된 접수입니다. 그래도 새 인력의뢰를 만들까요?")) return;

    // 같은 연락처의 의뢰인이 있으면 쓰고, 없으면 새로 만듦
    let clientId;
    const found = await db.from("clients").select("id,name,branch_id,deleted_at")
      .eq("branch_id", q.branch_id).eq("phone", q.phone_digits).is("deleted_at", null).limit(1);
    if (found.data && found.data.length) {
      clientId = found.data[0].id;
    } else {
      const made = await db.from("clients").insert({
        branch_id: q.branch_id, name: q.name || "홈페이지 접수", phone: q.phone_digits,
        address: q.location || null, memo: "홈페이지 접수 " + q.receipt_no,
      }).select("id,name,branch_id,deleted_at").single();
      if (made.error) { alert("의뢰인을 만들지 못했습니다. 연락처를 확인해 주세요."); return; }
      clientId = made.data.id;
      clients.push(made.data);
    }

    openForm(null);
    convertFrom = q;
    if (isHq) $("branch").value = q.branch_id;
    fillClients(q.branch_id);
    $("client").value = clientId;
    $("dlgTitle").textContent = "인력의뢰 접수 (홈페이지 접수 " + q.receipt_no + ")";
    $("date").value = /^\d{4}-\d{2}-\d{2}$/.test(q.schedule || "") ? q.schedule : "";
    $("address").value = q.location || "";
    const n = parseInt(q.headcount, 10);
    $("headcount").value = n >= 1 ? n : 1;
    const ids = jobIdsFromText(q.field, jobTypes.filter((j) => j.active));
    $("job").value = ids[0] || "";
    $("req").value = [q.period && "근무 기간: " + q.period, q.details].filter(Boolean).join("\n").slice(0, 500);
    $("err").textContent = "접수 내용으로 미리 채웠습니다. 작업 시간과 일당을 입력하고 저장하세요.";
  }

  await loadBase();
  await load();
  const inqId = new URLSearchParams(location.search).get("inq");
  if (inqId) await startFromInquiry(inqId);
})();
