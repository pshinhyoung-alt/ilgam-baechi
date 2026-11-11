// 구직자 배치 창. requests.js 가 AssignUI.open(...) 으로 엽니다.
const AssignUI = (() => {
  const $ = (id) => document.getElementById(id);
  const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
  const STATUS = { received: "접수", assigning: "배치중", confirmed: "확정", in_progress: "진행중", done: "완료", hold: "보류" };
  const ASTATUS = {
    assigned: "응답 대기", notified: "안내 발송", accepted: "수락", declined: "거절", cancelled: "취소",
    working: "근무 중 (출근)", checked_out: "퇴근", completed: "작업 완료",
  };
  const INACTIVE = ["cancelled", "declined"];
  const hhmm = (t) => t.slice(0, 5);
  const clock = (iso) => { const d = new Date(iso); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
  const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const span = (r) => {
    const s = toMin(r.start_time);
    let e = toMin(r.end_time);
    if (e <= s) e += 1440;
    return [s, e];
  };
  const tag = (text, warn) => el("span", text, "tag" + (warn ? " warn" : ""));

  let req = null, ctx = null, workers = [], assigned = [], past = [], sameDay = [], certSet = new Set();

  // 구직자에게 보낼 링크 (이 화면과 같은 위치의 w.html)
  function linkFor(a) {
    return location.origin + location.pathname.replace(/[^/]*$/, "") + "w.html?t=" + a.token;
  }

  async function copyLink(a, name) {
    const url = linkFor(a);
    try {
      await navigator.clipboard.writeText(url);
      $("aErr").textContent = "";
      $("aInfo").textContent = (name || "구직자") + " 님에게 보낼 링크를 복사했습니다. 카카오톡 등에 붙여넣어 보내 주세요.";
    } catch (e) {
      prompt("아래 링크를 복사해서 구직자에게 보내 주세요.", url);
    }
  }

  async function reload() {
    const [rq, ws, mine, day, dc] = await Promise.all([
      db.from("job_requests").select("*").eq("id", req.id).maybeSingle(),
      db.from("workers").select("*").eq("branch_id", req.branch_id).is("deleted_at", null).order("name"),
      db.from("assignments").select("*").eq("request_id", req.id).order("assigned_at"),
      db.from("assignments")
        .select("worker_id,request_id,job_requests!inner(work_date,start_time,end_time)")
        .not("status", "in", "(cancelled,declined)")
        .eq("job_requests.work_date", req.work_date),
      db.from("worker_documents").select("worker_id").eq("kind", "qualification"),
    ]);
    if (!rq.data) { $("adlg").close(); ctx.onChange(); return; }
    if (ws.error || mine.error || day.error) { $("aErr").textContent = "정보를 불러오지 못했습니다."; return; }
    req = rq.data;
    workers = ws.data;
    assigned = mine.data.filter((a) => !INACTIVE.includes(a.status));
    past = mine.data.filter((a) => INACTIVE.includes(a.status));
    sameDay = day.data;
    certSet = new Set((dc.data || []).map((x) => x.worker_id));   // 자격증 사본이 등록된 구직자
    render();
  }

  async function afterChange() {
    await reload();
    ctx.onChange();
  }

  function render() {
    const byId = Object.fromEntries(workers.map((w) => [w.id, w]));
    const full = assigned.length >= req.headcount;
    const blocked = req.status === "hold" || req.status === "done";
    const weekday = DAYS[new Date(req.work_date + "T00:00:00").getDay()];

    $("aSummary").textContent = req.work_date + "(" + weekday + ") " + hhmm(req.start_time) + "~" + hhmm(req.end_time)
      + " · " + ctx.clientName + " · " + ctx.jobName + " · " + req.address
      + (req.cert_pref === "require" ? " · 요양보호사 자격증 필수" : req.cert_pref === "prefer" ? " · 자격증 있는 분 우선" : "");
    $("aCount").textContent = "(" + assigned.length + " / 필요 " + req.headcount + "명 · 상태: " + STATUS[req.status] + ")";
    $("aNoCoord").textContent = req.lat == null
      ? "현장 좌표가 등록되지 않았습니다. 이대로는 구직자가 위치로 출근을 확인할 수 없습니다. 인력의뢰 [수정]에서 좌표를 등록하세요."
      : "";

    // 배치된 구직자
    const at = $("aAssigned");
    at.replaceChildren();
    $("aAssignedEmpty").textContent = assigned.length ? "" : "아직 배치된 구직자가 없습니다.";
    for (const a of assigned) {
      const w = byId[a.worker_id];
      const name = w ? w.name : "(구직자)";
      const tr = document.createElement("tr");

      const stTd = el("td", ASTATUS[a.status] || a.status);
      stTd.style.whiteSpace = "nowrap";
      if (a.checked_in_at) stTd.append(el("div", "출근 " + clock(a.checked_in_at) + (a.checked_out_at ? " · 퇴근 " + clock(a.checked_out_at) : ""), "muted"));
      if (a.complete_note) stTd.append(el("div", "보고: " + a.complete_note, "muted"));
      if (req.fee_enabled || req.tax_enabled) {
        // 소개수수료 → 그 금액을 뺀 기준액으로 원천징수 3.3% → 지급 예정액
        const rate = a.fee_override_rate != null ? Number(a.fee_override_rate) : Number(req.fee_rate);
        const fee = req.fee_enabled ? Math.round((req.wage * rate) / 100) : 0;
        const taxed = req.tax_enabled && !a.tax_exempt;
        const tax = taxed ? calcTax(req.wage - fee, ctx.settings) : null;
        const parts = [];
        if (req.fee_enabled) parts.push("수수료 " + rate + "% −" + fee.toLocaleString("ko-KR"));
        if (req.tax_enabled) parts.push(taxed ? "원천징수 −" + tax.total.toLocaleString("ko-KR") : "원천징수 제외");
        const adjusted = a.fee_override_rate != null || a.tax_exempt;
        const f = el("div", parts.join(" · ") + " · 지급 예정 " + (req.wage - fee - (tax ? tax.total : 0)).toLocaleString("ko-KR") + "원"
          + (adjusted ? " · 개별 조정" : ""), "muted");
        const why = [a.fee_reason && "수수료: " + a.fee_reason, a.tax_reason && "원천징수 제외: " + a.tax_reason].filter(Boolean).join(" / ");
        if (why) f.title = why;
        stTd.append(f);
      }

      const acts = el("div", undefined, "acts");
      acts.append(btn("링크 복사", "", () => copyLink(a, name)));
      if (req.fee_enabled && ctx.me.can_edit_wage) acts.append(btn("수수료 변경", "", () => changeFee(a, name)));
      if (req.tax_enabled && ctx.me.can_edit_wage) acts.append(btn(a.tax_exempt ? "원천징수 적용" : "원천징수 제외", "", () => toggleTax(a, name)));
      if (["assigned", "notified", "accepted"].includes(a.status)) {
        acts.append(btn("수동 출근", "", () => manual(a, "in", name)));
      }
      if (a.status === "working") acts.append(btn("수동 퇴근", "", () => manual(a, "out", name)));
      if (["assigned", "notified", "accepted"].includes(a.status)) {
        acts.append(btn("배치 취소", "danger", async () => {
          const reason = prompt(name + " 님의 배치를 취소합니다.\n취소 사유를 입력하세요.");
          if (!reason || !reason.trim()) return;
          const { error } = await db.from("assignments").update({ status: "cancelled", cancel_reason: reason.trim() }).eq("id", a.id);
          if (error) { fail(error, "취소하지 못했습니다."); return; }
          await afterChange();
        }));
      }
      const actTd = el("td");
      actTd.append(acts);
      tr.append(el("td", name), el("td", w ? fmtPhone(w.phone) : ""), stTd, actTd);
      at.append(tr);
    }

    // 취소·거절된 배치
    $("aPast").textContent = past.length
      ? "지난 배치: " + past.map((a) => (byId[a.worker_id] ? byId[a.worker_id].name : "(구직자)") + "(" + ASTATUS[a.status] + ")").join(", ")
      : "";

    // 확정 버튼 (관리자만)
    const isAdmin = ctx.me.role !== "branch_staff";
    $("aConfirm").hidden = !(isAdmin && req.status === "assigning" && full);
    $("aConfirmedNote").textContent = req.status === "confirmed" ? "배치가 확정되었습니다." : "";

    // 배치할 구직자 후보
    const q = $("aQ").value.trim().toLowerCase();
    const qd = digits(q);
    const taken = new Set(assigned.map((a) => a.worker_id));
    const [s1, e1] = span(req);
    const cands = workers.filter((w) => !taken.has(w.id)).filter((w) =>
      !q || w.name.toLowerCase().includes(q) || (qd && w.phone.includes(qd)));

    const info = cands.map((w) => {
      const jobOk = w.job_type_ids.includes(req.job_type_id);
      const dayOk = w.available_days.length === 0 ? null : w.available_days.includes(weekday);
      const clash = sameDay.some((o) => {
        if (o.worker_id !== w.id || o.request_id === req.id) return false;
        const [s2, e2] = span(o.job_requests);
        return s1 < e2 && s2 < e1;
      });
      const paused = w.status !== "active";
      const hasCert = certSet.has(w.id);
      const certBlock = req.cert_pref === "require" && !hasCert;
      const disabled = full || blocked || clash || paused || certBlock;
      const certRank = req.cert_pref !== "none" && !hasCert ? 3 : 0;   // 자격증 우선·필수면 있는 분이 위로
      const trainRank = ctx.trainReq && !w.training_done ? 2 : 0;   // 자체교육 필요한 직종이면 이수자가 위로
      return { w, jobOk, dayOk, clash, paused, hasCert, certBlock, disabled, rank: (disabled ? 100 : 0) + (jobOk ? 0 : 4) + certRank + trainRank + (dayOk === false ? 2 : 0) + (w.no_show_count >= 3 ? 1 : 0) };
    }).sort((a, b) => a.rank - b.rank || a.w.name.localeCompare(b.w.name, "ko"));

    $("aNote").textContent = blocked ? "보류 중이거나 완료된 인력의뢰라서 배치할 수 없습니다." : full ? "필요 인원이 모두 배치되었습니다." : "";
    const ct = $("aCands");
    ct.replaceChildren();
    $("aCandsEmpty").textContent = info.length ? "" : "배치할 수 있는 구직자가 없습니다. 구직자 메뉴에서 먼저 등록해 주세요.";
    for (const c of info) {
      const tr = document.createElement("tr");
      const tags = el("div");
      tags.append(tag(c.jobOk ? "직종 일치" : "직종 다름", !c.jobOk));
      if (c.hasCert) tags.append(tag("요양보호사 자격증"));
      else if (c.certBlock) tags.append(tag("자격증 없음 (필수)", true));
      if (c.w.training_done) tags.append(tag("자체교육 이수"));
      else if (ctx.trainReq) tags.append(tag("자체교육 미이수", true));
      if (c.dayOk === true) tags.append(tag("가능 요일"));
      else if (c.dayOk === false) tags.append(tag(weekday + "요일 불가로 입력됨", true));
      else tags.append(tag("가능 요일 미입력"));
      if (c.w.no_show_count > 0) tags.append(tag("노쇼 " + c.w.no_show_count + "회", c.w.no_show_count >= 3));
      if (c.clash) tags.append(tag("같은 시간 다른 배치", true));
      if (c.paused) tags.append(tag("활동 중지", true));

      const nameTd = el("td", c.w.name);
      nameTd.append(tags);
      const td = el("td");
      const b = el("button", "배치", "primary");
      b.disabled = c.disabled;
      b.addEventListener("click", async () => {
        b.disabled = true;
        const { error } = await db.from("assignments").insert({ request_id: req.id, worker_id: c.w.id });
        if (error) { fail(error, "배치하지 못했습니다."); await reload(); return; }
        await afterChange();
      });
      td.append(b);
      tr.append(nameTd, el("td", fmtPhone(c.w.phone)), td);
      ct.append(tr);
    }
  }

  function btn(label, cls, fn) {
    const b = el("button", label, cls);
    b.addEventListener("click", async () => { b.disabled = true; await fn(); b.disabled = false; });
    return b;
  }

  function fail(error, fallback) {
    $("aInfo").textContent = "";
    $("aErr").textContent = /[가-힣]/.test(error.message) ? error.message : fallback;
  }

  // 구직자별 수수료율 조정 (거리 등). 비우면 인력의뢰 기본값으로 되돌림
  async function changeFee(a, name) {
    const cur = a.fee_override_rate != null ? a.fee_override_rate : req.fee_rate;
    const input = prompt(name + " 님의 소개수수료율(%)을 입력하세요.\n인력의뢰 기본값: " + req.fee_rate + "%\n(비우면 기본값으로 되돌립니다)", String(cur));
    if (input === null) return;
    let rate = null;
    if (input.trim() !== "") {
      rate = Number(input);
      if (!(rate >= 0 && rate <= 100)) { fail({ message: "" }, "수수료율은 0~100 사이로 입력해 주세요."); return; }
      if (rate === Number(req.fee_rate)) rate = null;   // 기본값과 같으면 조정 없음으로 처리
    }
    let reason = null;
    if (rate !== null) {
      reason = prompt("수수료를 바꾸는 사유를 입력하세요. (예: 먼 거리)");
      if (!reason || !reason.trim()) return;
    }
    const { error } = await db.rpc("set_assignment_fee", { p_assignment: a.id, p_rate: rate, p_reason: reason });
    if (error) { fail(error, "수수료를 바꾸지 못했습니다."); return; }
    $("aErr").textContent = "";
    $("aInfo").textContent = "";
    await afterChange();
  }

  // 구직자별 원천징수 제외/적용 (예: 근로소득으로 따로 처리하는 경우). 제외할 때 사유 필수
  async function toggleTax(a, name) {
    let exempt = true, reason = null;
    if (a.tax_exempt) {
      if (!confirm(name + " 님에게 원천징수 3.3%를 다시 적용할까요?")) return;
      exempt = false;
    } else {
      reason = prompt(name + " 님의 원천징수 3.3%를 제외합니다.\n제외하는 사유를 입력하세요.");
      if (!reason || !reason.trim()) return;
    }
    const { error } = await db.rpc("set_assignment_tax", { p_assignment: a.id, p_exempt: exempt, p_reason: reason });
    if (error) { fail(error, "바꾸지 못했습니다."); return; }
    $("aErr").textContent = "";
    $("aInfo").textContent = "";
    await afterChange();
  }

  async function manual(a, kind, name) {
    const label = kind === "in" ? "출근" : "퇴근";
    const reason = prompt(name + " 님을 직원이 직접 " + label + " 처리합니다.\n(예: 현장에서 확인함, GPS 불량)\n\n사유를 입력하세요.");
    if (!reason || !reason.trim()) return;
    const { error } = await db.rpc("staff_mark_attendance", { p_assignment: a.id, p_kind: kind, p_reason: reason.trim() });
    if (error) { fail(error, label + " 처리하지 못했습니다."); return; }
    $("aErr").textContent = "";
    $("aInfo").textContent = "";
    await afterChange();
  }

  $("aQ").addEventListener("input", () => { if (req) render(); });
  $("aClose").addEventListener("click", () => $("adlg").close());
  $("aConfirm").addEventListener("click", async () => {
    if (!confirm("배치를 확정합니다.\n확정 후 구직자에게 링크를 보내 주세요. (문자 자동 발송은 아직 연결 전입니다.)\n계속할까요?")) return;
    $("aConfirm").disabled = true;
    const { error } = await db.rpc("confirm_request", { p_id: req.id });
    $("aConfirm").disabled = false;
    if (error) { fail(error, "확정하지 못했습니다."); return; }
    $("aErr").textContent = "";
    await afterChange();
  });

  return {
    open(request, context) {
      req = request;
      ctx = context;
      $("aErr").textContent = "";
      $("aInfo").textContent = "";
      $("aQ").value = "";
      $("adlg").showModal();
      reload();
    },
  };
})();
