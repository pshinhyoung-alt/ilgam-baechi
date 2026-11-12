(async () => {
  const me = await requireStaff("clients.html");
  if (!me) return;
  const isAdmin = me.role !== "branch_staff";
  const isHq = me.role === "hq_admin";

  let branches = [], rows = [], shown = [], editing = null;
  let stats = {};   // 의뢰인 id -> { n: 의뢰 건수, last: 마지막 작업일 }
  const $ = (id) => document.getElementById(id);

  const views = [["active", "사용 중"]];
  if (isAdmin) views.push(["trash", "휴지통"]);
  for (const [v, label] of views) $("view").append(new Option(label, v));

  // 머리글을 눌러 정렬: 이름/업체명, 전화, 주소, 메모, 의뢰 건수
  const nOf = (r) => (stats[r.id] ? stats[r.id].n : 0);
  const sorter = setupSort(document.querySelector("main table"), [
    (r) => r.name, (r) => digits(r.phone), (r) => r.address || "", (r) => r.memo || "", nOf, null,
  ], () => render());
  const reqText = (r) => (stats[r.id] ? stats[r.id].n + "건 · 마지막 " + stats[r.id].last : "의뢰 없음");

  // 지금 화면에 보이는 목록(검색·보기 적용)을 엑셀로 / 인쇄·PDF로
  $("xlsx").addEventListener("click", () => {
    if (!shown.length) { alert("내려받을 의뢰인이 없습니다."); return; }
    saveXlsx("의뢰인", "의뢰인", ["이름/업체명", "전화", "주소", "메모", "의뢰 건수", "마지막 의뢰일"],
      shown.map((r) => [r.name, fmtPhone(r.phone), r.address || "", r.memo || "", nOf(r), stats[r.id] ? stats[r.id].last : ""]));
  });
  $("print").addEventListener("click", () => {
    const q = $("q").value.trim();
    printPage("의뢰인 목록 - " + $("view").selectedOptions[0].text + (q ? " (검색: " + q + ")" : ""));
  });

  async function loadBase() {
    if (!isHq) return;
    const { data } = await db.from("branches").select("id,name").order("name");
    branches = data || [];
    $("branchRow").hidden = false;
    for (const b of branches) $("branch").append(new Option(b.name, b.id));
  }

  async function load() {
    const { data, error } = await db.from("clients").select("*").order("created_at", { ascending: false });
    if (error) { $("empty").textContent = "목록을 불러오지 못했습니다."; return; }
    rows = data;
    // 의뢰인별 의뢰 건수·마지막 작업일 (휴지통 의뢰 제외, 1000건씩 이어서)
    stats = {};
    for (let off = 0; ; off += 1000) {
      const { data: reqs, error: e2 } = await db.from("job_requests").select("client_id,work_date").is("deleted_at", null).range(off, off + 999);
      if (e2) break;
      for (const q of reqs) {
        const s = stats[q.client_id] || (stats[q.client_id] = { n: 0, last: "" });
        s.n += 1;
        if (q.work_date > s.last) s.last = q.work_date;
      }
      if (reqs.length < 1000) break;
    }
    render();
  }

  function render() {
    const q = $("q").value.trim().toLowerCase();
    const qd = digits(q);
    const trash = $("view").value === "trash";
    const list = sorter(rows.filter((r) => {
      if (trash !== !!r.deleted_at) return false;
      if (!q) return true;
      return r.name.toLowerCase().includes(q) || (qd && r.phone.includes(qd))
        || [r.address, r.memo].join("\n").toLowerCase().includes(q);
    }));
    shown = list;
    const tbody = $("rows");
    tbody.replaceChildren();
    $("empty").textContent = list.length ? "" : "표시할 의뢰인이 없습니다.";
    for (const r of list) {
      const tr = document.createElement("tr");
      // 이름·의뢰 건수를 누르면 그 의뢰인의 인력의뢰만 모아 보여 줌
      const link = (text) => { const a = el("a", text); a.href = "requests.html?client=" + r.id; a.title = "이 의뢰인의 인력의뢰 보기"; return a; };
      const nameTd = el("td"); nameTd.append(link(r.name));
      const reqTd = el("td"); if (nOf(r)) reqTd.append(link(reqText(r))); else reqTd.textContent = reqText(r);
      tr.append(nameTd, el("td", fmtPhone(r.phone)), el("td", r.address || ""), el("td", r.memo || ""), reqTd, actions(r));
      tbody.append(tr);
    }
  }

  function btn(label, cls, fn) {
    const b = el("button", label, cls);
    b.addEventListener("click", async () => { b.disabled = true; await fn(); b.disabled = false; });
    return b;
  }

  async function run(promise, failMsg) {
    const { error } = await promise;
    if (error) { alert(error.message.includes("관리자만") ? error.message : failMsg); return; }
    await load();
  }

  function actions(r) {
    const td = el("td");
    const box = el("div", undefined, "acts");
    if (r.deleted_at) {
      box.append(
        btn("복구", "", () => run(db.from("clients").update({ deleted_at: null }).eq("id", r.id), "복구하지 못했습니다.")),
        btn("완전 삭제", "danger", async () => {
          if (!confirm(r.name + " 을(를) 완전히 삭제합니다. 되돌릴 수 없습니다. 계속할까요?")) return;
          await run(db.from("clients").delete().eq("id", r.id), "삭제하지 못했습니다. 이 의뢰인과 연결된 기록이 있을 수 있습니다.");
        }));
    } else {
      box.append(btn("수정", "", async () => openForm(r)));
      if (isAdmin) {
        box.append(btn("삭제", "danger", async () => {
          if (!confirm(r.name + " 을(를) 휴지통으로 보냅니다. 휴지통에서 복구할 수 있습니다.")) return;
          await run(db.from("clients").update({ deleted_at: new Date().toISOString() }).eq("id", r.id), "삭제하지 못했습니다.");
        }));
      }
    }
    td.append(box);
    return td;
  }

  function openForm(r) {
    editing = r || null;
    $("dlgTitle").textContent = r ? "의뢰인 수정" : "의뢰인 등록";
    $("name").value = r ? r.name : "";
    $("phone").value = r ? fmtPhone(r.phone) : "";
    $("address").value = r ? r.address || "" : "";
    $("memo").value = r ? r.memo || "" : "";
    if (isHq) $("branch").value = r ? r.branch_id : (me.branch_id || branches[0]?.id);
    $("err").textContent = "";
    $("dlg").showModal();
  }

  $("add").addEventListener("click", () => openForm(null));
  $("cancel").addEventListener("click", () => $("dlg").close());
  $("q").addEventListener("input", render);
  $("view").addEventListener("change", render);

  $("f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const phone = digits($("phone").value);
    if (!/^01\d{8,9}$/.test(phone) && !/^0[2-9]\d{7,9}$/.test(phone)) {
      $("err").textContent = "전화번호를 확인해 주세요. (예: 010-1234-5678, 033-123-4567)";
      return;
    }
    const payload = {
      name: $("name").value.trim(),
      phone,
      address: $("address").value.trim() || null,
      memo: $("memo").value.trim() || null,
    };
    if (!editing) payload.branch_id = isHq ? $("branch").value : me.branch_id;
    else if (isHq) payload.branch_id = $("branch").value;

    $("save").disabled = true;
    const { error } = await (editing ? db.from("clients").update(payload).eq("id", editing.id) : db.from("clients").insert(payload));
    $("save").disabled = false;
    if (error) { $("err").textContent = "저장하지 못했습니다. 입력 내용을 확인해 주세요."; return; }
    $("dlg").close();
    await load();
  });

  await loadBase();
  await load();
})();
