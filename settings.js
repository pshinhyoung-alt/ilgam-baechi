(async () => {
  const me = await requireStaff("settings.html");
  if (!me) return;
  if (me.role === "branch_staff") {
    document.querySelector("main").replaceChildren(el("div", "설정은 관리자만 볼 수 있습니다.", "msg"));
    return;
  }
  const isHq = me.role === "hq_admin";
  const $ = (id) => document.getElementById(id);
  let types = [];

  // ───────── 직종 ─────────
  async function loadTypes() {
    const { data, error } = await db.from("job_types").select("*").order("sort_order").order("created_at");
    if (error) { $("typeEmpty").textContent = "직종을 불러오지 못했습니다."; return; }
    types = data;
    renderTypes();
  }

  function btn(label, cls, fn, disabled) {
    const b = el("button", label, cls);
    b.disabled = !!disabled;
    b.addEventListener("click", async () => { b.disabled = true; await fn(); b.disabled = !!disabled; });
    return b;
  }

  async function run(promise, failMsg) {
    const { error } = await promise;
    if (error) {
      alert(error.code === "23505" ? "이미 있는 직종 이름입니다." : /[가-힣]/.test(error.message) ? error.message : failMsg);
      return false;
    }
    await loadTypes();
    return true;
  }

  function renderTypes() {
    const tbody = $("typeRows");
    tbody.replaceChildren();
    $("typeEmpty").textContent = types.length ? "" : "등록된 직종이 없습니다.";
    types.forEach((t, i) => {
      const tr = document.createElement("tr");
      const order = el("td");
      order.style.whiteSpace = "nowrap";
      order.append(
        btn("▲", "", () => move(i, -1), i === 0),
        document.createTextNode(" "),
        btn("▼", "", () => move(i, 1), i === types.length - 1));
      const acts = el("div", undefined, "acts");
      acts.append(
        btn("이름 변경", "", async () => {
          const name = prompt("직종 이름을 입력하세요.", t.name);
          if (name === null || !name.trim() || name.trim() === t.name) return;
          await run(db.from("job_types").update({ name: name.trim() }).eq("id", t.id), "이름을 바꾸지 못했습니다.");
        }),
        btn(t.active ? "사용 안 함" : "다시 사용", "", () => run(db.from("job_types").update({ active: !t.active }).eq("id", t.id), "변경하지 못했습니다.")),
        btn("삭제", "danger", async () => {
          if (!confirm("'" + t.name + "' 직종을 삭제합니다.\n이미 쓰고 있는 직종이면 삭제하지 않고 '사용 안 함'으로 숨깁니다.")) return;
          const { data, error } = await db.rpc("delete_job_type", { p_id: t.id });
          if (error) { alert(/[가-힣]/.test(error.message) ? error.message : "삭제하지 못했습니다."); return; }
          if (data === "hidden") alert("이미 구직자나 인력의뢰에서 쓰고 있어서, 삭제하지 않고 '사용 안 함'으로 숨겼습니다.");
          await loadTypes();
        }));
      const actTd = el("td");
      actTd.append(acts);

      // 자격증 설정: 칸을 보일지 / 없으면 경고할지
      const qualTd = el("td");
      const toggle = (label, field) => {
        const l = el("label");
        l.style.cssText = "display:block;font-size:13px;white-space:nowrap";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!t[field];
        cb.addEventListener("change", async () => {
          const patch = { [field]: cb.checked };
          if (field === "show_qualification" && !cb.checked) patch.qualification_required = false;
          if (field === "qualification_required" && cb.checked) patch.show_qualification = true;
          if (!(await run(db.from("job_types").update(patch).eq("id", t.id), "변경하지 못했습니다."))) await loadTypes();
        });
        l.append(cb, document.createTextNode(" " + label));
        return l;
      };
      qualTd.append(
        toggle("자격증 칸 표시", "show_qualification"),
        toggle("자격증 미등록 경고(필수)", "qualification_required"),
        toggle("자체교육 필요", "training_required"));

      tr.append(order, el("td", t.name), el("td", t.active ? "사용 중" : "사용 안 함"), qualTd, actTd);
      if (!t.active) tr.style.opacity = ".6";
      tbody.append(tr);
    });
  }

  // 위·아래 직종과 순서를 맞바꿈
  async function move(i, dir) {
    const a = types[i], b = types[i + dir];
    if (!b) return;
    const [r1, r2] = await Promise.all([
      db.from("job_types").update({ sort_order: i + dir + 1 }).eq("id", a.id),
      db.from("job_types").update({ sort_order: i + 1 }).eq("id", b.id),
    ]);
    if (r1.error || r2.error) alert("순서를 바꾸지 못했습니다.");
    await loadTypes();
  }

  $("addType").addEventListener("click", async () => {
    const name = $("newType").value.trim();
    if (!name) { alert("직종 이름을 입력해 주세요."); return; }
    const next = types.reduce((m, t) => Math.max(m, t.sort_order), 0) + 1;
    if (await run(db.from("job_types").insert({ name, sort_order: next }), "추가하지 못했습니다.")) $("newType").value = "";
  });

  // ───────── 기준값 ─────────
  async function loadSettings() {
    const { data } = await db.from("app_settings").select("*").maybeSingle();
    if (!data) { $("setErr").textContent = "기준값을 불러오지 못했습니다."; return; }
    $("minWage").value = data.min_hourly_wage;
    $("defRadius").value = data.default_radius_m;
    $("feeDef").value = data.default_fee_rate != null ? data.default_fee_rate : 10;
    $("feeMax").value = data.max_fee_rate != null ? data.max_fee_rate : "";
    $("incomeTax").value = data.income_tax_rate != null ? data.income_tax_rate : 3;
    $("localTax").value = data.local_tax_rate != null ? data.local_tax_rate : 10;
  }

  if (!isHq) {
    $("minWage").disabled = true;
    $("defRadius").disabled = true;
    $("feeDef").disabled = true;
    $("feeMax").disabled = true;
    for (const id of ["incomeTax", "localTax"]) $(id).disabled = true;
    $("saveSet").hidden = true;
    $("setNote").textContent = "기준값은 본사 관리자만 바꿀 수 있습니다.";
  }

  $("saveSet").addEventListener("click", async () => {
    $("setErr").textContent = "";
    $("setNote").textContent = "";
    const wage = Number($("minWage").value);
    const radius = Number($("defRadius").value);
    if (!Number.isInteger(wage) || wage <= 0) { $("setErr").textContent = "최저임금을 올바르게 입력해 주세요."; return; }
    if (!Number.isInteger(radius) || radius < 50 || radius > 2000) { $("setErr").textContent = "기본 출근 반경은 50~2000m 사이로 입력해 주세요."; return; }
    const feeDef = Number($("feeDef").value);
    const feeMaxStr = $("feeMax").value.trim();
    const feeMax = feeMaxStr === "" ? null : Number(feeMaxStr);
    if (!(feeDef >= 0 && feeDef <= 100)) { $("setErr").textContent = "기본 소개수수료율은 0~100 사이로 입력해 주세요."; return; }
    if (feeMax !== null && !(feeMax >= 0 && feeMax <= 100)) { $("setErr").textContent = "수수료율 상한은 0~100 사이로 입력하거나 비워 주세요."; return; }
    const incomeTax = Number($("incomeTax").value);
    const localTax = Number($("localTax").value);
    if (!(incomeTax >= 0 && incomeTax <= 30)) { $("setErr").textContent = "소득세율은 0~30 사이로 입력해 주세요."; return; }
    if (!(localTax >= 0 && localTax <= 100)) { $("setErr").textContent = "지방소득세율은 0~100 사이로 입력해 주세요."; return; }
    $("saveSet").disabled = true;
    const { error } = await db.from("app_settings")
      .update({
        min_hourly_wage: wage, default_radius_m: radius, default_fee_rate: feeDef, max_fee_rate: feeMax,
        income_tax_rate: incomeTax, local_tax_rate: localTax,
      }).eq("id", true);
    $("saveSet").disabled = false;
    if (error) { $("setErr").textContent = "저장하지 못했습니다."; return; }
    $("setNote").textContent = "저장했습니다.";
  });

  await loadTypes();
  await loadSettings();
})();
