// Sitewide top navigation -- injected into every page's <div id="top-nav-root">
// instead of each page hand-maintaining its own copy of the sidebar markup.
// One file, one source of truth for the three sections: Analyze (the
// digital twin's scenario tool), Theory (how the model works), and
// Logistics (the original EV route optimizer, now at route.html/map.html).
// The brand mark on the left also links to index.html -- the site's home
// page -- and a dedicated Home icon sits in the same white nav strip,
// right after the Logistics tab, as a second, explicit way back home.
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
                <div class="top-nav-right">
                    <nav class="top-nav-links">${links}</nav>
                    <a href="index.html" class="top-nav-home-icon" title="Home">&#8962;</a>
                </div>
            </header>
        `;
    }

    // Bottom-left "Previous" box -- follows each page's actual navigation
    // flow, not a generic "go home" link (the nav strip's Home icon above
    // covers that). A page reached by drilling into a section (e.g.
    // map.html from route.html, explain.html from supply-chain.html)
    // points back to the specific page that led here. The entry page of
    // each section (supply-chain.html, how-it-works.html, route.html) has
    // nothing to go back to within its own flow, so it simply doesn't
    // include a <div id="back-link-root"> at all. Pages that do include
    // it set the destination with a data-back-href attribute, e.g.
    // <div id="back-link-root" data-back-href="route.html">.
    function injectBackLink() {
        const backRoot = document.getElementById("back-link-root");
        if (!backRoot) return;
        const dest = backRoot.dataset.backHref || "index.html";
        backRoot.innerHTML = `<a href="${dest}" class="back-link" id="back-link">&larr; Previous</a>`;
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
