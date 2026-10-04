// wallet docs: theme toggle, mobile menu, copy buttons. Nothing else.
(function () {
  var root = document.documentElement;
  root.classList.add("js");

  // Theme: the stored choice wins over the OS setting (applied early in <head>).
  var dark = window.matchMedia("(prefers-color-scheme: dark)");
  document.querySelectorAll("[data-theme-toggle]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var current = root.dataset.theme || (dark.matches ? "dark" : "light");
      var next = current === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      try {
        localStorage.setItem("wallet-docs-theme", next);
      } catch (e) {}
    });
  });

  // Menu (sidebar drawer on narrow screens).
  var body = document.body;
  var toggle = document.querySelector("[data-menu-toggle]");
  var backdrop = document.querySelector(".backdrop");
  function setOpen(open) {
    body.classList.toggle("nav-open", open);
    if (backdrop) backdrop.hidden = !open;
    if (toggle) toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      var current = document.querySelector('.sidebar [aria-current="page"]') || document.querySelector(".sidebar a");
      if (current) current.focus({ preventScroll: false });
    }
  }
  if (toggle) toggle.addEventListener("click", function () { setOpen(!body.classList.contains("nav-open")); });
  document.querySelectorAll("[data-menu-close]").forEach(function (el) {
    el.addEventListener("click", function () {
      setOpen(false);
      if (toggle) toggle.focus();
    });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && body.classList.contains("nav-open")) {
      setOpen(false);
      if (toggle) toggle.focus();
    }
  });
  document.querySelectorAll(".sidebar a").forEach(function (a) {
    a.addEventListener("click", function () { setOpen(false); });
  });

  // Copy buttons on code blocks.
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error("copy failed"));
    });
  }
  document.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest(".copy") : null;
    if (!btn) return;
    var code = btn.parentNode.querySelector("pre code");
    if (!code) return;
    copyText(code.textContent.replace(/\n$/, "")).then(
      function () {
        btn.textContent = "Copied";
        btn.classList.add("copied");
        setTimeout(function () {
          btn.textContent = "Copy";
          btn.classList.remove("copied");
        }, 1600);
      },
      function () {
        btn.textContent = "Press ⌘C";
      },
    );
  });
})();
