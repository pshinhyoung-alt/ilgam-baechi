// 의뢰인용 화면. 로그인 없이 링크의 토큰으로만 동작합니다.
(() => {
  const cfg = window.APP_CONFIG;
  // 직원이 같은 브라우저에서 로그인해 둔 상태여도 영향이 없도록 세션을 저장하지 않음
  const db = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const app = document.getElementById("app");
  const token = new URLSearchParams(location.search).get("t");
  const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
  const ST = { assigned: "응답 대기", notified: "응답 대기", accepted: "출근 전", working: "근무 중", checked_out: "퇴근", completed: "작업 완료" };

  let data = null;
  let confirm = null;                // "ok" | "problem"
  const picked = {};                 // assignment_id -> 별점
  const notes = {};                  // assignment_id -> 한마디

  function el(tag, text, cls) {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }
  const hhmm = (t) => t.slice(0, 5);
  const clock = (iso) => {
    const d = new Date(iso);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  };
  const message = (box, kind, text) => { box.className = "msg " + kind; box.textContent = text; };
  const errText = (e, fallback) => (e && /[가-힣]/.test(e.message) ? e.message : fallback);
  const starText = (n) => "★".repeat(n) + "☆".repeat(5 - n);

  function showFatal(text) { app.replaceChildren(el("div", text, "card")); }

  async function load() {
    const { data: d, error } = await db.rpc("client_get", { p_token: token });
    if (error) { showFatal(errText(error, "내용을 불러오지 못했습니다.")); return; }
    data = d;
    render();
  }

  function render() {
    const d = data;
    const date = new Date(d.work_date + "T00:00:00");
    const when = d.work_date.replace(/-/g, ". ") + ". (" + DAYS[date.getDay()] + ") " + hhmm(d.start_time) + " ~ " + hhmm(d.end_time);

    const info = el("div", undefined, "card");
    info.append(el("h2", (d.client_name ? d.client_name + " 님, " : "") + "인력 배치 안내입니다"));
    const dl = el("dl");
    const add = (k, v) => dl.append(el("dt", k), el("dd", v));
    add("일시", when);
    add("직종", d.job || "-");
    add("현장 주소", d.address);
    add("필요 인원", d.headcount + "명");
    if (d.branch_name) {
      const dd = el("dd", d.branch_name);
      if (d.branch_phone) {
        const a = el("a", " " + d.branch_phone);
        a.href = "tel:" + d.branch_phone.replace(/[^0-9+]/g, "");
        dd.append(a);
      }
      dl.append(el("dt", "담당 지점"), dd);
    }
    info.append(dl);

    // 배치된 구직자
    const list = el("div", undefined, "card");
    list.append(el("h2", "배치된 구직자 (" + d.workers.length + "명)"));
    if (!d.workers.length) list.append(el("div", "아직 배치된 구직자가 없습니다. 지점에서 배치를 마치면 이곳에 표시됩니다.", "muted"));
    const rateable = d.workers.filter((w) => ["working", "checked_out", "completed"].includes(w.status));
    const done = !!d.confirmed_at;
    for (const w of d.workers) {
      const row = el("div", undefined, "worker");
      const head = el("div");
      head.append(el("span", w.name, "wname"), document.createTextNode(" "), el("span", ST[w.status] || w.status, "status"));
      row.append(head);
      if (w.checked_in_at) row.append(el("div", "출근 " + clock(w.checked_in_at) + (w.checked_out_at ? " · 퇴근 " + clock(w.checked_out_at) : ""), "muted"));
      if (done && w.rating) {
        row.append(el("div", starText(w.rating) + (w.comment ? "  " + w.comment : ""), "muted"));
      } else if (!done && rateable.includes(w)) {
        const stars = el("div", undefined, "stars");
        for (let i = 1; i <= 5; i++) {
          const b = el("button", "★");
          b.type = "button";
          b.setAttribute("aria-label", i + "점");
          if ((picked[w.assignment_id] || 0) >= i) b.className = "on";
          b.addEventListener("click", () => { picked[w.assignment_id] = i; render(); });
          stars.append(b);
        }
        row.append(stars);
        if (picked[w.assignment_id]) {
          const ta = el("textarea");
          ta.rows = 2; ta.maxLength = 300; ta.placeholder = "한마디 (선택)";
          ta.value = notes[w.assignment_id] || "";
          ta.addEventListener("input", () => { notes[w.assignment_id] = ta.value; });
          row.append(ta);
        }
      }
      list.append(row);
    }

    const cards = [info, list];

    // 작업 확인
    const box = el("div", undefined, "card");
    const out = el("div");
    if (done) {
      box.append(el("h2", "작업 확인을 보내 주셨습니다"));
      message(out, d.confirm === "ok" ? "ok" : "info",
        d.confirm === "ok" ? "작업이 문제없이 끝났다고 확인해 주셨습니다. 감사합니다." : "문제가 있다고 알려 주셨습니다. 지점에서 연락드리겠습니다." + (d.confirm_note ? " (" + d.confirm_note + ")" : ""));
      box.append(out);
    } else if (!d.workers.some((w) => ["checked_out", "completed"].includes(w.status))) {
      box.append(el("h2", "작업 확인"));
      box.append(el("div", "구직자가 퇴근하면 이곳에서 작업 확인과 평가를 남기실 수 있습니다. 작업이 끝난 뒤 이 링크를 다시 열어 주세요.", "muted"));
    } else {
      box.append(el("h2", "작업은 잘 끝났나요?"));
      const row = el("div", undefined, "row");
      const ok = el("button", "문제 없음", "big sub" + (confirm === "ok" ? " on" : ""));
      const bad = el("button", "문제 있음", "big sub" + (confirm === "problem" ? " on" : ""));
      ok.addEventListener("click", () => { confirm = "ok"; render(); });
      bad.addEventListener("click", () => { confirm = "problem"; render(); });
      row.append(ok, bad);
      box.append(row);
      const ta = el("textarea");
      ta.id = "cnote"; ta.rows = 3; ta.maxLength = 500;
      ta.placeholder = confirm === "problem" ? "어떤 문제가 있었는지 적어 주세요. (필수)" : "남기실 말씀이 있으면 적어 주세요. (선택)";
      ta.value = notes.__all || "";
      ta.addEventListener("input", () => { notes.__all = ta.value; });
      const go = el("button", "보내기", "big");
      go.disabled = !confirm;
      go.addEventListener("click", () => submit(go, out));
      box.append(ta, go, out);
      box.append(el("div", "한 번 보내면 고칠 수 없습니다. 별점은 선택하신 구직자에게만 남습니다.", "muted"));
    }
    cards.push(box);
    app.replaceChildren(...cards);
  }

  async function submit(button, out) {
    if (confirm === "problem" && !(notes.__all || "").trim()) { message(out, "err", "문제가 있는 경우 내용을 적어 주세요."); return; }
    button.disabled = true;
    const ratings = Object.keys(picked).map((id) => ({ assignment_id: id, rating: picked[id], comment: notes[id] || null }));
    const { data: d, error } = await db.rpc("client_submit", {
      p_token: token, p_confirm: confirm, p_note: notes.__all || null, p_ratings: ratings,
    });
    if (error) { message(out, "err", errText(error, "보내지 못했습니다. 다시 시도해 주세요.")); button.disabled = false; return; }
    data = d;
    render();
  }

  if (!token) { showFatal("올바르지 않은 링크입니다. 지점에서 받은 링크를 다시 눌러 주세요."); return; }
  load();
})();
