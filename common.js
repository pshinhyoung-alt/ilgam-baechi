// 모든 직원 화면에서 함께 쓰는 도구
const cfg = window.APP_CONFIG;
const db = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);
const ROLE = { hq_admin: "본사 관리자", branch_manager: "지점장", branch_staff: "지점 직원" };

function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

// 금액 × 비율(%) 을 원 단위로 절사 (서버와 같은 방식). 비율은 소수점 이하 scale 자릿수까지 정수로 바꿔 계산
function cutRate(amount, rate, scale) {
  return Math.floor((amount * Math.round(Number(rate) * scale)) / (scale * 100));
}

// 사업소득세 원천징수 (서버의 tax_calc 와 같은 방식)
//  소득세 = 기준액 × 소득세율 (원 단위 절사), 지방소득세 = 소득세 × 지방소득세율 (10원 미만 절사)
//  기준액 = 확정 단가 − 소개수수료
function calcTax(base, s) {
  base = Math.max(0, base);
  const income = cutRate(base, s.income_tax_rate, 100);
  const local = Math.floor(cutRate(income, s.local_tax_rate, 100) / 10) * 10;
  return { income, local, total: income + local };
}


// 표를 엑셀 파일로 저장. head: 제목 줄 배열, body: 줄마다 값 배열 (xlsx 라이브러리를 화면에서 먼저 불러와 둘 것)
function saveXlsx(fileBase, sheetName, head, body) {
  if (typeof XLSX === "undefined") { alert("엑셀 도구를 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요."); return; }
  const ws = XLSX.utils.aoa_to_sheet([head, ...body]);
  ws["!cols"] = head.map((h, i) => ({ wch: Math.min(40, Math.max(String(h).length * 2, ...body.map((r) => String(r[i] ?? "").length)) + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const d = new Date();
  const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  XLSX.writeFile(wb, fileBase + "_" + ymd + ".xlsx");
}

function digits(s) { return (s || "").replace(/\D/g, ""); }

function fmtPhone(s) {
  const d = digits(s);
  if (d.length === 11) return d.replace(/(\d{3})(\d{4})(\d{4})/, "$1-$2-$3");
  if (d.length === 10) return d.replace(/(\d{2,3})(\d{3,4})(\d{4})/, "$1-$2-$3");
  return s;
}

function renderNav(current, me) {
  const nav = document.getElementById("nav");
  const links = [["admin.html", "홈"], ["inquiries.html", "접수함"], ["requests.html", "인력의뢰"], ["workers.html", "구직자"], ["clients.html", "의뢰인"]];
  if (me && me.role !== "branch_staff") links.push(["settlement.html", "정산"], ["settings.html", "설정"]);
  for (const [href, label] of links) {
    const a = el("a", label);
    a.href = href;
    if (href === current) a.className = "cur";
    nav.append(a);
  }
  const out = el("button", "로그아웃");
  out.addEventListener("click", async () => {
    await db.auth.signOut();
    location.replace("index.html");
  });
  nav.append(out);
}

// 로그인 확인 + 내 직원 정보 가져오기. 문제가 있으면 안내 후 null
async function requireStaff(current) {
  const { data: s } = await db.auth.getSession();
  if (!s.session) { location.replace("index.html"); return null; }
  const { data: me, error } = await db.from("staff").select("*").eq("user_id", s.session.user.id).maybeSingle();
  const main = document.querySelector("main");
  if (error || !me || !me.active) {
    main.replaceChildren(el("div", "등록되지 않았거나 사용이 중지된 계정입니다. 본사 관리자에게 문의하세요.", "msg"));
    return null;
  }
  renderNav(current, me);
  // 접수함 메뉴에 '신규' 접수 건수를 작게 표시 (접수 기능이 아직 없으면 조용히 건너뜀)
  db.from("inquiries").select("id", { count: "exact", head: true }).eq("status", "신규").then(({ count, error }) => {
    if (error || !count) return;
    const a = document.querySelector('#nav a[href="inquiries.html"]');
    if (a) a.append(el("span", count > 99 ? "99+" : String(count), "badge"));
  });
  return me;
}

// 홈페이지 접수의 분야 문구 → 직종 id 목록 (직종 '이름'으로 연결: 집수리·건설·청소·폐기물·농업·간병·돌봄·요양보호사)
function jobIdsFromText(text, jobTypes) {
  const t = String(text || "").replace(/생활\s*돌봄\s*\(?\s*집수리\s*\)?/g, "집수리");
  const rules = [
    [/집수리/, "집수리"], [/건설/, "건설"], [/청소/, "청소"], [/폐기물/, "폐기물"], [/농업/, "농업"],
    [/간병|돌봄|요양/, "간병·돌봄"], [/요양보호사/, "요양보호사"],
  ];
  const ids = [];
  for (const [re, name] of rules) {
    if (!re.test(t)) continue;
    const j = jobTypes.find((x) => x.name === name);
    if (j && !ids.includes(j.id)) ids.push(j.id);
  }
  return ids;
}
