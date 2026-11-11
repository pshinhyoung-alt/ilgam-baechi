// 구직자용 화면. 로그인 없이 링크의 토큰으로만 동작합니다.
(() => {
  const cfg = window.APP_CONFIG;
  // 직원이 같은 브라우저에서 로그인해 둔 상태여도 영향이 없도록 세션을 저장하지 않음
  const db = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const app = document.getElementById("app");
  const token = new URLSearchParams(location.search).get("t");
  const DAYS = ["일", "월", "화", "수", "목", "금", "토"];

  let data = null;
  let consentChecked = false;

  function el(tag, text, cls) {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }
  const won = (n) => Number(n).toLocaleString("ko-KR") + "원";
  const hhmm = (t) => t.slice(0, 5);
  const clock = (iso) => {
    const d = new Date(iso);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  };
  const message = (box, kind, text) => { box.className = "msg " + kind; box.textContent = text; };
  const errText = (e, fallback) => (e && /[가-힣]/.test(e.message) ? e.message : fallback);

  function showFatal(text) {
    app.replaceChildren(Object.assign(el("div", text, "card"), {}));
  }

  async function load() {
    const { data: d, error } = await db.rpc("worker_get", { p_token: token });
    if (error) { showFatal(errText(error, "일감 정보를 불러오지 못했습니다.")); return; }
    data = d;
    render();
  }

  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error("이 휴대폰 브라우저는 위치 기능을 지원하지 않습니다.")); return; }
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
        (e) => reject(new Error(
          e.code === 1 ? "위치 권한이 꺼져 있습니다. 브라우저 설정에서 이 페이지의 위치 권한을 허용해 주세요."
          : e.code === 3 ? "위치 확인 시간이 지났습니다. 실외에서 다시 눌러 주세요."
          : "위치를 확인하지 못했습니다. 다시 눌러 주세요.")),
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    });
  }

  function render() {
    const d = data;
    const date = new Date(d.work_date + "T00:00:00");
    const when = d.work_date.replace(/-/g, ". ") + ". (" + DAYS[date.getDay()] + ") " + hhmm(d.start_time) + " ~ " + hhmm(d.end_time);

    const info = el("div", undefined, "card");
    info.append(el("h2", d.worker_name + " 님, 일감 안내입니다"));
    const dl = el("dl");
    const add = (k, v) => { dl.append(el("dt", k), el("dd", v)); };
    add("일시", when);
    add("직종", d.job || "-");
    const deducted = d.fee_enabled || d.tax_enabled;
    add(deducted ? "일당 (공제 전)" : "일당", won(d.wage));
    if (d.fee_enabled) add("소개수수료 (" + d.fee_rate + "%)", "− " + won(d.fee_amount));
    if (d.tax_enabled && d.tax) {
      add("소득세 (사업소득 원천징수)", "− " + won(d.tax.income));
      add("지방소득세", "− " + won(d.tax.local));
    }
    if (deducted) add("지급 예정액", won(d.net_wage));
    const ddAddr = el("dd", d.address);
    const mapUrl = d.lat != null
      ? "https://map.kakao.com/link/map/" + encodeURIComponent("작업 현장") + "," + d.lat + "," + d.lng
      : "https://map.kakao.com/?q=" + encodeURIComponent(d.address);
    const mapA = el("a", " 지도 보기");
    mapA.href = mapUrl; mapA.target = "_blank"; mapA.rel = "noopener";
    ddAddr.append(mapA);
    dl.append(el("dt", "현장 주소"), ddAddr);
    if (d.requirements) add("요구 조건", d.requirements);
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
    if (d.fee_enabled || d.tax_enabled) {
      info.append(el("div", "※ 공제 금액은 예상액이며 정산 때 확정됩니다." + (d.tax_enabled ? " 원천징수는 소개수수료를 뺀 금액 " + won(d.tax_base) + " 기준입니다." : ""), "muted"));
    }

    const stLabel = {
      assigned: "응답 대기", notified: "응답 대기", accepted: "수락함", declined: "거절함", cancelled: "취소됨",
      working: "근무 중", checked_out: "퇴근함", completed: "작업 완료",
    }[d.status] || d.status;
    const stBox = el("div", undefined, "card");
    stBox.append(el("h2", "내 상태"), el("span", stLabel, "status"));
    if (d.checked_in_at) stBox.append(el("div", "출근 " + clock(d.checked_in_at) + (d.checked_out_at ? " · 퇴근 " + clock(d.checked_out_at) : ""), "muted"));

    const action = el("div", undefined, "card");
    const out = el("div");   // 결과 메시지 자리
    const paused = d.request_status === "hold";

    if (paused && !["completed", "declined", "cancelled"].includes(d.status)) {
      message(out, "info", "이 일감은 지금 진행이 멈춰 있습니다. 지점의 안내를 기다려 주세요.");
      action.append(out);
    } else if (d.status === "assigned" || d.status === "notified") {
      action.append(el("h2", "이 일감을 하시겠어요?"));
      const row = el("div", undefined, "row");
      const yes = el("button", "수락", "big");
      const no = el("button", "거절", "big sub");
      yes.addEventListener("click", () => respond(true, [yes, no], out));
      no.addEventListener("click", () => { if (confirm("이 일감을 거절할까요?")) respond(false, [yes, no], out); });
      row.append(yes, no);
      action.append(row, out);
    } else if (d.status === "accepted" || d.status === "working") {
      const isIn = d.status === "accepted";
      action.append(el("h2", isIn ? "출근하기" : "퇴근하기"));
      action.append(el("div", "현장 반경 " + d.radius_m + "m 안에서 버튼을 눌러 주세요. 버튼을 누를 때 한 번만 위치를 확인하며, 계속 추적하지 않습니다.", "muted"));
      if (isIn) {
        const opens = new Date(d.check_in_opens_at);
        if (new Date(d.now) < opens) action.append(el("div", "출근은 " + clock(d.check_in_opens_at) + " 부터 누를 수 있습니다.", "muted"));
      }
      const label = el("label", undefined, "consent");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = consentChecked;
      cb.addEventListener("change", () => { consentChecked = cb.checked; });
      label.append(cb, el("span", "출근·퇴근 확인을 위해 이 휴대폰의 위치정보를 수집·이용하는 것에 동의합니다. (버튼을 누를 때만 수집)"));
      const b = el("button", isIn ? "출근" : "퇴근", "big");
      b.addEventListener("click", () => check(isIn ? "in" : "out", b, out));
      action.append(label, b, out);
    } else if (d.status === "checked_out") {
      action.append(el("h2", "작업 완료 보고"));
      const ta = el("textarea");
      ta.rows = 3; ta.maxLength = 500; ta.placeholder = "특이사항이 있으면 적어 주세요. (선택)";
      const b = el("button", "작업 완료", "big");
      b.addEventListener("click", () => complete(ta.value, b, out));
      action.append(ta, b, out);
    } else if (d.status === "completed") {
      message(out, "ok", "작업이 완료 처리되었습니다. 수고하셨습니다.");
      action.append(out);
    } else if (d.status === "declined") {
      message(out, "info", "이 일감은 거절하셨습니다.");
      action.append(out);
    } else if (d.status === "cancelled") {
      message(out, "info", "이 일감은 취소되었습니다. 지점에 문의해 주세요.");
      action.append(out);
    }

    app.replaceChildren(info, stBox, action);
  }

  async function respond(accept, buttons, out) {
    buttons.forEach((b) => (b.disabled = true));
    const { data: d, error } = await db.rpc("worker_respond", { p_token: token, p_accept: accept });
    if (error) { message(out, "err", errText(error, "처리하지 못했습니다. 다시 시도해 주세요.")); buttons.forEach((b) => (b.disabled = false)); return; }
    data = d;
    render();
  }

  async function check(kind, button, out) {
    if (!consentChecked) { message(out, "err", "위치정보 수집·이용에 동의해 주세요."); return; }
    button.disabled = true;
    message(out, "info", "위치를 확인하는 중입니다. 잠시만 기다려 주세요...");
    try {
      const pos = await getPosition();
      const { data: res, error } = await db.rpc("worker_check", {
        p_token: token, p_kind: kind, p_lat: pos.lat, p_lng: pos.lng, p_acc: pos.acc, p_consent: true,
      });
      if (error) throw new Error(errText(error, "처리하지 못했습니다. 다시 시도해 주세요."));
      if (!res.ok) {
        message(out, "err", "현장에서 약 " + res.distance_m + "m 떨어져 있습니다. 현장 반경 " + res.radius_m + "m 안에서 다시 눌러 주세요.");
        button.disabled = false;
        return;
      }
      await load();
      const done = document.querySelector(".card:last-child");
      if (done) {
        const note = el("div");
        message(note, "ok", (kind === "in" ? "출근" : "퇴근") + " 처리되었습니다. (현장에서 약 " + res.distance_m + "m)");
        done.append(note);
      }
    } catch (e) {
      message(out, "err", e.message);
      button.disabled = false;
    }
  }

  async function complete(note, button, out) {
    button.disabled = true;
    const { data: d, error } = await db.rpc("worker_complete", { p_token: token, p_note: note });
    if (error) { message(out, "err", errText(error, "처리하지 못했습니다. 다시 시도해 주세요.")); button.disabled = false; return; }
    data = d;
    render();
  }

  if (!token) { showFatal("올바르지 않은 링크입니다. 문자나 카톡으로 받은 링크를 다시 눌러 주세요."); return; }
  load();
})();
