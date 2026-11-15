// 앱 설치 (홈 화면 아이콘) — 모든 직원 화면에서 함께 씀
// 메뉴 줄(#nav)의 로그아웃 버튼 앞에 [📱 앱 설치] 버튼을 넣습니다. (설치할 수 없는 브라우저·이미 설치한 앱에서는 보이지 않음)
(function () {
  let installEvt = null;
  const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  function addInstallBtn() {
    const nav = document.getElementById("nav");
    if (!nav || !nav.lastElementChild || document.getElementById("installBtn") || isStandalone()) return;
    if (!installEvt && !isIOS) return;
    const b = document.createElement("button");
    b.id = "installBtn";
    b.textContent = "📱 앱 설치";
    b.addEventListener("click", async () => {
      if (installEvt) {
        installEvt.prompt();
        await installEvt.userChoice.catch(() => {});
        installEvt = null;
        b.remove();
      } else {
        alert("아이폰은 사파리에서 아래쪽 공유 버튼(네모에 화살표)을 누른 뒤 '홈 화면에 추가'를 선택하세요.");
      }
    });
    nav.insertBefore(b, nav.lastElementChild);   // 로그아웃 버튼 앞에
  }

  window.addInstallBtn = addInstallBtn;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; addInstallBtn(); });
  window.addEventListener("appinstalled", () => { installEvt = null; const b = document.getElementById("installBtn"); if (b) b.remove(); });
  document.addEventListener("DOMContentLoaded", addInstallBtn);
})();
