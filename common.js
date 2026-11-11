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


function digits(s) { return (s || "").replace(/\D/g, ""); }

function fmtPhone(s) {
  const d = digits(s);
  if (d.length === 11) return d.replace(/(\d{3})(\d{4})(\d{4})/, "$1-$2-$3");
  if (d.length === 10) return d.replace(/(\d{2,3})(\d{3,4})(\d{4})/, "$1-$2-$3");
  return s;
}

function renderNav(current, me) {
  const nav = document.getElementById("nav");
  const links = [["admin.html", "홈"], ["requests.html", "인력의뢰"], ["workers.html", "구직자"], ["clients.html", "의뢰인"]];
  if (me && me.role !== "branch_staff") links.push(["settings.html", "설정"]);
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
  return me;
}
