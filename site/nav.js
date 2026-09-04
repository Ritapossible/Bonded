// Menu behaviour that <details> does not give you for free: close it when a link is
// followed to an anchor on this same page, on Escape, and on a tap outside. Without
// this the panel stays open over the section you just jumped to.
(function () {
  "use strict";

  // The docs table of contents ships open, so it is correct on a desktop and correct
  // with no JavaScript. On a phone it is twenty links above the first paragraph, so
  // collapse it here - the one place we know the viewport.
  var toc = document.querySelector("details.toc");
  if (toc && window.matchMedia("(max-width: 900px)").matches) toc.open = false;

  var menus = Array.prototype.slice.call(document.querySelectorAll("details.menu"));
  if (menus.length === 0) return;

  function closeAll(except) {
    menus.forEach(function (menu) {
      if (menu !== except) menu.open = false;
    });
  }

  menus.forEach(function (menu) {
    menu.addEventListener("click", function (event) {
      if (event.target.closest("a")) menu.open = false;
    });
  });

  document.addEventListener("click", function (event) {
    if (!event.target.closest("details.menu")) closeAll();
  });

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    menus.forEach(function (menu) {
      if (!menu.open) return;
      menu.open = false;
      var summary = menu.querySelector("summary");
      if (summary) summary.focus();
    });
  });
})();
