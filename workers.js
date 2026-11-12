(async () => {
  const me = await requireStaff("workers.html");
  if (!me) return;
  const isAdmin = me.role !== "branch_staff";
  const isHq = me.role === "hq_admin";
  const DAYS = ["월", "화", "수", "목", "금", "토", "일"];
  const DOC_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

  let jobTypes = [], branches = [], rows = [], shown = [], editing = null, convertFrom = null;
  let docs = {};          // 구직자 id -> { id_card: 서류정보, bankbook: 서류정보 }
  let hints = {};         // 구직자 id -> "농협 ****1234"
  let privateReady = true; // 서류·계좌 기능(SQL 10)이 준비되었는지
  const $ = (id) => document.getElementById(id);

  // 보기 선택: 휴지통은 관리자만
  const views = [["all", "전체"], ["active", "활동 중"], ["paused", "활동 중지"]];
  if (isAdmin) views.push(["trash", "휴지통"]);
  for (const [v, label] of views) $("view").append(new Option(label, v));

  // 체류 만료까지 남은 날수 (지났으면 음수, 만료일이 없으면 null)
  function visaDaysLeft(r) {
    if (!r.is_foreign || !r.visa_expiry) return null;
    return Math.round((new Date(r.visa_expiry + "T00:00:00") - new Date(todayStr() + "T00:00:00")) / 86400000);
  }

  // 머리글을 눌러 정렬: 이름, 전화, 직종, 가능 지역, 가능 요일(많은 순), 상태
  const jobLabel = (r) => r.job_type_ids.map((id) => (jobTypes.find((j) => j.id === id) || {}).name || "").join(",");
  const sorter = setupSort(document.querySelector("main table"), [
    (r) => r.name, (r) => digits(r.phone), jobLabel, (r) => r.area || "", (r) => r.available_days.length,
    (r) => (r.deleted_at ? "휴지통" : r.status === "paused" ? "활동 중지" : "활동 중"), null,
  ], () => render());

  $("print").addEventListener("click", () => {
    const q = $("q").value.trim();
    const notes = [$("view").selectedOptions[0].text];
    if ($("jobF").value) notes.push($("jobF").selectedOptions[0].text);
    if ($("dayF").value) notes.push($("dayF").selectedOptions[0].text);
    if ($("flagF").value) notes.push($("flagF").selectedOptions[0].text);
    if (q) notes.push("검색: " + q);
    printPage("구직자 목록 - " + notes.join(", "));
  });

  async function loadBase() {
    const [jt, br] = await Promise.all([
      db.from("job_types").select("*").eq("active", true).order("sort_order"),
      db.from("branches").select("id,name").order("name"),
    ]);
    jobTypes = jt.data || [];
    branches = br.data || [];
    for (const j of jobTypes) $("jobF").append(new Option(j.name, j.id));
    for (const d of DAYS) $("dayF").append(new Option(d + "요일 가능", d));
    for (const j of jobTypes) {
      const lab = el("label");
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.value = j.id;
      cb.addEventListener("change", updateQualVisibility);
      cb.addEventListener("change", updateTrainVisibility);
      lab.append(cb, document.createTextNode(j.name));
      $("jobs").append(lab);
    }
    for (const d of DAYS) {
      const lab = el("label");
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.value = d;
      lab.append(cb, document.createTextNode(d));
      $("days").append(lab);
    }
    if (isHq) {
      $("branchRow").hidden = false;
      for (const b of branches) $("branch").append(new Option(b.name, b.id));
    }
  }

  async function load() {
    const [w, d, h] = await Promise.all([
      db.from("workers").select("*").order("created_at", { ascending: false }),
      db.from("worker_documents").select("*"),
      db.rpc("worker_bank_hints"),
    ]);
    if (w.error) { $("empty").textContent = "목록을 불러오지 못했습니다."; return; }
    rows = w.data;
    privateReady = !d.error && !h.error;
    docs = {};
    for (const x of d.data || []) (docs[x.worker_id] = docs[x.worker_id] || {})[x.kind] = x;
    hints = {};
    for (const x of h.data || []) hints[x.worker_id] = x.bank_hint;
    render();
  }

  function render() {
    const q = $("q").value.trim().toLowerCase();
    const qd = digits(q);
    const view = $("view").value;
    const jf = $("jobF").value, dayf = $("dayF").value, flag = $("flagF").value;
    const reqTrain = new Set(jobTypes.filter((j) => j.training_required).map((j) => j.id));
    const jobName =Object.fromEntries(jobTypes.map((j) => [j.id, j.name]));
    const list = sorter(rows.filter((r) => {
      const trashed = !!r.deleted_at;
      if (view === "trash" ? !trashed : trashed) return false;
      if (view === "active" && r.status !== "active") return false;
      if (view === "paused" && r.status !== "paused") return false;
      if (jf && !r.job_type_ids.includes(jf)) return false;
      if (dayf && !r.available_days.includes(dayf)) return false;
      if (flag === "consent" && r.consent_confirmed) return false;
      if (flag === "notrain" && (r.training_done || !r.job_type_ids.some((id) => reqTrain.has(id)))) return false;
      if (flag === "foreign" && !r.is_foreign) return false;
      if (flag === "permit" && !(r.is_foreign && !r.work_permit_ok)) return false;
      if (flag === "visa") { const n = visaDaysLeft(r); if (n === null || n > 30) return false; }
      if (!q) return true;
      return r.name.toLowerCase().includes(q) || (qd && r.phone.includes(qd))
        || [r.area, r.memo, jobLabel(r), r.nationality, r.visa_type].join("\n").toLowerCase().includes(q);
    }));

    shown = list;
    const tbody = $("rows");
    tbody.replaceChildren();
    $("empty").textContent = list.length ? "" : "표시할 구직자가 없습니다.";
    const reqCert = new Set(jobTypes.filter((j) => j.qualification_required).map((j) => j.id));
    for (const r of list) {
      const tr = document.createElement("tr");
      const nameTd = el("td", r.name);
      if (!r.consent_confirmed) nameTd.append(el("div", "동의 확인 필요", "tag warn"));
      if (r.is_foreign) {
        const fx = el("div");
        fx.append(el("span", "외국인" + (r.nationality ? " · " + r.nationality : ""), "tag"));
        if (r.visa_type) fx.append(el("span", r.visa_type, "tag"));
        if (r.topik_level) fx.append(el("span", "TOPIK " + r.topik_level + "급", "tag"));
        const left = visaDaysLeft(r);
        if (left === null) fx.append(el("span", "체류 만료일 미입력", "tag warn"));
        else if (left < 0) fx.append(el("span", "체류 만료됨 (" + r.visa_expiry + ")", "tag warn"));
        else if (left <= 30) fx.append(el("span", "체류 만료 " + left + "일 전", "tag warn"));
        if (!r.work_permit_ok) fx.append(el("span", "취업 가능 확인 필요", "tag warn"));
        nameTd.append(fx);
      }
      if (r.training_done) nameTd.append(el("div", "자체교육 이수", "tag"));
      else if (r.job_type_ids.some((id) => reqTrain.has(id))) nameTd.append(el("div", "자체교육 미이수", "tag warn"));
      if (privateReady && !r.deleted_at) {
        const d = docs[r.id] || {};
        const miss = el("div");
        if (!d.id_card) miss.append(el("span", "신분증 미등록", "tag warn"));
        // 자격증이 있으면 표시. 없으면 '미등록 경고(필수)'로 지정한 직종(요양보호사)일 때만 경고
        if (d.qualification) miss.append(el("span", "요양보호사 자격증", "tag"));
        else if (r.job_type_ids.some((id) => reqCert.has(id))) miss.append(el("span", "자격증 미등록", "tag warn"));
        if (!d.bankbook) miss.append(el("span", "통장사본 미등록", "tag warn"));
        if (!hints[r.id]) miss.append(el("span", "계좌 미등록", "tag warn"));
        nameTd.append(miss);
      }
      const jobsTd = el("td");
      for (const id of r.job_type_ids) jobsTd.append(el("span", jobName[id] || "(삭제된 직종)", "tag"));
      const stTd = el("td", r.deleted_at ? "휴지통" : r.status === "paused" ? "활동 중지" : "활동 중");
      tr.append(nameTd, el("td", fmtPhone(r.phone)), jobsTd, el("td", r.area || ""),
        el("td", DAYS.filter((d) => r.available_days.includes(d)).join(" ")), stTd, actions(r));
      tbody.append(tr);
    }
  }

  // 지금 화면에 보이는 목록(검색·보기 적용)을 엑셀로. 계좌·서류 정보는 넣지 않음
  $("xlsx").addEventListener("click", () => {
    if (!shown.length) { alert("내려받을 구직자가 없습니다."); return; }
    const jobName = Object.fromEntries(jobTypes.map((j) => [j.id, j.name]));
    saveXlsx("구직자", "구직자",
      ["이름", "전화", "직종", "가능 지역", "가능 요일", "상태", "동의 확인", "자체교육 이수",
        "구분", "국적", "체류자격", "체류 만료일", "TOPIK", "취업 가능 확인"],
      shown.map((r) => [
        r.name, fmtPhone(r.phone), r.job_type_ids.map((id) => jobName[id] || "(삭제된 직종)").join(", "), r.area || "",
        DAYS.filter((d) => r.available_days.includes(d)).join(" "),
        r.deleted_at ? "휴지통" : r.status === "paused" ? "활동 중지" : "활동 중",
        r.consent_confirmed ? "확인" : "확인 필요", r.training_done ? "이수" : "",
        r.is_foreign ? "외국인" : "내국인", r.nationality || "", r.visa_type || "", r.visa_expiry || "",
        r.topik_level ? r.topik_level + "급" : "",
        r.is_foreign ? (r.work_permit_ok ? "확인 (" + (r.work_permit_checked_on || "") + ")" : "확인 필요") : "",
      ]));
  });

  function btn(label, cls, fn) {
    const b = el("button", label, cls);
    b.type = "button";
    b.addEventListener("click", async () => { b.disabled = true; await fn(); b.disabled = false; });
    return b;
  }

  async function run(promise, failMsg) {
    const { error } = await promise;
    if (error) { alert(error.message.includes("관리자만") ? error.message : failMsg); return false; }
    await load();
    return true;
  }

  function actions(r) {
    const td = el("td");
    const box = el("div", undefined, "acts");
    if (r.deleted_at) {
      box.append(
        btn("복구", "", () => run(db.from("workers").update({ deleted_at: null }).eq("id", r.id), "복구하지 못했습니다.")),
        btn("완전 삭제", "danger", async () => {
          if (!confirm(r.name + " 님을 완전히 삭제합니다. 되돌릴 수 없습니다. 계속할까요?")) return;
          await run(db.from("workers").delete().eq("id", r.id), "삭제하지 못했습니다. 이 구직자와 연결된 기록(배치·서류·계좌 등)이 있을 수 있습니다.");
        }));
    } else {
      box.append(btn("수정", "", async () => openForm(r)));
      if (isAdmin) {
        box.append(
          btn(r.status === "paused" ? "활동 재개" : "활동 중지", "",
            () => run(db.from("workers").update({ status: r.status === "paused" ? "active" : "paused" }).eq("id", r.id), "변경하지 못했습니다.")),
          btn("삭제", "danger", async () => {
            if (!confirm(r.name + " 님을 휴지통으로 보냅니다. 휴지통에서 복구할 수 있습니다.")) return;
            await run(db.from("workers").update({ deleted_at: new Date().toISOString() }).eq("id", r.id), "삭제하지 못했습니다.");
          }));
      }
    }
    td.append(box);
    return td;
  }

  // ───────── 서류·계좌 ─────────
  async function viewDoc(doc) {
    const win = window.open("", "_blank");
    if (!win) { alert("팝업이 막혀 있습니다. 주소창 오른쪽에서 팝업을 허용한 뒤 다시 눌러 주세요."); return; }
    const { data: path, error } = await db.rpc("doc_view_path", { p_doc: doc.id });
    if (error) { win.close(); alert(/[가-힣]/.test(error.message) ? error.message : "열지 못했습니다."); return; }
    const { data, error: e2 } = await db.storage.from("worker-docs").createSignedUrl(path, 60);
    if (e2 || !data) { win.close(); alert("파일을 열지 못했습니다."); return; }
    win.location = data.signedUrl;
  }

  async function deleteDoc(doc, label) {
    if (!confirm(label + " 사본을 삭제합니다. 되돌릴 수 없습니다. 계속할까요?")) return;
    const rm = await db.storage.from("worker-docs").remove([doc.path]);
    if (rm.error) { alert("파일을 삭제하지 못했습니다."); return; }
    const { error } = await db.from("worker_documents").delete().eq("id", doc.id);
    if (error) { alert("삭제하지 못했습니다."); return; }
    await load();
    refreshPrivateUI();
  }

  function renderDocBox(kind, boxId, fileId, label) {
    const box = $(boxId);
    box.replaceChildren();
    const doc = editing && docs[editing.id] && docs[editing.id][kind];
    $(fileId).value = "";
    if (doc) {
      box.append(el("span", "등록됨", "tag"));
      // 신분증은 직원도 열람·제공 가능, 통장 사본은 관리자만
      if (kind !== "bankbook" || isAdmin) box.append(btn("보기", "", () => viewDoc(doc)));
      if (kind !== "bankbook") box.append(btn("의뢰처에 제공", "primary", async () => openShare(kind, label)));
      if (isAdmin) {
        box.append(btn("삭제", "danger", () => deleteDoc(doc, label)), el("span", "새 파일을 고르면 교체됩니다.", "muted"));
      } else {
        box.append(el("span", kind !== "bankbook" ? "교체·삭제는 관리자만 할 수 있습니다." : "열람·교체는 관리자만 할 수 있습니다.", "muted"));
      }
    } else {
      box.append(el("span", "미등록", "tag warn"));
    }
    $(fileId).disabled = !!doc && !isAdmin;
  }

  // 자격증 칸은 설정에서 '자격증 칸 표시'로 지정한 직종(예: 요양보호사, 간병·돌봄)을 고른 구직자,
  // 또는 이미 자격증이 등록된 구직자에게만 보임
  function updateQualVisibility() {
    const care = new Set(jobTypes.filter((j) => j.show_qualification).map((j) => j.id));
    const selected = [...$("jobs").querySelectorAll("input:checked")].some((cb) => care.has(cb.value));
    const hasDoc = !!(editing && docs[editing.id] && docs[editing.id].qualification);
    $("qualBox").hidden = !(selected || hasDoc);
  }

  // 자체교육 칸은 설정에서 '자체교육 필요'로 지정한 직종(예: 간병·돌봄)을 고른 구직자,
  // 또는 이미 이수로 기록된 구직자에게만 보임
  function updateTrainVisibility() {
    const need = new Set(jobTypes.filter((j) => j.training_required).map((j) => j.id));
    const selected = [...$("jobs").querySelectorAll("input:checked")].some((cb) => need.has(cb.value));
    $("trainBox").hidden = !(selected || $("trainDone").checked);
  }

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function refreshPrivateUI() {
    const hint = editing && hints[editing.id];
    const hintBox = $("bankHint");
    hintBox.replaceChildren(document.createTextNode(editing ? (hint ? "등록된 계좌: " + hint + " " : "등록된 계좌가 없습니다.") : ""));
    const locked = !!hint && !isAdmin;
    for (const id of ["bankName", "bankNo", "bankHolder"]) $(id).disabled = locked;
    if (locked) hintBox.append(document.createTextNode("(변경은 관리자만 할 수 있습니다)"));
    if (hint && isAdmin) {
      hintBox.append(btn("전체 보기·수정", "", async () => {
        if (!confirm("계좌번호 전체를 열람합니다. 열람 기록이 남습니다. 계속할까요?")) return;
        const { data, error } = await db.rpc("get_worker_bank", { p_worker: editing.id });
        if (error || !data) { alert("계좌를 불러오지 못했습니다."); return; }
        $("bankName").value = data.bank_name;
        $("bankNo").value = data.account_number;
        $("bankHolder").value = data.account_holder;
      }));
    }
    renderDocBox("id_card", "idStatus", "idFile", "신분증");
    renderDocBox("qualification", "qualStatus", "qualFile", "자격증");
    renderDocBox("bankbook", "bookStatus", "bookFile", "통장");
    updateQualVisibility();
    updateTrainVisibility();
  }

  // 이수 체크하면 오늘 날짜를 채우고, 체크를 풀면 날짜를 지움
  $("trainDone").addEventListener("change", () => {
    if ($("trainDone").checked) { if (!$("trainDate").value) $("trainDate").value = todayStr(); }
    else $("trainDate").value = "";
  });

  // ───────── 신분증 사본 의뢰처 제공 ─────────
  const METHOD = { kakao: "카카오톡", email: "이메일", fax: "팩스", print: "출력·직접 전달", other: "기타" };

  async function loadDisclosures() {
    const box = $("shareLog");
    box.replaceChildren();
    if (!editing || !editing.id || !privateReady) return;
    const { data, error } = await db.from("document_disclosures").select("*")
      .eq("worker_id", editing.id).order("sent_at", { ascending: false }).limit(5);
    if (error) return;
    if (!data.length) { box.textContent = "서류 제공 기록이 없습니다."; return; }
    box.append(document.createTextNode("서류 제공 기록(최근 5건)"));
    for (const x of data) {
      const d = new Date(x.sent_at);
      const when = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      box.append(el("div", "· " + when + " [" + (x.kind === "id_card" ? "신분증" : "자격증") + "] " + x.recipient + " (" + METHOD[x.method] + ", " + (x.sent_by_name || "-") + ")" + (x.memo ? " — " + x.memo : "")));
    }
  }

  let shareKind = "id_card";

  async function openShare(kind, label) {
    shareKind = kind;
    $("sTitle").textContent = label + " 사본 제공";
    if (!editing || !editing.share_consent) {
      alert("이 구직자는 " + label + " 사본을 의뢰처에 제공하는 것에 대한 동의가 확인되지 않았습니다.\n동의를 받은 뒤 '의뢰처에 제공하는 것에 동의를 받았음'을 체크하고 저장해 주세요.");
      return;
    }
    const { data: cl } = await db.from("clients").select("id,name,branch_id").is("deleted_at", null).order("name");
    const sel = $("shareClient");
    sel.replaceChildren(new Option("직접 입력", ""));
    for (const c of cl || []) if (c.branch_id === editing.branch_id) sel.append(new Option(c.name, c.id));
    $("shareName").value = "";
    $("shareMemo").value = "";
    $("shareMethod").value = "kakao";
    $("shareErr").textContent = "";
    $("sdlg").showModal();
  }

  $("shareCancel").addEventListener("click", () => $("sdlg").close());
  $("shareOk").addEventListener("click", async () => {
    const clientId = $("shareClient").value || null;
    const name = $("shareName").value.trim();
    if (!clientId && !name) { $("shareErr").textContent = "받는 곳을 선택하거나 이름을 입력해 주세요."; return; }
    $("shareOk").disabled = true;
    $("shareErr").textContent = "";
    const { data: path, error } = await db.rpc("record_disclosure", {
      p_worker: editing.id, p_kind: shareKind, p_client: clientId, p_recipient: name,
      p_method: $("shareMethod").value, p_memo: $("shareMemo").value.trim(),
    });
    if (error) {
      $("shareOk").disabled = false;
      $("shareErr").textContent = /[가-힣]/.test(error.message) ? error.message : "기록하지 못했습니다.";
      return;
    }
    const ext = (path.split(".").pop() || "jpg");
    const { data, error: e2 } = await db.storage.from("worker-docs").createSignedUrl(path, 60, { download: (shareKind === "id_card" ? "신분증_" : "자격증_") + editing.name + "." + ext });
    $("shareOk").disabled = false;
    if (e2 || !data) {
      $("shareErr").textContent = "제공 기록은 남았지만 파일을 내려받지 못했습니다. [보기]로 다시 열어 주세요.";
      await loadDisclosures();
      return;
    }
    const a = document.createElement("a");
    a.href = data.signedUrl;
    a.download = "";
    document.body.append(a);
    a.click();
    a.remove();
    $("sdlg").close();
    await loadDisclosures();
  });

  async function uploadDoc(worker, kind, file) {
    if (file.size > 10 * 1024 * 1024) throw new Error("파일은 10MB 이하로 올려 주세요.");
    if (!DOC_TYPES.includes(file.type)) throw new Error("사진(JPG·PNG·WEBP) 또는 PDF만 올릴 수 있습니다.");
    const ext = ((file.name.split(".").pop() || "dat").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5)) || "dat";
    const path = worker.branch_id + "/" + worker.id + "/" + kind + "-" + Date.now() + "." + ext;
    const up = await db.storage.from("worker-docs").upload(path, file, { contentType: file.type, upsert: false });
    if (up.error) throw new Error("파일을 올리지 못했습니다.");

    const old = docs[worker.id] && docs[worker.id][kind];
    if (old) {
      const { error } = await db.from("worker_documents").update({ path }).eq("id", old.id);
      if (error) { await db.storage.from("worker-docs").remove([path]); throw new Error("서류 정보를 바꾸지 못했습니다."); }
      await db.storage.from("worker-docs").remove([old.path]);
    } else {
      const { error } = await db.from("worker_documents").insert({ worker_id: worker.id, kind, path });
      if (error) { await db.storage.from("worker-docs").remove([path]); throw new Error("서류 정보를 저장하지 못했습니다."); }
    }
  }

  function openForm(r) {
    convertFrom = null;   // 접수함에서 넘어온 경우는 열고 난 뒤에 따로 표시
    editing = r || null;
    $("dlgTitle").textContent = r ? "구직자 수정" : "구직자 등록";
    $("name").value = r ? r.name : "";
    $("phone").value = r ? fmtPhone(r.phone) : "";
    $("area").value = r ? r.area || "" : "";
    $("memo").value = r ? r.memo || "" : "";
    $("consent").checked = r ? r.consent_confirmed : false;
    $("shareConsent").checked = r ? !!r.share_consent : false;
    $("trainDone").checked = r ? !!r.training_done : false;
    $("trainDate").value = r && r.training_date ? r.training_date : "";
    $("nat").value = r && r.is_foreign ? "foreign" : "kr";
    $("nationality").value = r && r.nationality ? r.nationality : "";
    $("visaType").value = r && r.visa_type ? r.visa_type : "";
    $("visaExpiry").value = r && r.visa_expiry ? r.visa_expiry : "";
    $("topik").value = r && r.topik_level ? r.topik_level : "";
    $("visaNote").value = r && r.visa_note ? r.visa_note : "";
    $("permitOk").checked = !!(r && r.work_permit_ok);
    $("permitInfo").textContent = r && r.work_permit_ok && r.work_permit_checked_on ? "확인한 날: " + r.work_permit_checked_on + " (체류자격·만료일을 바꾸면 확인 날짜가 새로 기록됩니다)" : "";
    $("foreignBox").hidden = $("nat").value !== "foreign";
    for (const cb of $("jobs").querySelectorAll("input")) cb.checked = !!r && r.job_type_ids.includes(cb.value);
    for (const cb of $("days").querySelectorAll("input")) cb.checked = !!r && r.available_days.includes(cb.value);
    if (isHq) $("branch").value = r ? r.branch_id : (me.branch_id || branches[0]?.id);
    for (const id of ["bankName", "bankNo", "bankHolder"]) $(id).value = "";
    refreshPrivateUI();
    loadDisclosures();
    $("err").textContent = "";
    $("dlg").showModal();
  }

  $("add").addEventListener("click", () => openForm(null));
  $("cancel").addEventListener("click", () => $("dlg").close());
  $("q").addEventListener("input", render);
  $("view").addEventListener("change", render);
  $("nat").addEventListener("change", () => { $("foreignBox").hidden = $("nat").value !== "foreign"; });
  for (const id of ["jobF", "dayF", "flagF"]) $(id).addEventListener("change", render);

  $("f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const phone = digits($("phone").value);
    if (!/^01\d{8,9}$/.test(phone)) { $("err").textContent = "휴대폰 번호를 확인해 주세요. (예: 010-1234-5678)"; return; }

    // 자체교육: 이수했다면 이수일 필요, 미래 날짜는 불가
    const trainDone = $("trainDone").checked;
    const trainDate = $("trainDate").value;
    if (trainDone && !trainDate) { $("err").textContent = "자체교육 이수일을 입력해 주세요."; return; }
    if (trainDone && trainDate > todayStr()) { $("err").textContent = "자체교육 이수일이 오늘보다 뒤입니다. 날짜를 확인해 주세요."; return; }

    // 외국인: 취업 가능 확인을 체크했다면 체류자격과 만료일 필요, 이미 지난 만료일은 불가
    const foreign = $("nat").value === "foreign";
    const permitOk = foreign && $("permitOk").checked;
    if (permitOk && (!$("visaType").value.trim() || !$("visaExpiry").value)) { $("err").textContent = "취업 가능 확인을 체크하려면 체류자격과 체류 만료일을 입력해 주세요."; return; }
    if (permitOk && $("visaExpiry").value < todayStr()) { $("err").textContent = "체류 만료일이 이미 지났습니다. 갱신했다면 새 만료일을 입력해 주세요."; return; }

    // 계좌: 세 칸 중 하나라도 적었으면 모두 필요
    const bank = { name: $("bankName").value.trim(), no: $("bankNo").value.trim(), holder: $("bankHolder").value.trim() };
    const bankTouched = !$("bankName").disabled && (bank.name || bank.no || bank.holder);
    if (bankTouched && !(bank.name && bank.no && bank.holder)) {
      $("err").textContent = "계좌 정보는 은행·계좌번호·예금주를 모두 입력해 주세요.";
      return;
    }

    const payload = {
      name: $("name").value.trim(),
      phone,
      job_type_ids: [...$("jobs").querySelectorAll("input:checked")].map((c) => c.value),
      area: $("area").value.trim() || null,
      available_days: [...$("days").querySelectorAll("input:checked")].map((c) => c.value),
      memo: $("memo").value.trim() || null,
      consent_confirmed: $("consent").checked,
      share_consent: $("shareConsent").checked,
      training_done: trainDone,
      training_date: trainDone ? trainDate : null,
      is_foreign: foreign,
      nationality: foreign ? $("nationality").value.trim() || null : null,
      visa_type: foreign ? $("visaType").value.trim() || null : null,
      visa_expiry: foreign ? $("visaExpiry").value || null : null,
      topik_level: foreign && $("topik").value ? Number($("topik").value) : null,
      visa_note: foreign ? $("visaNote").value.trim() || null : null,
      work_permit_ok: permitOk,
    };
    if (!editing) payload.branch_id = isHq ? $("branch").value : me.branch_id;
    else if (isHq) payload.branch_id = $("branch").value;

    $("save").disabled = true;
    $("err").textContent = "";

    // 1) 구직자 저장
    let saved;
    if (editing) {
      const { error } = await db.from("workers").update(payload).eq("id", editing.id);
      if (!error) saved = { id: editing.id, branch_id: payload.branch_id || editing.branch_id };
      var saveError = error;
    } else {
      const { data, error } = await db.from("workers").insert(payload).select("id,branch_id").single();
      if (!error) saved = data;
      var saveError = error;
    }
    if (saveError || !saved) {
      $("save").disabled = false;
      $("err").textContent = saveError && saveError.code === "23505" ? "이 지점에 이미 등록된 전화번호입니다." : "저장하지 못했습니다. 입력 내용을 확인해 주세요.";
      return;
    }
    // 이후 오류가 나도 다시 눌렀을 때 중복 등록되지 않도록 수정 상태로 전환
    editing = { ...(editing || {}), ...payload, ...saved };
    // 접수함에서 시작한 경우: 구직자가 만들어졌으니 접수를 '전환완료'로 표시
    if (convertFrom) {
      await db.rpc("mark_inquiry_converted", { p_inquiry: convertFrom.id, p_client: null, p_request: null, p_worker: saved.id });
      convertFrom = null;
    }

    // 2) 계좌, 3) 서류
    const problems = [];
    if (bankTouched) {
      const { error } = await db.rpc("set_worker_bank", { p_worker: saved.id, p_bank: bank.name, p_number: bank.no, p_holder: bank.holder });
      if (error) problems.push(/[가-힣]/.test(error.message) ? error.message : "계좌를 저장하지 못했습니다.");
    }
    for (const [kind, fileId, label] of [["id_card", "idFile", "신분증"], ["qualification", "qualFile", "자격증"], ["bankbook", "bookFile", "통장 사본"]]) {
      if (kind === "qualification" && $("qualBox").hidden) continue;   // 숨겨진 칸의 파일은 올리지 않음
      const file = $(fileId).files[0];
      if (!file) continue;
      try { await uploadDoc(saved, kind, file); } catch (err) { problems.push(label + ": " + err.message); }
    }

    $("save").disabled = false;
    await load();
    if (problems.length) {
      refreshPrivateUI();
      $("err").textContent = "구직자 정보는 저장되었지만 다음 항목을 처리하지 못했습니다. " + problems.join(" / ");
      return;
    }
    $("dlg").close();
  });

  // 접수함에서 [구직자로 등록]으로 넘어온 경우: 입력 창을 접수 내용으로 미리 채움
  async function startFromInquiry(id) {
    history.replaceState(null, "", "workers.html");
    const { data: q } = await db.from("inquiries").select("*").eq("id", id).maybeSingle();
    if (!q || q.type !== "구직") { alert("접수를 찾을 수 없거나 구직 접수가 아닙니다."); return; }
    if (q.status === "전환완료" && !confirm("이미 전환된 접수입니다. 그래도 새 구직자로 등록할까요?")) return;

    openForm(null);
    convertFrom = q;
    if (isHq) $("branch").value = q.branch_id;
    $("dlgTitle").textContent = "구직자 등록 (홈페이지 접수 " + q.receipt_no + ")";
    $("name").value = q.name || "";
    $("phone").value = fmtPhone(q.phone_digits);
    $("area").value = q.location || "";
    for (const jid of jobIdsFromText(q.field, jobTypes)) {
      const cb = $("jobs").querySelector('input[value="' + jid + '"]');
      if (cb) cb.checked = true;
    }
    // 홈페이지 양식에 있지만 이 프로그램에 칸이 없는 내용은 메모에 남김
    $("memo").value = [
      "홈페이지 접수 " + q.receipt_no,
      q.nationality && "구분: " + q.nationality,
      q.age_group && "연령대: " + q.age_group,
      q.work_type && "희망 형태: " + q.work_type,
      q.call_time && "연락 가능: " + q.call_time,
      q.details && "경력·자격: " + q.details,
    ].filter(Boolean).join(" / ").slice(0, 500);
    // 홈페이지 양식의 '구분'에 외국인이라고 적혀 있으면 외국인 칸을 열어 줌 (체류자격 등은 직접 확인해 입력)
    if (q.nationality && q.nationality.includes("외국")) {
      $("nat").value = "foreign";
      $("foreignBox").hidden = false;
    }
    // 홈페이지 동의는 '성함·연락처·희망 조건' 수집에 대한 것이라서, 신분증·계좌 동의는 따로 받아야 함 → 체크하지 않음
    $("consent").checked = false;
    updateQualVisibility();
    updateTrainVisibility();
    $("err").textContent = "접수 내용으로 미리 채웠습니다. 방문해서 신분증·계좌와 동의를 받은 뒤 해당 칸을 체크하세요.";
  }

  await loadBase();
  await load();
  const inqId = new URLSearchParams(location.search).get("inq");
  if (inqId) await startFromInquiry(inqId);
})();
