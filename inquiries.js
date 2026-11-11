(async () => {
  const me = await requireStaff("inquiries.html");
  if (!me) return;
  const isAdmin = me.role !== "branch_staff";
  const isHq = me.role === "hq_admin";
  const $ = (id) => document.getElementById(id);
  const OPEN = ["신규", "연락완료", "보류"];
  const TYPE_LABEL = { 인력요청: "인력 요청(구인)", 구직: "구직", 기타문의: "기타 문의" };

  let rows = [], current = null;

  if (isHq) $("purgeBox").hidden = false;

  const when = (iso) => {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getMonth() + 1) + "/" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  };

  async function load() {
    const { data, error } = await db.from("inquiries").select("*").order("updated_at", { ascending: false }).limit(500);
    if (error) {
      $("empty").textContent = "접수를 불러오지 못했습니다. (서버 SQL 19번이 적용되었는지 확인하세요)";
      return;
    }
    rows = data;
    render();
  }

  // 목록의 '내용' 칸 요약
  function summary(r) {
    if (r.type === "인력요청") {
      return [r.field, r.headcount && r.headcount + "명", r.schedule, r.period, r.location].filter(Boolean).join(" · ");
    }
    if (r.type === "구직") {
      return [r.field, r.location, r.work_type, r.age_group, r.nationality === "외국인" ? "외국인" : ""].filter(Boolean).join(" · ");
    }
    return (r.details || "").slice(0, 60);
  }

  function render() {
    const q = $("q").value.trim().toLowerCase();
    const qd = digits(q);
    const type = $("typeSel").value;
    const st = $("statusSel").value;
    const list = rows.filter((r) => {
      if (type && r.type !== type) return false;
      if (st === "open" ? !OPEN.includes(r.status) : st && r.status !== st) return false;
      if (!q) return true;
      return r.receipt_no.toLowerCase().includes(q) || (r.name || "").toLowerCase().includes(q) || (qd && r.phone_digits.includes(qd));
    });

    const tbody = $("rows");
    tbody.replaceChildren();
    $("empty").textContent = list.length ? "" : "표시할 접수가 없습니다.";
    for (const r of list) {
      const tr = document.createElement("tr");
      if (!r.is_read) tr.style.background = "#f6f9ff";

      const idTd = el("td");
      const no = el("div", r.receipt_no);
      no.style.fontWeight = r.is_read ? "500" : "800";
      idTd.append(no, el("div", when(r.updated_at), "muted"));
      if (r.submit_count > 1) idTd.append(el("span", "추가 접수 " + (r.submit_count - 1) + "회", "tag warn"));

      const phoneTd = el("td");
      const a = el("a", fmtPhone(r.phone));
      a.href = "tel:" + r.phone_digits;
      phoneTd.append(a);

      const typeTd = el("td");
      typeTd.append(el("span", TYPE_LABEL[r.type] || r.type, r.type === "인력요청" ? "tag" : "tag"));

      const stTd = el("td", r.status);
      stTd.style.whiteSpace = "nowrap";
      if (r.status === "신규") stTd.style.fontWeight = "700";

      const open = el("button", "열기", r.status === "신규" ? "primary" : "");
      open.addEventListener("click", () => openDetail(r));
      const actTd = el("td");
      actTd.append(open);

      const sum = el("td", summary(r));
      sum.style.minWidth = "220px";
      tr.append(idTd, typeTd, el("td", r.name || "-"), phoneTd, sum, el("td", (r.channels || []).join(", ")), stTd, actTd);
      tbody.append(tr);
    }
  }

  // ───────── 상세 ─────────
  function field(label, value) {
    if (!value) return null;
    const box = el("div");
    box.style.cssText = "display:grid;grid-template-columns:110px 1fr;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)";
    const dt = el("dt", label, "muted");
    const dd = el("dd", value);
    dd.style.cssText = "margin:0;white-space:pre-wrap;word-break:break-word";
    box.append(dt, dd);
    return box;
  }

  async function setStatus(status) {
    const { error } = await db.from("inquiries").update({ status }).eq("id", current.id);
    if (error) { $("iErr").textContent = /[가-힣]/.test(error.message) ? error.message : "바꾸지 못했습니다."; return; }
    $("idlg").close();
    await load();
  }

  async function openDetail(r) {
    current = r;
    $("iErr").textContent = "";
    $("iTitle").textContent = r.receipt_no + " · " + (TYPE_LABEL[r.type] || r.type);
    $("iSub").textContent = "접수 " + when(r.created_at) + " · 최근 " + when(r.updated_at) + " · 경로 " + (r.channels || []).join(", ")
      + (r.submit_count > 1 ? " · 추가 접수 " + (r.submit_count - 1) + "회" : "");

    const body = $("iBody");
    body.replaceChildren();
    const phoneVal = fmtPhone(r.phone);
    const items = r.type === "인력요청"
      ? [["업체명·성함", r.name], ["연락처", phoneVal], ["필요 분야", r.field], ["필요 인원", r.headcount && r.headcount + "명"],
         ["근무 시작일", r.schedule], ["근무 기간", r.period], ["작업 장소", r.location], ["요청 내용", r.details]]
      : r.type === "구직"
        ? [["성함", r.name], ["연락처", phoneVal], ["구분", r.nationality], ["연령대", r.age_group], ["희망 분야", r.field],
           ["희망 지역", r.location], ["희망 형태", r.work_type], ["연락 가능 시간", r.call_time], ["경력·자격증", r.details]]
        : [["이름", r.name], ["연락처", phoneVal], ["내용", r.details]];
    for (const [label, value] of items) { const f = field(label, value); if (f) body.append(f); }
    const log = field("추가 접수 기록", r.auto_log);
    if (log) body.append(log);

    $("iMemo").value = r.memo || "";

    const acts = $("iActions");
    acts.replaceChildren();
    const tel = el("a", "전화하기");
    tel.href = "tel:" + r.phone_digits;
    tel.style.cssText = "display:inline-block;padding:8px 14px;border:1px solid #d5dbe7;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px";
    acts.append(tel);

    if (r.type === "인력요청") {
      const b = el("button", "인력의뢰 만들기", "primary");
      b.addEventListener("click", () => { location.href = "requests.html?inq=" + r.id; });
      acts.append(b);
    } else if (r.type === "구직") {
      const b = el("button", "구직자로 등록", "primary");
      b.addEventListener("click", () => { location.href = "workers.html?inq=" + r.id; });
      acts.append(b);
    }
    if (r.status === "전환완료") {
      acts.append(el("span", "이미 전환했습니다" + (r.converted_at ? " (" + when(r.converted_at) + ")" : ""), "muted"));
    }
    for (const s of ["연락완료", "보류", "종료", "신규"]) {
      if (s === r.status || r.status === "전환완료" && s === "신규") continue;
      acts.append(Object.assign(el("button", s === "신규" ? "신규로 되돌리기" : "'" + s + "'로 표시"), { onclick: () => setStatus(s) }));
    }
    if (isAdmin) {
      const del = el("button", "삭제", "danger");
      del.addEventListener("click", async () => {
        if (!confirm(r.receipt_no + " 접수를 완전히 삭제합니다. 되돌릴 수 없습니다. 계속할까요?")) return;
        const { error } = await db.from("inquiries").delete().eq("id", r.id);
        if (error) { $("iErr").textContent = "삭제하지 못했습니다."; return; }
        $("idlg").close();
        await load();
      });
      acts.append(del);
    }

    $("idlg").showModal();

    // 처음 열면 '읽음'으로 표시
    if (!r.is_read) {
      const { error } = await db.from("inquiries").update({ is_read: true }).eq("id", r.id);
      if (!error) { r.is_read = true; render(); }
    }
  }

  $("iClose").addEventListener("click", () => $("idlg").close());
  $("iSaveMemo").addEventListener("click", async () => {
    const memo = $("iMemo").value.trim() || null;
    const { error } = await db.from("inquiries").update({ memo }).eq("id", current.id);
    if (error) { $("iErr").textContent = "메모를 저장하지 못했습니다."; return; }
    current.memo = memo;
    $("iErr").textContent = "";
    $("iSaveMemo").textContent = "저장했습니다";
    setTimeout(() => ($("iSaveMemo").textContent = "메모 저장"), 1500);
  });

  $("q").addEventListener("input", render);
  $("typeSel").addEventListener("change", render);
  $("statusSel").addEventListener("change", render);

  $("purge").addEventListener("click", async () => {
    if (!confirm("전환완료·종료 후 1년이 지난 접수를 모두 삭제합니다. 되돌릴 수 없습니다. 계속할까요?")) return;
    const { data, error } = await db.rpc("purge_old_inquiries");
    if (error) { alert(/[가-힣]/.test(error.message) ? error.message : "정리하지 못했습니다."); return; }
    alert(data + "건을 삭제했습니다.");
    await load();
  });

  await load();
})();
