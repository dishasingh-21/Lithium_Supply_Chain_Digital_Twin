// Sitewide top navigation -- injected into every page's <div id="top-nav-root">
// instead of each page hand-maintaining its own copy of the sidebar markup.
// One file, one source of truth for the three sections: Analyze (the
// digital twin's scenario tool), Theory (how the model works), and
// Logistics (the original EV route optimizer, now at route.html/map.html).
// The brand mark on the left always links to index.html -- the site's
// home page -- so it doubles as the "return home" icon every page needs.
(function () {
    const PAGES = [
        { href: "supply-chain.html", label: "Analyze", match: ["supply-chain.html", "explain.html"] },
        { href: "how-it-works.html", label: "Theory", match: ["how-it-works.html"] },
        { href: "route.html", label: "Logistics", match: ["route.html", "map.html"] },
    ];
    const current = window.location.pathname.split("/").pop() || "index.html";

    function injectTopNav() {
        const root = document.getElementById("top-nav-root");
        if (!root) return;

        const links = PAGES.map((p) => {
            const active = p.match.includes(current) ? " active" : "";
            return `<a href="${p.href}" class="top-nav-link${active}">${p.label}</a>`;
        }).join("");

        root.innerHTML = `
            <header class="top-nav">
                <a href="index.html" class="top-nav-brand" title="Home">
                    <span class="top-nav-brand-mark">Li</span>
                    <span class="top-nav-brand-text">Lithium Supply Chain Digital Twin</span>
                </a>
                <nav class="top-nav-links">${links}</nav>
            </header>
        `;
    }

    // Sitewide "Previous" link -- always returns to the home page
    // (index.html), matching the wireframe's bottom-left "Previous"
    // button on every section page. A plain link, not browser-history
    // back, so it behaves the same way no matter how the person
    // actually arrived here. Any page can opt in by including an empty
    // <div id="back-link-root"> near the bottom of its content; the
    // home page itself simply doesn't include that div, since it has
    // nowhere further back to go.
    function injectBackLink() {
        const backRoot = document.getElementById("back-link-root");
        if (!backRoot) return;
        backRoot.innerHTML = `<a href="index.html" class="back-link" id="back-link">&larr; Previous</a>`;
    }

    // #top-nav-root always sits right after <body>, so it already exists
    // the moment this (non-deferred) script runs -- but #back-link-root
    // usually sits further down the page, past where the parser has
    // reached at this point, so that injection has to wait for the DOM
    // to finish. Running both on DOMContentLoaded keeps this one file
    // correct regardless of where either div is placed on the page.
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            injectTopNav();
            injectBackLink();
        });
    } else {
        injectTopNav();
        injectBackLink();
    }
})();
