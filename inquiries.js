(async () => {
  const me = await requireStaff("inquiries.html");
  if (!me) return;
  const isAdmin = me.role !== "branch_staff";
  const isHq = me.role === "hq_admin";
  const $ = (id) => document.getElementById(id);
  const OPEN = ["신규", "연락완료", "보류"];
  const TYPE_LABEL = { 인력요청: "인력 요청(구인)", 구직: "구직", 기타문의: "기타 문의" };
  const TYPE_CODE = { 인력요청: "employer", 구직: "seeker", 기타문의: "other" };

  // 유형별 입력 항목: [열 이름, 이름표, 종류]
  const FIELDS = {
    인력요청: [["name", "업체명·성함"], ["phone", "연락처", "tel"], ["field", "필요 분야"], ["headcount", "필요 인원"],
              ["schedule", "근무 시작일"], ["period", "근무 기간"], ["location", "작업 장소"], ["details", "요청 내용", "area"]],
    구직: [["name", "성함"], ["phone", "연락처", "tel"], ["nationality", "구분 (내국인/외국인)"], ["age_group", "연령대"],
          ["field", "희망 분야"], ["location", "희망 지역"], ["work_type", "희망 근무 형태"], ["call_time", "연락 가능 시간"],
          ["details", "경력·자격증", "area"]],
    기타문의: [["name", "이름"], ["phone", "연락처", "tel"], ["details", "내용", "area"]],
  };
  // 열 이름 → 접수 함수가 받는 이름
  const PARAM = { age_group: "ageGroup", work_type: "workType", call_time: "callTime" };

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
      $("empty").textContent = "접수를 불러오지 못했습니다. (서버 SQL 19번·20번이 적용되었는지 확인하세요)";
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
      typeTd.append(el("span", TYPE_LABEL[r.type] || r.type, "tag"));

      const stTd = el("td", r.status);
      stTd.style.whiteSpace = "nowrap";
      if (r.status === "신규") stTd.style.fontWeight = "700";

      const open = el("button", "열기", r.status === "신규" ? "primary" : "");
      open.addEventListener("click", () => openDetail(r));
      const actTd = el("td");
      actTd.append(open);

      const sum = el("td", summary(r));
      sum.style.minWidth = "220px";
      tr.append(idTd, typeTd, el("td", r.name || "-"), phoneTd, sum, el("td", (r.channels || []).join(", ")), el("td", r.assignee || ""), stTd, actTd);
      tbody.append(tr);
    }
  }

  // ───────── 입력 칸 만들기 (내용 수정·직접 등록 공통) ─────────
  function buildInputs(box, type, values) {
    box.replaceChildren();
    const map = {};
    for (const [key, label, kind] of FIELDS[type]) {
      const wrap = el("div");
      const lab = el("label", label, "f");
      const input = kind === "area" ? document.createElement("textarea") : document.createElement("input");
      if (kind === "area") { input.rows = 3; input.maxLength = 2000; }
      else { input.type = kind === "tel" ? "tel" : "text"; input.maxLength = 300; }
      input.value = values && values[key] ? (key === "phone" ? fmtPhone(values[key]) : values[key]) : "";
      input.style.width = "100%";
      wrap.append(lab, input);
      box.append(wrap);
      map[key] = input;
    }
    return map;
  }

  // ───────── 상세 ─────────
  function viewRow(label, value) {
    if (!value) return null;
    const box = el("div");
    box.style.cssText = "display:grid;grid-template-columns:110px 1fr;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)";
    const dd = el("div", value);
    dd.style.cssText = "white-space:pre-wrap;word-break:break-word";
    box.append(el("div", label, "muted"), dd);
    return box;
  }

  function showView() {
    const r = current;
    const body = $("iBody");
    body.replaceChildren();
    for (const [key, label] of FIELDS[r.type]) {
      const v = key === "phone" ? fmtPhone(r.phone) : key === "headcount" && r[key] ? r[key] + "명" : r[key];
      const row = viewRow(label, v);
      if (row) body.append(row);
    }
    const log = viewRow("추가 접수 기록", r.auto_log);
    if (log) body.append(log);

    const bar = $("iEditBar");
    bar.replaceChildren();
    const edit = el("button", "내용 수정");
    edit.addEventListener("click", showEdit);
    bar.append(edit);
  }

  let editInputs = null;
  function showEdit() {
    editInputs = buildInputs($("iBody"), current.type, current);
    const bar = $("iEditBar");
    bar.replaceChildren();
    const save = el("button", "수정 저장", "primary");
    save.addEventListener("click", async () => {
      const patch = {};
      for (const [key, input] of Object.entries(editInputs)) {
        const v = input.value.trim() || null;
        const before = key === "phone" ? current.phone : current[key];
        if (key === "phone") {
          if (digits(v).length < 9) { $("iErr").textContent = "연락처를 확인해 주세요."; return; }
          if (digits(v) !== current.phone_digits) patch.phone = v;
        } else if ((v || null) !== (before || null)) {
          patch[key] = v;
        }
      }
      if (!Object.keys(patch).length) { showView(); return; }
      save.disabled = true;
      const { error } = await db.from("inquiries").update(patch).eq("id", current.id);
      if (error) { $("iErr").textContent = /[가-힣]/.test(error.message) ? error.message : "저장하지 못했습니다."; save.disabled = false; return; }
      $("iErr").textContent = "";
      await load();
      current = rows.find((x) => x.id === current.id) || current;
      showView();
    });
    const cancel = el("button", "취소");
    cancel.addEventListener("click", showView);
    bar.append(save, cancel);
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
    showView();
    $("iAssignee").value = r.assignee || "";
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
    for (const s of ["연락완료", "보류", "취소", "신규"]) {
      if (s === r.status || (r.status === "전환완료" && s === "신규")) continue;
      const b = el("button", s === "신규" ? "신규로 되돌리기" : "'" + s + "'로 표시");
      b.addEventListener("click", () => setStatus(s));
      acts.append(b);
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
    const assignee = $("iAssignee").value.trim() || null;
    const { error } = await db.from("inquiries").update({ memo, assignee }).eq("id", current.id);
    if (error) { $("iErr").textContent = "저장하지 못했습니다."; return; }
    current.memo = memo;
    current.assignee = assignee;
    $("iErr").textContent = "";
    $("iSaveMemo").textContent = "저장했습니다";
    setTimeout(() => ($("iSaveMemo").textContent = "담당자·메모 저장"), 1500);
    render();
  });

  // ───────── 직접 등록 ─────────
  let newInputs = null;
  function drawNewFields() { newInputs = buildInputs($("nFields"), $("nType").value, null); }
  $("newBtn").addEventListener("click", () => {
    $("nType").value = "인력요청";
    $("nChannel").value = "전화";
    drawNewFields();
    $("nAssignee").value = "";
    $("nMemo").value = "";
    $("nAgree").checked = false;
    $("nErr").textContent = "";
    $("ndlg").showModal();
  });
  $("nType").addEventListener("change", drawNewFields);
  $("nCancel").addEventListener("click", () => $("ndlg").close());
  $("nSave").addEventListener("click", async () => {
    const type = $("nType").value;
    const p = { type: TYPE_CODE[type], channel: $("nChannel").value, agree: $("nAgree").checked ? "동의" : "" };
    for (const [key, input] of Object.entries(newInputs)) p[PARAM[key] || key] = input.value.trim();
    if (digits(p.phone).length < 9) { $("nErr").textContent = "연락처를 확인해 주세요."; return; }
    if (!$("nAgree").checked) { $("nErr").textContent = "개인정보 수집·이용 동의를 받은 뒤 체크해 주세요."; return; }
    $("nSave").disabled = true;
    const { data, error } = await db.rpc("submit_inquiry", { p });
    if (error || !data || !data.ok) {
      $("nSave").disabled = false;
      $("nErr").textContent = error && error.message === "too_many_requests" ? "잠시 후 다시 시도해 주세요."
        : error && error.message === "invalid_phone" ? "연락처를 확인해 주세요." : "등록하지 못했습니다.";
      return;
    }
    // 직원이 직접 등록한 것은 '읽음'으로 하고 담당자·메모를 붙임
    const extra = { is_read: true };
    if ($("nAssignee").value.trim()) extra.assignee = $("nAssignee").value.trim();
    if ($("nMemo").value.trim()) extra.memo = $("nMemo").value.trim();
    await db.from("inquiries").update(extra).eq("receipt_no", data.receipt_no);
    $("nSave").disabled = false;
    $("ndlg").close();
    $("statusSel").value = "open";
    await load();
    alert(data.merged ? "같은 연락처의 기존 접수 " + data.receipt_no + " 에 합쳤습니다." : data.receipt_no + " 로 등록했습니다.");
  });

  $("q").addEventListener("input", render);
  $("typeSel").addEventListener("change", render);
  $("statusSel").addEventListener("change", render);

  $("purge").addEventListener("click", async () => {
    if (!confirm("전환완료·취소 후 1년이 지난 접수를 모두 삭제합니다. 되돌릴 수 없습니다. 계속할까요?")) return;
    const { data, error } = await db.rpc("purge_old_inquiries");
    if (error) { alert(/[가-힣]/.test(error.message) ? error.message : "정리하지 못했습니다."); return; }
    alert(data + "건을 삭제했습니다.");
    await load();
  });

  await load();
})();
