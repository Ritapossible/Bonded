// Highlight the section currently in view. Plain IntersectionObserver: a docs page
// should not need a framework, and this one has no build step to hide one in.
(function () {
  "use strict";
  var links = Array.prototype.slice.call(document.querySelectorAll("#toc a"));
  var byId = {};
  links.forEach(function (link) {
    byId[link.getAttribute("href").slice(1)] = link;
  });

  var headings = links
    .map(function (link) {
      return document.getElementById(link.getAttribute("href").slice(1));
    })
    .filter(Boolean);

  if (!("IntersectionObserver" in window) || headings.length === 0) return;

  var visible = new Set();
  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      });
      // The topmost visible heading wins, so scrolling up and down agree.
      for (var i = 0; i < headings.length; i++) {
        if (visible.has(headings[i].id)) {
          links.forEach(function (l) {
            l.classList.remove("is-active");
          });
          byId[headings[i].id].classList.add("is-active");
          break;
        }
      }
    },
    { rootMargin: "-90px 0px -70% 0px" },
  );

  headings.forEach(function (heading) {
    observer.observe(heading);
  });
})();
